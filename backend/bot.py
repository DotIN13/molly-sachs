import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo
import numpy as np
from loguru import logger

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.pipeline.runner import PipelineRunner
from pipecat.services.google.llm import GoogleLLMService
from pipecat.services.soniox.stt import SonioxSTTService
from pipecat.services.cartesia.stt import CartesiaSTTService
from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig
from pipecat.services.llm_service import FunctionCallParams

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.audio.filters.rnnoise_filter import RNNoiseFilter

from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_start.vad_user_turn_start_strategy import VADUserTurnStartStrategy
from pipecat.frames.frames import (
    TextFrame,
    AudioRawFrame,
    Frame,
    TranscriptionFrame,
    LLMFullResponseStartFrame,
    LLMFullResponseEndFrame,
    LLMMessagesAppendFrame,
    LLMMessagesUpdateFrame,
    LLMRunFrame,
    OutputTransportMessageFrame,
    InterruptionFrame,
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame
)

from google import genai
import database
from db.settings import Settings

SYSTEM_PROMPT = (
    '你是Molly，和用户是好朋友，用微信聊天的语气回复。'
    '不要用markdown格式，除非用户明确要求或者确实需要markdown来解释代码、表格、数学证明等，否则不要用bullet points或者列表。'
    '回复要简短自然，像好朋友间发微信一样。适当使用口语化表达，不要频繁使用emoji。不要总是追问用户细节，不要过度延伸。'
    '你可以使用search_memory工具查找用户过去的活动和记忆。聊到过去的事情、回忆、习惯或需要context时，可以先调用search_memory查询后再回复。'
    '你可以使用add_memory工具来记住用户透露的关于自己的任何信息。每当用户说了关于自己的新事实，可以使用add_memory来记录。'
    '比如用户说"我最近在学Python"→ category="skill"；用户说"我喜欢用VSCode"→ category="preference"；'
    '用户说"我对机器学习很感兴趣"→ category="interest"；用户说"我想学炒股"、"我想减肥"、"我打算考驾照"→ category="goal"；'
    '用户说"我是社恐"→ category="trait"；用户说"我在腾讯工作"→ category="relationship"；'
    '用户说"我有一个GitHub项目叫xxx"→ category="ownership"；用户说"我总是拖延"→ category="weakness"。'
)

# Settings that require tearing down and rebuilding the pipeline
_RESTART_KEYS = {
    "gemini_api_key", "cartesia_api_key", "soniox_api_key",
    "stt_provider", "stt_language",
    "tts_provider", "tts_voice", "tts_volume", "tts_speed", "tts_emotion", "tts_language",
}


@dataclass
class SessionState:
    """Mutable state for a single WebRTC pipeline session.  Processors hold a
    reference to this object so that live toggles (voice_mode, speak_text) are
    visible without restarting the pipeline."""
    conversation_id: str
    user_id: str
    voice_mode: bool = False
    prefs: dict = field(default_factory=dict)

    @classmethod
    async def create(cls, user_id: str, conversation_id: str) -> "SessionState":
        from db.settings import Settings
        prefs = await Settings(user_id).load()
        return cls(conversation_id=conversation_id, user_id=user_id, prefs=prefs)


class PipelineRestartRequested(Exception):
    """Raised when session_state_updated changes a setting that requires
    rebuilding the pipeline (API keys, STT/TTS provider, etc.)."""

    def __init__(self, changes: dict):
        super().__init__(f"Pipeline restart required for: {list(changes.keys())}")
        self.changes = changes


def _build_messages(past_messages: list, timezone: str | None = None) -> list:
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S %A")
    if timezone:
        try:
            tz = ZoneInfo(timezone)
            now_str = datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S %A")
        except Exception:
            pass
    system_with_time = f"{SYSTEM_PROMPT}现在用户那边的设备时间是{now_str}，回复的时候注意事情时间关系。"
    result = [{"role": "system", "content": system_with_time}]
    for msg in past_messages:
        role = "assistant" if msg["role"] == "tip" else msg["role"]
        result.append({"role": role, "content": msg["content"]})
    return result


async def _embed_query(query: str, api_key: str) -> list:
    client = genai.Client(api_key=api_key) if api_key else genai.Client()
    embed_result = await asyncio.wait_for(
        client.aio.models.embed_content(
            model='gemini-embedding-2',
            contents=query,
        ), timeout=30
    )
    return embed_result.embeddings[0].values


def make_search_memory(user_id: str, api_key: str, send_fn=None):
    """Factory returning a search_memory callable that captures user_id + api_key
    (and optional send_fn for tool-activity notifications) in its closure,
    avoiding race conditions between concurrent sessions."""

    async def search_memory(params: FunctionCallParams, query: str):
        """Search the user's long-term memory for relevant information.

        The memory stores categorized facts about the user: traits (personality),
        preferences (tools, workflows, habits), interests (topics they care about),
        skills (technical abilities), goals (learning or achievement targets),
        relationships (workplaces, teams, people), ownerships (projects, assets),
        weaknesses (areas for improvement), and events (past activities).

        Use this when the user asks about their past, mentions something you should
        recall context for, or when you need background before giving advice.

        Args:
            query: A natural-language search string to find semantically similar memories.
        """
        try:
            if send_fn:
                await send_fn({"type": "thinking", "action": "searching_memory", "detail": query[:80]})
            logger.info("Embedding query: {}", query)
            query_embedding = await _embed_query(query, api_key)

            event_results, persona_results = await asyncio.gather(
                database.vector.search(query_embedding, 3, user_id=user_id, item_type="event"),
                database.vector.search(query_embedding, 5, user_id=user_id, exclude_type="event"),
            )

            all_results = event_results + persona_results
            seen = set()
            unique = []
            for r in all_results:
                rid = r.get("id", "")
                if rid and rid not in seen:
                    seen.add(rid)
                    unique.append(r)

            unique.sort(key=lambda r: 0 if r.get("type") == "event" else 1)

            search_lines = [f"search-memory \"{query[:100]}\" → {len(unique)} results"]
            for r in unique:
                search_lines.append(
                    f"  [{r.get('type','?')}] \"{r.get('content','')[:70]}\""
                )
            logger.info("\n".join(search_lines))

            context_str = "\n".join(
                [f"[{r.get('type', 'summary')} | {r.get('timestamp', '')}] {r.get('content', r.get('summary', ''))}"
                 for r in unique]
            )
            if not context_str.strip():
                context_str = "No recent context available yet."

            await params.result_callback(context_str)
        except Exception as e:
            await params.result_callback(f"Error searching memory: {str(e)}")
        finally:
            if send_fn:
                await send_fn({"type": "thinking_done"})

    return search_memory


_VALID_MEMORY_CATEGORIES = [
    "trait", "preference", "interest", "skill", "goal",
    "relationship", "ownership", "weakness", "event", "other",
]
_MERGE_THRESHOLD = float(os.environ.get("MOLLY_MERGE_THRESHOLD", "0.85"))
_MAX_EVIDENCE_ENTRIES = 10


def make_add_memory(user_id: str, api_key: str, send_fn=None):
    """Factory returning an add_memory callable that embeds and stores facts about the user."""

    async def add_memory(params: FunctionCallParams, fact: str, category: str,
                         confidence: int = 5, lifespan: int = 5):
        """Add an inferred fact about the user to their long-term memory.

        Use this whenever the user reveals something about themselves. Be proactive — better to record than forget.
        Category mapping examples:
        - trait: "I'm an introvert", "I'm very detail-oriented"
        - preference: "I prefer dark mode", "I like working late at night"
        - interest: "I'm really into machine learning", "I love indie games"
        - skill: "I've been learning React", "I can speak Japanese"
        - goal: "I want to learn stock trading", "I'm trying to lose weight", "I plan to get a driver's license"
        - relationship: "I work at Tencent", "I'm on the backend team"
        - ownership: "I have a project called MyApp", "I run a blog"
        - weakness: "I procrastinate a lot", "I'm bad at time management"
        - event: "I just finished a marathon today"

        Args:
            fact: A concise sentence describing what was learned.
            category: The type of fact. One of: trait, preference, interest, skill, goal, relationship, ownership, weakness, event, other.
            confidence: How certain you are (1-10). Use 5+ for clear statements, lower for vague hints.
            lifespan: How long this stays relevant. 1 = short-lived, 10 = long-lasting insight.
        """
        try:
            if send_fn:
                await send_fn({"type": "thinking", "action": "storing_memory", "detail": fact[:80]})

            if category not in _VALID_MEMORY_CATEGORIES:
                await params.result_callback(
                    f"Invalid category '{category}'. Must be: {', '.join(_VALID_MEMORY_CATEGORIES)}"
                )
                return

            confidence = max(1, min(10, int(confidence)))
            lifespan = max(1, min(10, int(lifespan)))
            ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

            embedding = await _embed_query(f"{category}: {fact}", api_key)

            new_evidence = json.dumps(
                [{"text": "inferred from conversation", "timestamp": ts}],
                ensure_ascii=False,
            )

            if category == "event":
                existing = None
                sim = 0.0
                candidates = []
            else:
                existing, sim, candidates = await database.vector.find_similar(
                    embedding, category, user_id, _MERGE_THRESHOLD
                )

            target = f"{category}: {fact}"
            lines = [f"[{category}] \"{target[:80]}\""]
            if candidates:
                lines.append(f"  threshold={_MERGE_THRESHOLD}")
                for c, s in candidates:
                    mark = "  ✓" if (existing and c.get("id") == existing.get("id")) else "   "
                    lines.append(f"  {s:.2f}{mark} \"{c.get('content','')[:70]}\"")
            if existing:
                lines.append(f"  → merged into \"{existing.get('content','')[:70]}\"")
            else:
                lines.append(f"  → no match (best={sim:.2f})")
            logger.info("\n".join(lines))

            if existing:
                existing_evidence = existing.get("evidence", "")
                try:
                    evidence_list = json.loads(existing_evidence) if isinstance(existing_evidence, str) else []
                    if not isinstance(evidence_list, list):
                        evidence_list = [{"text": str(existing_evidence), "timestamp": ""}]
                except (json.JSONDecodeError, TypeError):
                    evidence_list = [{"text": str(existing_evidence), "timestamp": ""}]

                new_entries = json.loads(new_evidence)
                evidence_list = evidence_list + new_entries
                if len(evidence_list) > _MAX_EVIDENCE_ENTRIES:
                    evidence_list = evidence_list[-_MAX_EVIDENCE_ENTRIES:]

                merged = {
                    "type": category,
                    "content": f"{category}: {fact}",
                    "timestamp": existing.get("timestamp", ts),
                    "user_id": user_id,
                    "user_event_id": existing.get("user_event_id", "0"),
                    "confidence": max(confidence, existing.get("confidence", 0)),
                    "evidence": json.dumps(evidence_list, ensure_ascii=False),
                    "lifespan": max(lifespan, existing.get("lifespan", 0)),
                }
                await database.vector.update_metadata(existing["id"], merged)
                logger.info("Memory merged [{} c:{} sim:{:.2f}]: {}", category, confidence, sim, fact[:100])
                await params.result_callback(f"Merged with existing [{category}]: {fact}")
            else:
                mem_id = f"mem_{uuid.uuid4().hex[:12]}"
                await database.vector.add([{
                    "id": mem_id,
                    "vector": embedding,
                    "metadata": {
                        "type": category,
                        "content": f"{category}: {fact}",
                        "timestamp": ts,
                        "user_id": user_id,
                        "user_event_id": "0",
                        "confidence": confidence,
                        "evidence": new_evidence,
                        "lifespan": lifespan,
                    },
                }])
                logger.info("Memory added [{} c:{}]: {}", category, confidence, fact[:100])
                await params.result_callback(f"Remembered: [{category}] {fact}")
        except Exception as e:
            logger.error("Error adding memory: {}", e)
            await params.result_callback(f"Failed to store memory: {str(e)}")
        finally:
            if send_fn:
                await send_fn({"type": "thinking_done"})

    return add_memory


class MicFilterProcessor(FrameProcessor):
    """Filters outgoing microphone audio if voice mode is inactive."""
    def __init__(self, session: SessionState):
        super().__init__()
        self._session = session

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, AudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            if not self._session.voice_mode:
                return
        await self.push_frame(frame, direction)


class AudioLevelProcessor(FrameProcessor):
    """Calculates microphone audio level, sends to frontend (~10 msg/sec), and gates noise when bot is speaking."""
    def __init__(self, transport: SmallWebRTCTransport):
        super().__init__()
        self._transport = transport
        self._frame_count = 0
        self._bot_speaking = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
        elif isinstance(frame, AudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            self._frame_count += 1
            audio = frame.audio
            level = 0.0
            if audio is not None and len(audio) > 0:
                samples = np.frombuffer(audio, dtype=np.int16).astype(np.float64)
                rms = float(np.sqrt(np.mean(np.square(samples))))
                level = min(1.0, rms / 8000.0)
            if self._frame_count % 10 == 0:
                await self._transport._client.send_message(
                    OutputTransportMessageFrame(message={
                        "type": "audio_level",
                        "level": level
                    })
                )
        await self.push_frame(frame, direction)


class TTSFilterProcessor(FrameProcessor):
    """Filters outgoing TTS audio if the assistant should remain silent."""
    def __init__(self, session: SessionState):
        super().__init__()
        self._session = session

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, AudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            if not self._session.voice_mode and self._session.prefs.get("speak_text", "true") != "true":
                return
        await self.push_frame(frame, direction)


class UserBroadcaster(FrameProcessor):
    """Intercepts and broadcasts user voice transcriptions to the frontend instantly."""
    def __init__(self, transport: SmallWebRTCTransport, conversation_id: str,
                 user_id: str):
        super().__init__()
        self._transport = transport
        self._conversation_id = conversation_id
        self._user_id = user_id

    def set_conversation_id(self, cid: str):
        self._conversation_id = cid

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, TranscriptionFrame):
                if not getattr(frame, "interim_results", False):
                    await database.app.add_message(
                        self._conversation_id, "user", frame.text, self._user_id
                    )
                    await self._transport._client.send_message(
                        OutputTransportMessageFrame(message={
                            "type": "transcript",
                            "text": frame.text,
                            "user": frame.user_id
                        })
                    )
        await self.push_frame(frame, direction)


class AssistantBroadcaster(FrameProcessor):
    """Intercepts and broadcasts assistant response text chunks to the frontend instantly."""
    def __init__(self, transport: SmallWebRTCTransport, conversation_id: str,
                 user_id: str):
        super().__init__()
        self._transport = transport
        self._conversation_id = conversation_id
        self._user_id = user_id
        self._buffer = []

    def set_conversation_id(self, cid: str):
        self._conversation_id = cid

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, LLMFullResponseStartFrame):
                self._buffer = []
                await self._transport._client.send_message(
                    OutputTransportMessageFrame(message={"type": "start"}))
            elif isinstance(frame, TextFrame) and not isinstance(frame, TranscriptionFrame):
                self._buffer.append(frame.text)
                await self._transport._client.send_message(
                    OutputTransportMessageFrame(message={"type": "chunk", "text": frame.text}))
            elif isinstance(frame, LLMFullResponseEndFrame):
                full_text = "".join(self._buffer)
                if full_text.strip():
                    await database.app.add_message(
                        self._conversation_id, "assistant", full_text, self._user_id
                    )
                await self._transport._client.send_message(
                    OutputTransportMessageFrame(message={"type": "end"}))
        await self.push_frame(frame, direction)


async def start_pipecat_session(
    connection: SmallWebRTCConnection,
    session: SessionState,
):
    """Initializes and starts a single WebRTC Pipecat pipeline session."""
    conv_id = session.conversation_id
    user_id = session.user_id
    prefs = session.prefs
    try:
        transport = SmallWebRTCTransport(
            params=TransportParams(
                audio_in_enabled=True,
                audio_in_filter=RNNoiseFilter(),
                audio_out_enabled=True
            ),
            webrtc_connection=connection
        )

        @transport.event_handler("on_app_message")
        async def _early_session_state(transport, message, sender):
            if isinstance(message, dict) and message.get("type") == "session_state_updated":
                changes = message.get("changes", {})
                if not isinstance(changes, dict):
                    return
                if "voice_mode" in changes:
                    session.voice_mode = bool(changes["voice_mode"])
                if "speak_text" in changes:
                    session.prefs["speak_text"] = "true" if changes["speak_text"] else "false"

        gemini_key = prefs.get("gemini_api_key", "")
        llm = GoogleLLMService(
            api_key=gemini_key,
            settings=GoogleLLMService.Settings(model="gemini-3.1-flash-lite")
        )
        memory_tool = make_search_memory(
            user_id, gemini_key,
            send_fn=lambda msg: transport._client.send_message(
                OutputTransportMessageFrame(message=msg)
            )
        )
        add_memory_tool = make_add_memory(user_id, gemini_key,
            send_fn=lambda msg: transport._client.send_message(
                OutputTransportMessageFrame(message=msg)
            )
        )
        stt_provider = prefs.get("stt_provider", "soniox")
        stt_language = prefs.get("stt_language", "zh")
        if stt_provider == "cartesia":
            stt = CartesiaSTTService(
                api_key=prefs.get("cartesia_api_key"),
                settings=CartesiaSTTService.Settings(
                    model="ink-whisper",
                    language=stt_language,
                ),
            )
        else:
            stt = SonioxSTTService(
                api_key=prefs.get("soniox_api_key"),
                settings=SonioxSTTService.Settings(
                    language=stt_language,
                ),
            )

        tts_provider = prefs.get("tts_provider", "cartesia")
        if tts_provider == "cartesia":
            tts_voice = prefs.get("tts_voice", "6eb8965c-e295-47bd-a9e4-3eeebb3abcff")
            tts_volume = float(prefs.get("tts_volume", "1.0"))
            tts_speed = float(prefs.get("tts_speed", "1.0"))
            tts_emotion = prefs.get("tts_emotion")
            if not tts_emotion or tts_emotion == "neutral":
                tts_emotion = None
            generation_config = GenerationConfig(
                volume=tts_volume, speed=tts_speed, emotion=tts_emotion
            )
            tts_language = prefs.get("tts_language", "en")
            tts = CartesiaTTSService(
                api_key=prefs.get("cartesia_api_key"),
                settings=CartesiaTTSService.Settings(
                    model="sonic-3.5",
                    voice=tts_voice,
                    language=tts_language,
                    generation_config=generation_config
                )
            )

        past_messages = await database.app.get_messages(conv_id, user_id)
        formatted_messages = _build_messages(past_messages, prefs.get("timezone"))

        context = LLMContext(messages=formatted_messages, tools=[memory_tool, add_memory_tool])
        vad_params = VADParams(
            start_secs=0.2, stop_secs=0.8, confidence=0.75, min_volume=0.1,
        )
        user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(
                vad_analyzer=SileroVADAnalyzer(params=vad_params),
                user_turn_strategies=UserTurnStrategies(
                    start=[VADUserTurnStartStrategy()],
                ),
            ),
        )

        mic_filter = MicFilterProcessor(session)
        tts_filter = TTSFilterProcessor(session)
        user_broadcaster = UserBroadcaster(transport, conv_id, user_id)
        assistant_broadcaster = AssistantBroadcaster(transport, conv_id, user_id)
        audio_level = AudioLevelProcessor(transport)

        pipeline = Pipeline([
            transport.input(),
            audio_level,
            mic_filter,
            stt,
            user_broadcaster,
            user_aggregator,
            llm,
            assistant_broadcaster,
            tts,
            tts_filter,
            transport.output(),
            assistant_aggregator,
        ])

        task = PipelineTask(
            pipeline,
            params=PipelineParams(
                allow_interruptions=True,
                enable_metrics=True,
                enable_usage_metrics=True,
            )
        )

        @transport.event_handler("on_client_connected")
        async def on_client_connected(transport, client):
            logger.info("Client connected to WebRTC")

        @transport.event_handler("on_client_disconnected")
        async def on_client_disconnected(transport, client):
            logger.info("Client disconnected from WebRTC — cancelling pipeline task")
            await task.cancel()
            logger.info("Pipeline task cancelled after client disconnect")

        @transport.event_handler("on_app_message")
        async def on_app_message(transport, message, sender):
            nonlocal conv_id
            if isinstance(message, dict) and message.get("type") == "chat":
                text = message.get("text")
                if text:
                    logger.info("Chat message received: {}", text)
                    await database.app.add_message(conv_id, "user", text, user_id)
                    await task.queue_frames([
                        InterruptionFrame(),
                        LLMMessagesAppendFrame(messages=[{"role": "user", "content": text}]),
                        LLMRunFrame()
                    ])
            elif isinstance(message, dict) and message.get("type") == "switch_conversation":
                new_id = message.get("conversation_id")
                if new_id and new_id != conv_id:
                    if not await database.app.verify_conversation_owner(new_id, user_id):
                        logger.warning("Switch conversation denied: user {} does not own {}", user_id[:8], new_id)
                        return
                    logger.info("Switching conversation: {} -> {}", conv_id, new_id)
                    conv_id = new_id
                    session.conversation_id = new_id
                    user_broadcaster.set_conversation_id(new_id)
                    assistant_broadcaster.set_conversation_id(new_id)
                    msgs = await database.app.get_messages(new_id, user_id)
                    formatted = _build_messages(msgs, session.prefs.get("timezone"))
                    await task.queue_frames([
                        InterruptionFrame(),
                        LLMMessagesUpdateFrame(messages=formatted, run_llm=False),
                    ])
                    await transport._client.send_message(
                        OutputTransportMessageFrame(message={
                            "type": "messages",
                            "messages": [{"role": m["role"], "content": m["content"]} for m in msgs]
                        })
                    )
            elif isinstance(message, dict) and message.get("type") == "session_state_updated":
                changes = message.get("changes", {})
                if not isinstance(changes, dict):
                    return

                restart_keys = _RESTART_KEYS & set(changes.keys())
                if restart_keys:
                    session.prefs.update(changes)
                    raise PipelineRestartRequested(changes)

                if "timezone" in changes:
                    session.prefs["timezone"] = str(changes["timezone"])
                    msgs = await database.app.get_messages(conv_id, user_id)
                    formatted = _build_messages(msgs, session.prefs.get("timezone"))
                    await task.queue_frames([
                        LLMMessagesUpdateFrame(messages=formatted, run_llm=False),
                    ])

                logger.info("Session state updated: {}", {k: v for k, v in changes.items()
                            if k not in _RESTART_KEYS})

        runner = PipelineRunner()
        logger.info("Pipecat WebRTC Assistant running...")
        await runner.run(task)
        logger.info("Pipecat runner.run() returned")
    except PipelineRestartRequested:
        raise
    except asyncio.CancelledError:
        logger.info("Pipecat session cancelled.")
    except Exception as e:
        logger.exception("Pipecat task failed: {}", e)
    finally:
        logger.info("Pipecat session cleanup complete")
