import os

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
CHROMA_PATH = os.path.join(DATA_DIR, "chroma.db")
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


def ice_servers() -> list:
    servers: list = [{'urls': 'stun:stun.l.google.com:19302'}]
    turn_url = os.environ.get("TURN_SERVER", "").strip()
    turn_username = os.environ.get("TURN_USERNAME", "").strip()
    turn_password = os.environ.get("TURN_PASSWORD", "").strip()
    if turn_url and turn_username and turn_password:
        servers.append({
            'urls': turn_url,
            'username': turn_username,
            'credential': turn_password
        })
    return servers
