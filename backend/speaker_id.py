"""Speaker verification — telling the user apart from the room.

Live mode listens to a microphone, and a microphone in a living room hears the
television. Nothing already in the pipeline can help with that: RNNoise and the
browser's ``noiseSuppression`` are built to *preserve* speech while removing
everything else, and a VAD only answers "is someone talking". Dialogue from a
show is speech, from a human voice, in well-formed sentences — it passes every
one of those checks.

What separates it is *whose* voice it is. This module turns a few seconds of
audio into a speaker embedding, so a stored one from the user can be compared
against whatever the microphone just picked up.

The model is 3D-Speaker's CAM++ trained on CN-Celeb, run through sherpa-onnx.
That combination is deliberate: onnxruntime is already a dependency and torch is
not, sherpa-onnx brings its own Kaldi-compatible fbank so the feature extraction
does not have to be reimplemented against the model's training config, and a
Mandarin-trained model suits the person who will actually be enrolling.

The model file is data, not code — 27 MB living under ``data/models/speaker``,
fetched once. Absent, everything here reports unavailable and the caller is
expected to fall through to accepting all audio, since refusing to listen is a
worse failure than listening too much.
"""

import base64
import hashlib
import os
import threading

import httpx
import numpy as np
from loguru import logger

import config

# The verifier is only as good as the audio it is handed. Below roughly this
# much speech an embedding is dominated by whatever phonemes happen to be in it
# rather than by the voice: measured against a 0.5 threshold, a 0.6s window
# scored the enrolled voice as low as 0.499 — rejecting its owner — while 0.8s
# put the floor at 0.605. Anything shorter gets no verdict at all, which the
# callers treat as "let it through".
MIN_SECONDS = 0.8

# Enrollment wants enough speech to average across; this is the point past
# which more audio stops meaningfully improving the template.
ENROLL_SECONDS = 10.0

_DEFAULT_MODEL_PATH = os.path.join(config.DATA_DIR, "models", "speaker", "campplus_zh.onnx")
MODEL_PATH = os.environ.get("MOLLY_SPEAKER_MODEL") or _DEFAULT_MODEL_PATH

# 3D-Speaker's CAM++ trained on CN-Celeb, converted to ONNX by the sherpa-onnx
# project. The release tag really is spelled "recongition" upstream — do not
# correct it, the URL 404s if you do.
MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"
)
MODEL_SHA256 = "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11"
MODEL_BYTES = 28281138

_download_lock = threading.Lock()

_extractor = None
_extractor_lock = threading.Lock()
_unavailable_logged = False


def available() -> bool:
    """True if the model file is present and the runtime imported."""
    return _get_extractor() is not None


def ensure_model(timeout: float = 300.0) -> bool:
    """Fetch the model if it isn't on disk yet. Blocking — call from a thread.

    27 MB is too much to make anyone fetch by hand on a new machine, and too
    much to fetch on every machine that will never use this. So it is pulled at
    the first enrollment, the earliest moment it is genuinely needed, inside a
    request the user is already waiting on. Until then everything here reports
    unavailable and verification is simply off.

    A pointed-at model (``MOLLY_SPEAKER_MODEL``) is left alone entirely — that
    file belongs to whoever set the variable.
    """
    if MODEL_PATH != _DEFAULT_MODEL_PATH:
        return os.path.exists(MODEL_PATH)

    with _download_lock:
        if os.path.exists(MODEL_PATH):
            # A partial download from a previous run would load as a corrupt
            # graph and fail somewhere much less obvious than here.
            if os.path.getsize(MODEL_PATH) == MODEL_BYTES:
                return True
            logger.warning("[speaker] model is {} bytes, expected {} — refetching",
                           os.path.getsize(MODEL_PATH), MODEL_BYTES)
            os.remove(MODEL_PATH)

        os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
        part = MODEL_PATH + ".part"
        digest = hashlib.sha256()
        logger.info("[speaker] fetching model ({:.0f} MB) …", MODEL_BYTES / 1e6)
        try:
            with httpx.stream("GET", MODEL_URL, timeout=timeout,
                              follow_redirects=True) as r:
                r.raise_for_status()
                with open(part, "wb") as f:
                    for chunk in r.iter_bytes(1 << 16):
                        digest.update(chunk)
                        f.write(chunk)
            if digest.hexdigest() != MODEL_SHA256:
                raise ValueError(f"checksum mismatch ({digest.hexdigest()[:12]}…)")
            # Rename last, so a half-written file is never at the real path for
            # another thread to pick up and try to load.
            os.replace(part, MODEL_PATH)
        except Exception as e:
            logger.warning("[speaker] model download failed, verification stays off: {}", e)
            try:
                os.remove(part)
            except OSError:
                pass
            return False

    logger.info("[speaker] model ready at {}", MODEL_PATH)
    return True


def _get_extractor():
    """The shared embedding extractor, or None. Built once, on first use."""
    global _extractor, _unavailable_logged
    if _extractor is not None:
        return _extractor
    with _extractor_lock:
        if _extractor is not None:
            return _extractor
        if not os.path.exists(MODEL_PATH):
            if not _unavailable_logged:
                logger.warning("[speaker] no model at {} — verification disabled", MODEL_PATH)
                _unavailable_logged = True
            return None
        try:
            import sherpa_onnx

            cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=MODEL_PATH,
                num_threads=1,
                provider="cpu",
            )
            _extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
            logger.info("[speaker] loaded {} (dim {})",
                        os.path.basename(MODEL_PATH), _extractor.dim)
        except Exception as e:
            if not _unavailable_logged:
                logger.warning("[speaker] extractor unavailable: {}", e)
                _unavailable_logged = True
            return None
    return _extractor


def pcm_to_float(pcm: bytes) -> np.ndarray:
    """16-bit little-endian PCM to the float32 in [-1, 1] the model expects."""
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def embed(samples: np.ndarray, sample_rate: int) -> np.ndarray | None:
    """A unit-length speaker embedding for *samples*, or None.

    None means "no opinion" — too little audio, or no model — and is never a
    verdict about who is speaking.
    """
    extractor = _get_extractor()
    if extractor is None:
        return None
    if samples.size < int(MIN_SECONDS * sample_rate):
        return None

    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=sample_rate, waveform=samples)
    stream.input_finished()
    if not extractor.is_ready(stream):
        return None

    vec = np.asarray(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(vec))
    return vec / norm if norm else None


def similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity of two unit embeddings, in [-1, 1]."""
    return float(np.dot(a, b))


def enroll(clips: list[tuple[np.ndarray, int]]) -> np.ndarray | None:
    """Average several clips into one reference embedding.

    Averaging unit vectors and renormalising pulls the template toward what is
    consistent across the clips — the voice — and away from the words in any
    one of them.
    """
    vecs = [v for v in (embed(s, sr) for s, sr in clips) if v is not None]
    if not vecs:
        return None
    mean = np.mean(vecs, axis=0)
    norm = float(np.linalg.norm(mean))
    return mean / norm if norm else None


def encode(vec: np.ndarray) -> str:
    """Serialise an embedding for storage alongside the user's settings."""
    return base64.b64encode(vec.astype("<f4").tobytes()).decode()


def decode(blob: str) -> np.ndarray | None:
    try:
        vec = np.frombuffer(base64.b64decode(blob), dtype="<f4").astype(np.float32)
    except Exception:
        return None
    return vec if vec.size else None
