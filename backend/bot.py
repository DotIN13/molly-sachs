import os
import sys
import asyncio
import numpy as np
from loguru import logger

# Pipecat core and services
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.pipeline.runner import PipelineRunner
from pipecat.services.google.llm import GoogleLLMService
from pipecat.services.soniox.stt import SonioxSTTService
from pipecat.services.cartesia.stt import CartesiaSTTService
from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig
from pipecat.services.llm_service import FunctionCallParams

# Pipecat VAD and transport
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.audio.filters.rnnoise_filter import RNNoiseFilter

# Pipecat processors and frames
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

# Gemini SDK
from google import genai
import database

def _embed_query(query: str) -> list:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    client = genai.Client(api_key=api_key) if api_key else genai.Client()
    embed_result = client.models.embed_content(
        model='gemini-embedding-2',
        contents=query,
    )
    return embed_result.embeddings[0].values

async def search_memory(params: FunctionCallParams, query: str):
    """Searches the user's past activity memory and context for relevant information.
    
    Args:
        query: The search string to look up in the memory vector database.
    """
    try:
        query_embedding = await asyncio.to_thread(_embed_query, query)
        
        search_results = await asyncio.to_thread(database.search_events, query_embedding, 5)
        context_str = "\n".join([f"[{r.get('timestamp', 'Unknown')}] {r.get('summary', '')}" for r in search_results])
        if not context_str.strip():
            context_str = "No recent context available yet."
            
        await params.result_callback(context_str)
    except Exception as e:
        await params.result_callback(f"Error searching memory: {str(e)}")

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
                import numpy as np
                samples = np.frombuffer(audio, dtype=np.int16).astype(np.float64)
                rms = float(np.sqrt(np.mean(np.square(samples))))
                level = min(1.0, rms / 32768.0)
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
    def __init__(self, transport: SmallWebRTCTransport, conversation_id: str):
        super().__init__()
        self._transport = transport
        self._conversation_id = conversation_id

    def set_conversation_id(self, cid: str):
        self._conversation_id = cid

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, TranscriptionFrame):
                if not getattr(frame, "interim_results", False):
                    database.add_message(self._conversation_id, "user", frame.text)
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
    def __init__(self, transport: SmallWebRTCTransport, conversation_id: str):
        super().__init__()
        self._transport = transport
        self._conversation_id = conversation_id
        self._buffer = []

    def set_conversation_id(self, cid: str):
        self._conversation_id = cid

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, LLMFullResponseStartFrame):
                self._buffer = []
                await self._transport._client.send_message(OutputTransportMessageFrame(message={"type": "start"}))
            elif isinstance(frame, TextFrame) and not isinstance(frame, TranscriptionFrame):
                self._buffer.append(frame.text)
                await self._transport._client.send_message(OutputTransportMessageFrame(message={"type": "chunk", "text": frame.text}))
            elif isinstance(frame, LLMFullResponseEndFrame):
                full_text = "".join(self._buffer)
                if full_text.strip():
                    database.add_message(self._conversation_id, "assistant", full_text)
                await self._transport._client.send_message(OutputTransportMessageFrame(message={"type": "end"}))
        await self.push_frame(frame, direction)

async def start_pipecat_session(connection: SmallWebRTCConnection, global_state: dict, conversation_id: str):
    """Initializes and starts a single WebRTC Pipecat pipeline session."""
    conv = {"id": conversation_id}  # mutable ref for session reuse
    try:
        transport = SmallWebRTCTransport(
            params=TransportParams(
                audio_in_enabled=True,
                audio_in_filter=RNNoiseFilter(),
                audio_out_enabled=True
            ),
            webrtc_connection=connection
        )
        
        llm = GoogleLLMService(
            api_key=os.environ.get("GEMINI_API_KEY"),
            settings=GoogleLLMService.Settings(model="gemini-3.1-flash-lite")
        )
        llm.register_direct_function(search_memory, cancel_on_interruption=False)
        
        stt_provider = os.environ.get("STT_PROVIDER", "soniox")
        stt_language = os.environ.get("STT_LANGUAGE", "zh")
        if stt_provider == "cartesia":
            stt = CartesiaSTTService(
                api_key=os.environ.get("CARTESIA_API_KEY"),
                settings=CartesiaSTTService.Settings(
                    model="ink-whisper",
                    language=stt_language,
                ),
            )
        else:
            stt = SonioxSTTService(
                api_key=os.environ.get("SONIOX_API_KEY"),
                settings=SonioxSTTService.Settings(
                    language=stt_language,
                ),
            )
        
        tts_voice = os.environ.get("CARTESIA_VOICE", "79a125e8-cd45-4c13-8a67-188112f4dd22")
        tts_volume = float(os.environ.get("CARTESIA_VOLUME", "1.0"))
        tts_speed = float(os.environ.get("CARTESIA_SPEED", "1.0"))
        tts_emotion = os.environ.get("CARTESIA_EMOTION")
        if not tts_emotion or tts_emotion == "neutral":
            tts_emotion = None
            
        generation_config = GenerationConfig(
            volume=tts_volume,
            speed=tts_speed,
            emotion=tts_emotion
        )
        
        tts_language = os.environ.get("CARTESIA_TTS_LANGUAGE", "en")
        tts = CartesiaTTSService(
            api_key=os.environ.get("CARTESIA_API_KEY"),
            settings=CartesiaTTSService.Settings(
                model="sonic-3.5",
                voice=tts_voice,
                language=tts_language,
                generation_config=generation_config
            )
        )

        # Retrieve past conversation messages
        past_messages = database.get_messages(conv["id"])
        # Convert past messages to Pipecat format
        formatted_messages = [{
            "role": "system",
            "content": (
                "你是Molly，和用户是好朋友，用微信聊天的语气回复。"
                "不要用markdown格式，除非用户明确要求，否则不要用bullet points或者列表。"
                "回复要简短自然，像好朋友间发微信一样。"
                "适当用一些emoji和口语化表达，但不要太频繁。"
            )
        }]
        for msg in past_messages:
            formatted_messages.append({"role": msg["role"], "content": msg["content"]})

        tools = ToolsSchema(standard_tools=[search_memory])
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
        user_broadcaster = UserBroadcaster(transport, conv["id"])
        assistant_broadcaster = AssistantBroadcaster(transport, conv["id"])
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
                    logger.info(f"Chat message received: {text}")
                    database.add_message(conv["id"], "user", text)
                    await task.queue_frames([
                        InterruptionFrame(),
                        LLMMessagesAppendFrame(messages=[{"role": "user", "content": text}]),
                        LLMRunFrame()
                    ])
            elif isinstance(message, dict) and message.get("type") == "switch_conversation":
                new_id = message.get("conversation_id")
                if new_id and new_id != conv["id"]:
                    logger.info(f"Switching conversation: {conv['id']} -> {new_id}")
                    conv["id"] = new_id
                    user_broadcaster.set_conversation_id(new_id)
                    assistant_broadcaster.set_conversation_id(new_id)
                    msgs = database.get_messages(new_id)
                    formatted = [{
                        "role": "system",
                        "content": (
                            "你是Molly，和用户是好朋友，用微信聊天的语气回复。"
                            "不要用markdown格式，除非用户明确要求，否则不要用bullet points或者列表。"
                            "回复要简短自然，像朋友间发微信一样。"
                            "适当用一些emoji和口语化表达，但不要太频繁。"
                        )
                    }]
                    for m in msgs:
                        formatted.append({"role": m["role"], "content": m["content"]})
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
        logger.exception(f"Pipecat task failed: {e}")
    finally:
        logger.info("Pipecat session cleanup complete")
