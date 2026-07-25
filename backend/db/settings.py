import json
import os
import time

from cryptography.fernet import Fernet
from loguru import logger

import database
import config


SECRET_KEYS = {
    "gemini_api_key", "cartesia_api_key", "soniox_api_key",
    "openai_api_key", "anthropic_api_key", "deepseek_api_key",
}

_DEFAULTS: dict[str, str] = {
    "gemini_api_key": "",
    "cartesia_api_key": "",
    "soniox_api_key": "",
    # Chat LLM provider + optional model override (blank model → provider default).
    "llm_provider": "google",
    "llm_model": "",
    "openai_api_key": "",
    "anthropic_api_key": "",
    "deepseek_api_key": "",
    "tts_voice": "6eb8965c-e295-47bd-a9e4-3eeebb3abcff",
    "tts_volume": "1.0",
    "tts_speed": "1.0",
    "tts_emotion": "neutral",
    "stt_language": "zh",
    "stt_provider": "soniox",
    "tts_language": "en",
    "tts_provider": "cartesia",
    "observer_screen_active": "false",
    "observer_camera_active": "false",
    "observer_screen_interval": "60",
    "observer_camera_interval": "120",
    "observer_process_interval": "300",
    "debug": "false",
    "timezone": "",
    "speak_text": "true",
    # Base URL of this user's hypogum instance (memory brain). Empty → fall
    # back to config.hypogum_base_url() (env HYPOGUM_BASE_URL or localhost).
    "hypogum_base_url": "",
}

DEFAULT_TTL = 5.0

_cipher: Fernet | None = None
_cache: dict[str, tuple[float, dict[str, str]]] = {}

# State of the stored secrets blob, per user, refreshed on every real load():
#   "ok"          – decrypted fine, or there was nothing stored to decrypt
#   "unreadable"  – a blob exists but Fernet rejected it (FERNET_KEY rotated)
#   "no_cipher"   – a blob exists but no usable FERNET_KEY is configured
_secrets_state: dict[str, str] = {}

# The ciphertext exactly as read from the DB. Kept so save() can write it back
# verbatim when we could not decrypt it — dropping it there is what silently
# wiped users' API keys after a FERNET_KEY change.
_secrets_blob: dict[str, str] = {}


def secrets_status(user_id: str) -> str:
    """State of `user_id`'s secrets blob as of the last load(). See _secrets_state."""
    return _secrets_state.get(user_id, "ok")


def _get_cipher() -> Fernet | None:
    global _cipher
    if _cipher is None:
        key = config.fernet_key()
        if key:
            try:
                _cipher = Fernet(key.encode())
            except Exception:
                # Malformed FERNET_KEY. Return None so callers treat secrets as
                # unreadable-but-preserved instead of crashing every settings read.
                logger.error("Settings: FERNET_KEY is not a valid Fernet key")
    return _cipher


class Settings:
    """Per-user settings with DB persistence + Fernet encryption.

    Priority: DB user overrides > os.environ (.env) > hardcoded defaults.
    No singleton — each instance operates on a single user_id.
    """

    def __init__(self, user_id: str):
        self.user_id = user_id

    async def load(self) -> dict[str, str]:
        """Load from DB for this user, return merged dict. Uses in-memory cache with TTL."""
        now = time.monotonic()
        if self.user_id in _cache:
            cached_at, cached = _cache[self.user_id]
            if now - cached_at < DEFAULT_TTL:
                return dict(cached)

        raw = await database.app.get_user_settings(self.user_id)
        cipher = _get_cipher()

        blob = raw.get("secrets") or ""
        _secrets_blob[self.user_id] = blob

        secrets: dict[str, str] = {}
        if not blob:
            _secrets_state[self.user_id] = "ok"
        elif cipher is None:
            _secrets_state[self.user_id] = "no_cipher"
            logger.error("Settings: stored API keys for user {} cannot be read — "
                         "no usable FERNET_KEY is configured", self.user_id)
        else:
            try:
                plain = cipher.decrypt(blob.encode())
                secrets = json.loads(plain)
                _secrets_state[self.user_id] = "ok"
                logger.info("Settings: decrypted {} secret keys for user {}",
                            len(secrets), self.user_id)
            except Exception:
                _secrets_state[self.user_id] = "unreadable"
                logger.warning("Settings: secrets decryption failed for user {} — "
                               "FERNET_KEY likely changed; stored API keys are "
                               "unreadable and must be re-entered", self.user_id)

        result: dict[str, str] = {}
        for key, default in _DEFAULTS.items():
            if key in secrets and secrets[key] != "":
                result[key] = str(secrets[key])
                continue
            if key in raw and raw[key] != "":
                result[key] = str(raw[key])
                continue
            env_val = os.environ.get(key.upper())
            if env_val is not None:
                result[key] = env_val
                continue
            result[key] = default

        _cache[self.user_id] = (now, dict(result))
        logger.info("Settings: loaded {} keys for user {}", len(result), self.user_id)
        return result

    async def save(self, values: dict[str, str | None]) -> dict[str, str]:
        """Persist the given values for this user. Encrypts API keys, invalidates
        the cache, and returns ``{"secrets_status": …}`` (see _secrets_state).

        Secrets we could not decrypt are written back untouched rather than
        dropped, so a bad/rotated FERNET_KEY can no longer destroy stored keys
        as a side effect of saving an unrelated setting."""
        _cache.pop(self.user_id, None)
        current = await self.load()  # also refreshes _secrets_state / _secrets_blob
        state = _secrets_state.get(self.user_id, "ok")
        stale_blob = _secrets_blob.get(self.user_id, "")

        for k, v in values.items():
            if v is not None and str(v) != "":
                current[k] = str(v)
            else:
                current.pop(k, None)

        db_dict: dict[str, str] = {}
        secrets_to_encrypt: dict[str, str] = {}
        for k, v in current.items():
            env_val = os.environ.get(k.upper())
            if env_val is not None and str(v) == env_val:
                continue
            if k in _DEFAULTS and str(v) == _DEFAULTS[k]:
                continue
            if k in SECRET_KEYS:
                secrets_to_encrypt[k] = v
            else:
                db_dict[k] = v

        cipher = _get_cipher()
        wrote_secrets = bool(secrets_to_encrypt) and cipher is not None

        if wrote_secrets:
            db_dict["secrets"] = cipher.encrypt(
                json.dumps(secrets_to_encrypt).encode()
            ).decode()
        elif stale_blob and state != "ok":
            # We could not read this blob, so we cannot re-encrypt its contents.
            # Preserve it byte-for-byte: it may still be recoverable by restoring
            # the original FERNET_KEY. (When state is "ok" an empty
            # secrets_to_encrypt genuinely means the user cleared their keys, so
            # the blob is intentionally dropped.)
            db_dict["secrets"] = stale_blob

        status = "ok"
        if secrets_to_encrypt and cipher is None:
            status = "no_cipher"
            logger.error("Settings: FERNET_KEY unavailable — refusing to store "
                         "API keys for user {} in plaintext; they were NOT saved",
                         self.user_id)
        elif wrote_secrets and stale_blob and state == "unreadable":
            status = "secrets_replaced"
            logger.warning("Settings: replaced the undecryptable secrets blob for "
                           "user {} with newly entered keys", self.user_id)
        elif state != "ok":
            status = state
            logger.warning("Settings: preserved the existing ({}) secrets blob for "
                           "user {} instead of dropping it", state, self.user_id)

        await database.app.save_user_settings(
            self.user_id, json.dumps(db_dict)
        )
        # load() above repopulated the cache with the pre-save values; drop it
        # again so the next read reflects what we just wrote.
        _cache.pop(self.user_id, None)
        logger.info("Settings: saved {} keys to DB for user {}",
                    len(db_dict), self.user_id)
        return {"secrets_status": status}
