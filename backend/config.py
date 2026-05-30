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
OBSERVERS_DIR = os.path.join(DATA_DIR, "observers")

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
