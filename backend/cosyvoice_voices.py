"""Custom voice management for CosyVoice (Aliyun Model Studio).

The v3.5 models carry no system voices, so a cloned voice is the only way to use
them. This wraps DashScope's ``VoiceEnrollmentService`` so Molly's Settings can
list, create and delete voices instead of the user pasting an opaque id copied
out of the Model Studio console.

**Where the audio comes from.** ``create_voice`` takes a *URL*, not a file — the
service fetches the sample itself. A desktop app has a local recording instead,
so ``clone_voice`` accepts raw bytes and sends them as a ``data:`` URI. That path
is documented for Qwen-TTS but not for CosyVoice, and it is not verified here
(no API key in this environment), so a plain URL remains supported and is the
fallback when the service rejects inline audio.

Sample requirements, from the Model Studio docs: WAV (16-bit), MP3 or M4A,
at most 10 MB, 10–20 seconds recommended and 60 seconds maximum. Up to 1000
voices per account per model series; unused voices are reclaimed after a year.
"""

import base64
import re
from dataclasses import dataclass

from loguru import logger

# Mirrors the SDK's documented constraint on `prefix`.
PREFIX_RE = re.compile(r"^[a-z0-9]{1,9}$")

MAX_SAMPLE_BYTES = 10 * 1024 * 1024

_MIME = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
}


class VoiceError(Exception):
    """A voice operation failed in a way worth showing the user."""


@dataclass
class Voice:
    voice_id: str
    status: str = ""
    created: str = ""
    modified: str = ""


def _service(api_key: str):
    if not api_key:
        raise VoiceError("no_key")
    # Imported lazily so a Cartesia-only install need not have dashscope.
    from dashscope.audio.tts_v2 import VoiceEnrollmentService

    return VoiceEnrollmentService(api_key=api_key)


def _as_voice(raw: dict) -> Voice:
    """Normalise one entry from ``list_voices``.

    The SDK documents the shape only loosely ("id, creation time, modification
    time, and status"), and the key names have varied, so accept the plausible
    spellings rather than guessing one.
    """
    def pick(*names: str) -> str:
        for n in names:
            v = raw.get(n)
            if v:
                return str(v)
        return ""

    return Voice(
        voice_id=pick("voice_id", "voiceId", "id"),
        status=pick("status", "state"),
        created=pick("gmt_create", "gmtCreate", "create_time", "created"),
        modified=pick("gmt_modified", "gmtModified", "modify_time", "modified"),
    )


def list_voices(api_key: str, prefix: str | None = None,
                page_size: int = 100) -> list[Voice]:
    """Every custom voice on the account, newest first where the API says so."""
    svc = _service(api_key)
    try:
        raw = svc.list_voices(prefix=prefix or None, page_index=0,
                              page_size=page_size)
    except Exception as e:
        raise VoiceError(str(e)) from e
    return [v for v in (_as_voice(r) for r in (raw or [])) if v.voice_id]


def clone_voice(api_key: str, *, target_model: str, prefix: str,
                url: str | None = None, audio: bytes | None = None,
                filename: str = "") -> str:
    """Create a cloned voice from *url* or from inline *audio*. Returns its id.

    Exactly one of ``url`` / ``audio`` should be given; ``audio`` is encoded as a
    ``data:`` URI, which saves the user from hosting the sample somewhere the
    service can reach.
    """
    if not PREFIX_RE.match(prefix or ""):
        raise VoiceError("bad_prefix")
    if not url and not audio:
        raise VoiceError("no_audio")

    if audio is not None:
        if len(audio) > MAX_SAMPLE_BYTES:
            raise VoiceError("too_large")
        ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
        mime = _MIME.get(ext)
        if mime is None:
            raise VoiceError("bad_format")
        url = f"data:{mime};base64,{base64.b64encode(audio).decode()}"

    svc = _service(api_key)
    try:
        voice_id = svc.create_voice(
            target_model=target_model, prefix=prefix, url=url,
        )
    except Exception as e:
        logger.warning("cosyvoice clone failed (model={}, prefix={}): {}",
                       target_model, prefix, e)
        raise VoiceError(str(e)) from e
    logger.info("cosyvoice: created voice {} for model {}", voice_id, target_model)
    return voice_id


def delete_voice(api_key: str, voice_id: str) -> None:
    svc = _service(api_key)
    try:
        svc.delete_voice(voice_id)
    except Exception as e:
        raise VoiceError(str(e)) from e
    logger.info("cosyvoice: deleted voice {}", voice_id)
