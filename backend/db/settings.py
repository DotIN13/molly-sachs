import json
import os
from typing import Optional

from cryptography.fernet import Fernet
from loguru import logger

import database
import config


SECRET_KEYS = {"gemini_api_key", "cartesia_api_key", "soniox_api_key"}

_DEFAULTS: dict[str, str] = {
    "gemini_api_key": "",
    "cartesia_api_key": "",
    "soniox_api_key": "",
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
}

_cipher: Optional[Fernet] = None


def _get_cipher() -> Optional[Fernet]:
    global _cipher
    if _cipher is None:
        key = config.fernet_key()
        if key:
            _cipher = Fernet(key.encode())
    return _cipher


class Settings:
    """Per-user settings with DB persistence + Fernet encryption.

    Priority: DB user overrides > os.environ (.env) > hardcoded defaults.
    No singleton — each instance operates on a single user_id.
    """

    def __init__(self, user_id: str):
        self.user_id = user_id

    async def load(self) -> dict[str, str]:
        """Load from DB for this user, return merged dict. No instance cache."""
        raw = await database.app.get_user_settings(self.user_id)
        cipher = _get_cipher()

        secrets: dict = {}
        if cipher and "secrets" in raw:
            try:
                plain = cipher.decrypt(raw["secrets"].encode())
                secrets = json.loads(plain)
                logger.info("Settings: decrypted {} secret keys for user {}",
                            len(secrets), self.user_id)
            except Exception:
                logger.warning("Settings: secrets decryption failed")

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

        logger.info("Settings: loaded {} keys for user {}", len(result), self.user_id)
        return result

    async def save(self, values: dict[str, str | None]) -> None:
        """Persist the given values for this user. Encrypts API keys."""
        current = await self.load()

        for k, v in values.items():
            if v is not None and str(v) != "":
                current[k] = str(v)
            else:
                current.pop(k, None)

        db_dict: dict = {}
        secrets_to_encrypt: dict = {}
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
        if cipher and secrets_to_encrypt:
            db_dict["secrets"] = cipher.encrypt(
                json.dumps(secrets_to_encrypt).encode()
            ).decode()

        await database.app.save_user_settings(
            self.user_id, json.dumps(db_dict)
        )
        logger.info("Settings: saved {} keys to DB for user {}",
                    len(db_dict), self.user_id)
