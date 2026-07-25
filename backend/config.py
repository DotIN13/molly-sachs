import os

from aiortc import RTCIceServer
from dotenv import load_dotenv

_env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(_env_file):
    load_dotenv(_env_file)

# ── paths ────────────────────────────────────

_base = os.environ.get("DATA_DIR", "").strip()
if _base:
    DATA_DIR = os.path.abspath(_base)
else:
    DATA_DIR = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "data")
    )

SQLITE_PATH = os.path.join(DATA_DIR, "app.db")
OBSERVATIONS_DIR = os.path.join(DATA_DIR, "observations")


def observation_entries_dir(date_str: str) -> str:
    """`observations/YYYY-MM-DD/entries/`"""
    return os.path.join(OBSERVATIONS_DIR, date_str, "entries")


def observation_artefacts_dir(date_str: str) -> str:
    """`observations/YYYY-MM-DD/artefacts/`"""
    return os.path.join(OBSERVATIONS_DIR, date_str, "artefacts")

os.makedirs(DATA_DIR, exist_ok=True)

# ── env helpers ──────────────────────────────


def is_debug() -> bool:
    return os.environ.get("DEBUG", "false").lower() == "true"


def cors_origins() -> list:
    raw = os.environ.get("CORS_ORIGINS", "*").strip()
    if raw == "*":
        return ["*"]
    return [o.strip() for o in raw.split(",") if o.strip()]


def fernet_key() -> str:
    return os.environ.get("FERNET_KEY", "").strip()


_DEFAULT_HYPOGUM_URL = "http://127.0.0.1:8056"


def hypogum_base_url() -> str:
    """Default base URL of the local hypogum instance (the memory brain).

    Per-user overrides live in Settings (`hypogum_base_url`); this is the
    fallback when a user hasn't configured one.
    """
    return os.environ.get("HYPOGUM_BASE_URL", "").strip() or _DEFAULT_HYPOGUM_URL


def ice_servers() -> list:
    servers = [RTCIceServer(urls='stun:stun.l.google.com:19302')]
    turn_url = os.environ.get("TURN_SERVER", "").strip()
    turn_username = os.environ.get("TURN_USERNAME", "").strip()
    turn_password = os.environ.get("TURN_PASSWORD", "").strip()
    if turn_url and turn_username and turn_password:
        if not turn_url.startswith('turn:') and not turn_url.startswith('turns:'):
            turn_url = f'turn:{turn_url}'
        servers.append(RTCIceServer(
            urls=turn_url,
            username=turn_username,
            credential=turn_password
        ))
    return servers
