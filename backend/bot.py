import os
import sys
import asyncio
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
from pipecat.adapters.schemas.tools_schema import ToolsSchema
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

SYSTEM_PROMPT = (
    "\u4f60\u662fMolly\uff0c\u548c\u7528\u6237\u662f\u597d\u670b\u53cb\uff0c\u7528\u5fae\u4fe1\u804a\u5929\u7684\u8bed\u6c14\u56de\u590d\u3002"
    "\u4e0d\u8981\u7528markdown\u683c\u5f0f\uff0c\u9664\u975e\u7528\u6237\u660e\u786e\u8981\u6c42\uff0c\u5426\u5219\u4e0d\u8981\u7528bullet points\u6216\u8005\u5217\u8868\u3002"
    "\u56de\u590d\u8981\u7b80\u77ed\u81ea\u7136\uff0c\u50cf\u597d\u670b\u53cb\u95f4\u53d1\u5fae\u4fe1\u4e00\u6837\u3002"
    "\u9002\u5f53\u7528\u4e00\u4e9bemoji\u548c\u53e3\u8bed\u5316\u8868\u8fbe\uff0c\u4f46\u4e0d\u8981\u592a\u9891\u7e41\u3002"
    "\u4f60\u53ef\u4ee5\u4f7f\u7528search_memory\u5de5\u5177\u67e5\u627e\u7528\u6237\u8fc7\u53bb\u7684\u6d3b\u52a8\u548c\u8bb0\u5fc6\u3002"
    "\u804a\u5230\u8fc7\u53bb\u7684\u4e8b\u60c5\u3001\u56de\u5fc6\u3001\u4e60\u60ef\u6216\u9700\u8981\u4e0a\u4e0b\u6587\u65f6\uff0c\u53ef\u4ee5\u5148\u8c03\u7528search_memory\u67e5\u8be2\u540e\u518d\u56de\u590d\u3002"
)


def _build_messages(past_messages: list) -> list:
    result = [{"role": "system", "content": SYSTEM_PROMPT}]
    for msg in past_messages:
        result.append({"role": msg["role"], "content": msg["content"]})
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


def make_search_memory(user_id: str, api_key: str):
    """Factory returning a search_memory callable that captures user_id + api_key
    in its closure, avoiding race conditions between concurrent sessions."""

    async def search_memory(params: FunctionCallParams, query: str):
        """Searches the user's past activity memory and context for relevant information.

        Args:
            query: The search string to look up in the memory vector database.
        """
        try:
            logger.info("Embedding query: {}", query)
            query_embedding = await _embed_query(query, api_key)

            search_results = await database.vector.search(
                query_embedding, 5, user_id=user_id
            )
            context_str = "\n".join(
                [f"[{r.get('timestamp', 'Unknown')}] {r.get('summary', '')}"
                 for r in search_results]
            )
            if not context_str.strip():
                context_str = "No recent context available yet."

            await params.result_callback(context_str)
        except Exception as e:
            await params.result_callback(f"Error searching memory: {str(e)}")

    return search_memory


class MicFilterProcessor(FrameProcessor):
    """Filters outgoing microphone audio if voice mode is inactive."""
    def __init__(self, global_state: dict):
        super().__init__()
        self._global_state = global_state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, AudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            if not self._global_state["voice_mode"]:
                return
        await self.push_frame(frame, direction)


class AudioLevelProcessor(FrameProcessor):
    """Calculates microphone audio level, sends to frontend, and gates noise when bot is speaking."""
    def __init__(self, transport: SmallWebRTCTransport, global_state: dict):
        super().__init__()
        self._transport = transport
        self._global_state = global_state
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
            if self._frame_count % 3 == 0:
                await self._transport._client.send_message(
                    OutputTransportMessageFrame(message={
                        "type": "audio_level",
                        "level": level
                    })
                )
        await self.push_frame(frame, direction)


class TTSFilterProcessor(FrameProcessor):
    """Filters outgoing TTS audio if the assistant should remain silent."""
    def __init__(self, global_state: dict):
        super().__init__()
        self._global_state = global_state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, AudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            if not self._global_state["voice_mode"] and not self._global_state["speak_text"]:
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
    global_state: dict,
    conversation_id: str,
    user_id: str,
    prefs: dict[str, str],
):
    """Initializes and starts a single WebRTC Pipecat pipeline session."""
    conv = {"id": conversation_id}
    try:
        transport = SmallWebRTCTransport(
            params=TransportParams(
                audio_in_enabled=True,
                audio_in_filter=RNNoiseFilter(),
                audio_out_enabled=True
            ),
            webrtc_connection=connection
        )

        gemini_key = prefs.get("gemini_api_key", "")
        llm = GoogleLLMService(
            api_key=gemini_key,
            settings=GoogleLLMService.Settings(model="gemini-3.1-flash-lite")
        )
        memory_tool = make_search_memory(user_id, gemini_key)
        llm.register_direct_function(memory_tool)

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
            tts_voice = prefs.get("tts_voice", "79a125e8-cd45-4c13-8a67-188112f4dd22")
            tts_volume = float(prefs.get("tts_volume", "1.0"))
            tts_speed = float(prefs.get("tts_speed", "1.0"))
            tts_emotion = prefs.get("tts_emotion")
            if not tts_emotion or tts_emotion == "neutral":
                tts_emotion = None

            generation_config = GenerationConfig(
                volume=tts_volume,
                speed=tts_speed,
                emotion=tts_emotion
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

        past_messages = await database.app.get_messages(conv["id"])
        formatted_messages = _build_messages(past_messages)

        tools = ToolsSchema(standard_tools=[memory_tool])
        context = LLMContext(messages=formatted_messages, tools=tools)
        vad_params = VADParams(
            start_secs=0.4,
            stop_secs=0.8,
            confidence=0.75,
            min_volume=0.1,
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

        mic_filter = MicFilterProcessor(global_state)
        tts_filter = TTSFilterProcessor(global_state)
        user_broadcaster = UserBroadcaster(transport, conv["id"], user_id)
        assistant_broadcaster = AssistantBroadcaster(transport, conv["id"], user_id)
        audio_level = AudioLevelProcessor(transport, global_state)

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
            if isinstance(message, dict) and message.get("type") == "chat":
                text = message.get("text")
                if text:
                    logger.info("Chat message received: {}", text)
                    await database.app.add_message(conv["id"], "user", text, user_id)
                    await task.queue_frames([
                        InterruptionFrame(),
                        LLMMessagesAppendFrame(messages=[{"role": "user", "content": text}]),
                        LLMRunFrame()
                    ])
            elif isinstance(message, dict) and message.get("type") == "switch_conversation":
                new_id = message.get("conversation_id")
                if new_id and new_id != conv["id"]:
                    logger.info("Switching conversation: {} -> {}", conv["id"], new_id)
                    conv["id"] = new_id
                    user_broadcaster.set_conversation_id(new_id)
                    assistant_broadcaster.set_conversation_id(new_id)
                    msgs = await database.app.get_messages(new_id)
                    formatted = _build_messages(msgs)
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

        runner = PipelineRunner()
        logger.info("Pipecat WebRTC Assistant running...")
        await runner.run(task)
        logger.info("Pipecat runner.run() returned")
    except asyncio.CancelledError:
        logger.info("Pipecat session cancelled.")
    except Exception as e:
        logger.exception("Pipecat task failed: {}", e)
    finally:
        logger.info("Pipecat session cleanup complete")
