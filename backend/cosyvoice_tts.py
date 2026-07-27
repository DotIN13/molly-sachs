"""Aliyun CosyVoice TTS for the Pipecat pipeline.

CosyVoice is WebSocket-only — there is no HTTP REST endpoint — and Alibaba ships
a Python SDK that owns the connection, the run-task/continue-task/finish-task
protocol, and reconnection. This service wraps that SDK rather than reimplementing
the protocol, so the work here is bridging its threaded callbacks onto asyncio.

Model families, as of 2026-07:

* ``cosyvoice-v3.5-flash`` / ``cosyvoice-v3.5-plus`` — newest, **Beijing only**,
  and they carry **no system voices**: ``voice`` must be an id you obtained from
  voice cloning or voice design. Pointing one at a system voice name fails at
  synthesis time, not at construction.
* ``cosyvoice-v3-flash`` / ``cosyvoice-v3-plus`` — system voices (e.g.
  ``longanyang``) plus cloning. Use these to get sound out without cloning first.
* ``cosyvoice-v2`` — previous generation, voices suffixed ``_v2``.

The default endpoint the SDK ships with is Beijing
(``wss://dashscope.aliyuncs.com/api-ws/v1/inference``); ``base_url`` overrides it
for the Singapore region, which cannot serve v3.5.
"""

import asyncio
import re
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass

from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService

# The pipeline runs at 24 kHz, and CosyVoice can emit exactly that, so no
# resampling sits between the model and the transport.
COSYVOICE_SAMPLE_RATE = 24000

DEFAULT_MODEL = "cosyvoice-v3.5-flash"

# Holds references to the fire-and-forget cancels below, so they aren't garbage
# collected mid-flight (see asyncio.create_task docs).
_CANCEL_TASKS: set[asyncio.Task] = set()

# Models that only accept a cloned or designed voice id.
_NO_SYSTEM_VOICE_MODELS = ("cosyvoice-v3.5",)

# A cloned voice id is `<target_model>-<prefix>-<32 hex>`, e.g.
# `cosyvoice-v3-plus-xianzhe-6b7400bd3e3f4a6bab9a0b817872d167`. The trailing
# uuid is what makes the split unambiguous — without that anchor the model and
# the prefix cannot be told apart, since both are lowercase-alphanumeric runs.
_CLONED_VOICE_RE = re.compile(
    r"^(?P<model>cosyvoice-[a-z0-9.\-]+?)-(?P<prefix>[a-z0-9]{1,9})-[0-9a-f]{32}$"
)


def model_needs_custom_voice(model: str) -> bool:
    """True when *model* rejects system voice names (the v3.5 family)."""
    return any(model.startswith(p) for p in _NO_SYSTEM_VOICE_MODELS)


def model_for_voice(voice: str) -> str | None:
    """The model a cloned voice was enrolled against, read off its own id.

    A cloned voice is bound to the model it was created for and is rejected by
    every other one — including a *newer* one, so a v3-plus voice cannot be
    carried forward to v3.5-plus. Returns None for a system voice name, which
    carries no such binding.
    """
    m = _CLONED_VOICE_RE.match(voice or "")
    return m.group("model") if m else None


@dataclass
class CosyVoiceTTSSettings(TTSSettings):
    """Runtime-updatable settings for :class:`CosyVoiceTTSService`."""

    pass


class CosyVoiceTTSService(TTSService):
    """Speak text through Aliyun Model Studio's CosyVoice.

    Args:
        api_key: DashScope API key.
        model: A ``cosyvoice-*`` model id. See the module docstring — the v3.5
            family requires a cloned/designed ``voice``.
        voice: System voice name, or a cloned/designed voice id.
        speech_rate: 0.5–2.0, 1.0 is normal.
        volume: 0–100, 50 is normal.
        pitch_rate: 0.5–2.0, 1.0 is normal.
        base_url: Overrides the SDK's default Beijing WebSocket endpoint.
    """

    def __init__(
        self,
        *,
        api_key: str,
        model: str = DEFAULT_MODEL,
        voice: str,
        speech_rate: float = 1.0,
        volume: int = 50,
        pitch_rate: float = 1.0,
        base_url: str | None = None,
        sample_rate: int | None = None,
        **kwargs,
    ):
        # A cloned voice outranks the chosen model. It only ever works on the
        # model it was enrolled against, whereas the model has other voices it
        # could speak with — so on a mismatch the voice is the constraint and
        # the model is the thing to bend. Left alone, this combination fails
        # deep inside synthesis as an opaque "Engine return error code: 418".
        enrolled = model_for_voice(voice)
        if enrolled and enrolled != model:
            logger.warning(
                "CosyVoice: voice {} was cloned for {}, not the selected {} — "
                "using {}, since the voice cannot speak on anything else",
                voice, enrolled, model, enrolled,
            )
            model = enrolled
        elif not enrolled and model_needs_custom_voice(model):
            logger.warning(
                "CosyVoice: {} has no system voices, but {!r} is not a cloned "
                "voice id — synthesis will fail until a cloned voice is chosen",
                model, voice,
            )

        super().__init__(
            sample_rate=sample_rate,
            settings=CosyVoiceTTSSettings(model=model, voice=voice, language=None),
            **kwargs,
        )
        self._api_key = api_key
        self._model = model
        self._voice = voice
        self._speech_rate = speech_rate
        self._volume = volume
        self._pitch_rate = pitch_rate
        self._base_url = base_url
        # Set per synthesis so an interruption can cancel the in-flight task.
        self._synthesizer = None
        # The reused connection. One per service instance — see _prepare().
        self._session = None
        self._reuse = True

    def can_generate_metrics(self) -> bool:
        """This service reports TTFB and usage metrics."""
        return True

    async def start(self, frame):
        """Open the WebSocket before the first thing she says needs it."""
        await super().start(frame)
        try:
            await asyncio.to_thread(self._prepare, None)
            logger.debug(f"{self}: CosyVoice connection pre-warmed")
        except Exception as e:
            # Not fatal — _prepare runs again per utterance and will retry.
            logger.warning(f"{self}: CosyVoice pre-warm failed: {e}")

    def _prepare(self, callback):
        """Return a connected synthesizer, armed for one task. Blocking.

        DashScope models one synthesis as one task, and the SDK opens the
        socket lazily inside the first ``streaming_call`` — so a synthesizer
        per utterance means a WebSocket handshake per sentence, measured at
        1.6–3.0s here and heard as a gap in front of every sentence. The
        protocol explicitly allows many sequential tasks on one connection, and
        the SDK reaches that by resetting a synthesizer and handing it a fresh
        task id rather than by exposing an API for it: ``__reset`` clears the
        task state but leaves ``self.ws`` alone, ``__update_params`` builds a
        new request (new task id), and ``__start_stream`` only dials when
        ``self.ws is None``. Those private calls are how the SDK's own
        ``SpeechSynthesizerObjectPool`` does it.

        That pool is not used here because it is a process-wide singleton whose
        connections are authenticated with whichever user's key was global when
        they were dialled — fine for one-user scripts, a cross-account mix-up in
        a backend where every user brings their own key. One session per service
        instance is one per user, which is the boundary that matters.
        """
        import dashscope
        from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer

        dashscope.api_key = self._api_key   # read by __update_params below
        fmt = AudioFormat.PCM_24000HZ_MONO_16BIT

        synth = self._session
        if synth is not None and self._reuse:
            try:
                if synth._SpeechSynthesizer__is_connected():
                    synth._SpeechSynthesizer__reset()
                    synth._SpeechSynthesizer__update_params(
                        model=self._model, voice=self._voice, format=fmt,
                        volume=self._volume, speech_rate=self._speech_rate,
                        pitch_rate=self._pitch_rate, callback=callback,
                        url=self._base_url, close_ws_after_use=False,
                    )
                    return synth
            except AttributeError:
                # A future SDK could rename these. Fall back to a fresh
                # connection per utterance rather than failing to speak.
                logger.warning(f"{self}: SDK internals changed; connection reuse off")
                self._reuse = False
            self._session = None

        synth = SpeechSynthesizer(
            model=self._model,
            voice=self._voice,
            format=fmt,
            speech_rate=self._speech_rate,
            pitch_rate=self._pitch_rate,
            volume=self._volume,
            callback=callback,
            **({"url": self._base_url} if self._base_url else {}),
        )
        if self._reuse:
            # Otherwise streaming_complete() closes the socket it just used.
            synth._close_ws_after_use = False
            try:
                synth._SpeechSynthesizer__connect(5)
            except AttributeError:
                self._reuse = False
                synth._close_ws_after_use = True
        self._session = synth if self._reuse else None
        return synth

    async def stop(self, frame):
        """Cancel any synthesis still running when the pipeline stops."""
        await self._cancel_synthesis()
        await super().stop(frame)

    async def cancel(self, frame):
        """Cancel in-flight synthesis when the user interrupts."""
        await self._cancel_synthesis()
        await super().cancel(frame)

    async def _cancel_synthesis(self) -> None:
        synth, self._synthesizer = self._synthesizer, None
        # streaming_cancel closes the socket, so this one is not reusable; the
        # next utterance dials a fresh one.
        if self._session is synth:
            self._session = None
        if synth is None:
            return

        def _cancel() -> None:
            try:
                # streaming_cancel exists on v2 and later; older models raise.
                synth.streaming_cancel()
            except Exception as e:
                logger.debug(f"{self}: cancel ignored: {e}")

        # Deliberately not awaited: streaming_cancel round-trips to the server
        # and measured ~3s here, and this runs on the barge-in path, where the
        # user has started talking and everything else is trying to stop now.
        # Nothing downstream needs the acknowledgement — the audio already
        # stopped when the generator closed.
        task = asyncio.create_task(asyncio.to_thread(_cancel))
        _CANCEL_TASKS.add(task)
        task.add_done_callback(_CANCEL_TASKS.discard)

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        """Synthesize *text*, yielding audio frames as the model produces them."""
        try:
            await self.start_tts_usage_metrics(text)
            async for frame in self._stream_audio_frames_from_iterator(
                self._synthesize(text),
                in_sample_rate=COSYVOICE_SAMPLE_RATE,
                context_id=context_id,
            ):
                await self.stop_ttfb_metrics()
                yield frame
        except Exception as e:
            logger.error(f"{self} exception: {e}")
            # A failed task leaves the socket's state unknown — half a task in
            # flight, or a server-side close we have not seen yet. Reusing it
            # would turn one bad utterance into every later one.
            self._session = None
            yield ErrorFrame(error=f"CosyVoice synthesis failed: {e}")
        finally:
            self._synthesizer = None
            await self.stop_ttfb_metrics()

    async def _synthesize(self, text: str) -> AsyncIterator[bytes]:
        """Yield raw PCM chunks for *text*.

        The SDK delivers audio by calling ``on_data`` from its own reader thread,
        so the callback hands each chunk to this loop through a queue rather than
        touching asyncio directly. ``None`` is the end-of-stream marker and an
        exception instance is re-raised on the consumer side, which is what makes
        a synthesis error surface from ``run_tts`` instead of being swallowed in
        a thread nobody is awaiting.
        """
        # Imported lazily so the backend still boots without the optional
        # dependency when the user is on Cartesia.
        from dashscope.audio.tts_v2 import ResultCallback

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def emit(item) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, item)

        class _Callback(ResultCallback):
            def on_data(self, data: bytes) -> None:
                emit(data)

            def on_complete(self) -> None:
                emit(None)

            def on_error(self, message) -> None:
                emit(RuntimeError(str(message)))

            def on_close(self) -> None:
                # Guarantees the consumer is released even if the connection
                # drops without on_complete or on_error.
                emit(None)

        # Reuses the open socket when there is one; dials only when there isn't.
        synthesizer = await asyncio.to_thread(self._prepare, _Callback())
        self._synthesizer = synthesizer

        # streaming_call returns as soon as the text is on the wire; audio then
        # arrives on the callback thread. streaming_complete() blocks until the
        # *last* frame of it, so it has to run alongside the drain below rather
        # than before it — awaiting it first turned this into a synthesize-the
        # -whole-sentence-then-emit service, which is what made speech arrive a
        # sentence at a time with a long silence in front of each one.
        await asyncio.to_thread(synthesizer.streaming_call, text)
        finishing = asyncio.create_task(asyncio.to_thread(synthesizer.streaming_complete))

        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            # The end-of-stream marker means the SDK is done, so this is already
            # settled on the normal path. It is still pending when the caller
            # stops early (an interruption closes the generator), and a task
            # left dangling would surface its exception with nobody to catch it.
            finishing.cancel()
            try:
                await finishing
            except (asyncio.CancelledError, Exception):
                pass
