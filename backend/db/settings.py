import json
import os
from typing import Optional

from cryptography.fernet import Fernet
from loguru import logger

import database
import config


class Settings:
    """Application settings with DB persistence + Fernet encryption.

    Only API keys (gemini/cartesia/soniox) are encrypted at rest.
    Voice prefs and observer settings are stored as plaintext JSON.

    Priority: DB user overrides > os.environ (.env) > hardcoded defaults.
    """

    SECRET_KEYS = {"gemini_api_key", "cartesia_api_key", "soniox_api_key"}

    _instance: Optional["Settings"] = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self._cache: dict[str, str] = {}
        self._cipher: Optional[Fernet] = None
        key = config.fernet_key()
        if key:
            self._cipher = Fernet(key.encode())

        self._defaults: dict[str, str] = {
            "gemini_api_key": "",
            "cartesia_api_key": "",
            "soniox_api_key": "",
            "tts_voice": "79a125e8-cd45-4c13-8a67-188112f4dd22",
            "tts_volume": "1.0",
            "tts_speed": "1.0",
            "tts_emotion": "neutral",
            "stt_language": "zh",
            "stt_provider": "soniox",
            "tts_language": "en",
            "tts_provider": "cartesia",
            "observer_screen_active": "false",
            "observer_camera_active": "false",
            "observer_capture_interval": "60",
            "observer_process_interval": "300",
            "debug": "false",
        }

    # ── persistence ──────────────────────────

    async def load(self, user_id: str = "default") -> None:
        """Load from DB → decrypt secrets → merge prefs + env → cache."""
        raw = await database.app.get_user_settings(user_id)

        # Decrypt only the secrets blob if present
        secrets: dict = {}
        if self._cipher and "secrets" in raw:
            try:
                plain = self._cipher.decrypt(raw["secrets"].encode())
                secrets = json.loads(plain)
                logger.info("Settings: decrypted {} secret keys for user {}", len(secrets), user_id)
            except Exception:
                logger.warning("Settings: secrets decryption failed")

        for key, default in self._defaults.items():
            # 1. Decrypted secrets (API keys)
            if key in secrets and secrets[key] != "":
                self._cache[key] = str(secrets[key])
                continue
            # 2. Plaintext prefs in DB
            if key in raw and raw[key] != "":
                self._cache[key] = str(raw[key])
                continue
            # 3. os.environ fallback (.env file)
            env_val = os.environ.get(key.upper())
            if env_val is not None:
                self._cache[key] = env_val
                continue
            # 4. Hardcoded default
            self._cache[key] = default

        logger.info("Settings: loaded {} keys into cache", len(self._cache))

    def get(self, key: str, default: str = "") -> str:
        return self._cache.get(key, default)

    async def save(self, user_id: str = "default",
                   settings: Optional[dict] = None) -> None:
        """Merge new values, prune env-duplicates, encrypt secrets, persist."""
        if settings:
            for k, v in settings.items():
                if v is not None and str(v) != "":
                    self._cache[k] = str(v)
                else:
                    self._cache.pop(k, None)

        # Build DB dict: prefs as plaintext, API keys in encrypted secrets blob
        db_dict: dict = {}
        secrets: dict = {}
        for k, v in self._cache.items():
            env_val = os.environ.get(k.upper())
            if env_val is not None and str(v) == env_val:
                continue  # same as .env — don't store
            if k in self._defaults and str(v) == self._defaults[k]:
                continue  # same as hardcoded default

            if k in self.SECRET_KEYS:
                secrets[k] = v
            else:
                db_dict[k] = v

        # Encrypt only the secrets blob
        if self._cipher and secrets:
            db_dict["secrets"] = self._cipher.encrypt(
                json.dumps(secrets).encode()
            ).decode()

        await database.app.save_user_settings(user_id, json.dumps(db_dict))
        logger.info("Settings: saved {} keys to DB for user {}", len(db_dict), user_id)


settings = Settings()
