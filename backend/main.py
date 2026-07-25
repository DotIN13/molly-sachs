import os
import sys
import uuid
import secrets
import logging
import datetime
from datetime import timedelta, timezone
import httpx
from loguru import logger
from fastapi import FastAPI, BackgroundTasks, HTTPException, Depends, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator
from fastapi.middleware.cors import CORSMiddleware

from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
    SmallWebRTCPatchRequest
)

from bot import start_pipecat_session, SessionState, PipelineRestartRequested
import database
import config
import llm_models
from db import settings as db_settings
from db.settings import Settings
import auth
import mailer
from ratelimit import rate_limit

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

logger.remove(0)

_LOG_LEVEL = os.environ.get("MOLLY_LOG_LEVEL", "INFO").upper()
_LOG_LEVEL_RTC = os.environ.get("MOLLY_LOG_LEVEL_RTC", _LOG_LEVEL).upper()
_LOG_LEVEL_UVICORN = os.environ.get("MOLLY_LOG_LEVEL_UVICORN", _LOG_LEVEL).upper()
_LOG_LEVEL_BACKEND = os.environ.get("MOLLY_LOG_LEVEL_BACKEND", _LOG_LEVEL).upper()

logger.add(sys.stderr, level=_LOG_LEVEL_BACKEND)

_logging_levels = {"TRACE": 5, "DEBUG": 10, "INFO": 20, "SUCCESS": 25,
                   "WARNING": 30, "ERROR": 40, "CRITICAL": 50}

def _to_logging_level(name: str) -> int:
    return _logging_levels.get(name, 20)

class _InterceptHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        level = logger.level(record.levelname).name
        frame, depth = logging.currentframe(), 2
        while frame and frame.f_code.co_filename == logging.__file__:
            frame = frame.f_back
            depth += 1
        logger.opt(depth=depth, exception=record.exc_info).log(level, record.getMessage())

logging.basicConfig(handlers=[_InterceptHandler()], level=0, force=True)

for _name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
    _uv_logger = logging.getLogger(_name)
    _uv_logger.handlers = [_InterceptHandler()]
    _uv_logger.propagate = False
    _uv_logger.setLevel(_to_logging_level(_LOG_LEVEL_UVICORN))

for _name in ("aioice", "aiortc", "aiortc.rtcpeerconnection", "aioice.ice"):
    logging.getLogger(_name).setLevel(_to_logging_level(_LOG_LEVEL_RTC))


app = FastAPI(
    title="Molly Sachs Assistant Backend",
    description="FastAPI WebRTC server hosting real-time Pipecat sessions with Gemini & Cartesia.",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

os.makedirs(config.OBSERVATIONS_DIR, exist_ok=True)

webrtc_handler = SmallWebRTCRequestHandler(esp32_mode=False, ice_servers=config.ice_servers())

# ── FastAPI Models ───────────────────────────

class SettingsReq(BaseModel):
    gemini_api_key: str | None = None
    cartesia_api_key: str | None = None
    soniox_api_key: str | None = None
    llm_provider: str | None = None
    llm_model: str | None = None
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    deepseek_api_key: str | None = None
    tts_voice: str | None = None
    tts_volume: float | None = None
    tts_speed: float | None = None
    tts_emotion: str | None = None
    stt_language: str | None = None
    stt_provider: str | None = None
    tts_language: str | None = None
    observer_screen_active: bool | None = None
    observer_camera_active: bool | None = None
    observer_screen_interval: int | None = None
    observer_camera_interval: int | None = None
    observer_process_interval: int | None = None
    timezone: str | None = None
    speak_text: bool | None = None
    hypogum_base_url: str | None = None

class RegisterReq(BaseModel):
    email: str
    password: str
    name: str | None = None
    timezone: str | None = None

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if not any(c.islower() for c in v):
            raise ValueError("Password must contain at least one lowercase letter")
        if not any(c.isupper() for c in v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one digit")
        return v

class VerifyReq(BaseModel):
    email: str
    code: str

class LoginReq(BaseModel):
    email: str
    password: str

class RefreshReq(BaseModel):
    refresh_token: str

class ResendReq(BaseModel):
    email: str

class ObservationUploadReq(BaseModel):
    type: str
    image_base64: str
    timestamp: str | None = None
    window_titles: list[str] | None = None

class ConversationCreateReq(BaseModel):
    id: str | None = None
    title: str | None = None

class MessageAddReq(BaseModel):
    role: str
    content: str


# ── Health ──────────────────────────────────

_auth_limiter = rate_limit(max_requests=5, window_seconds=60)
_register_limiter = rate_limit(max_requests=3, window_seconds=300)


@app.post("/api/auth/register", summary="Register a new user account")
async def register(req: RegisterReq, _rate: None = Depends(_register_limiter)):
    existing = await database.app.get_user_by_email(req.email)
    if existing:
        if existing.get("email_verified"):
            return {"status": "ok", "message": "If the email is not registered, a verification code has been sent."}
        await database.app.delete_user(existing["id"])

    password_hash = auth.hash_password(req.password)
    user = await database.app.create_user(req.email, password_hash, req.name,
                                          req.timezone or "")

    code = secrets.token_hex(3)[:6]
    expires = (datetime.datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    await database.app.set_verification_code(user["id"], code, expires)

    await mailer.send_verification_email(req.email, code)

    return {"status": "ok", "message": "Verification code sent to email",
            "user_id": user["id"]}


@app.post("/api/auth/verify", summary="Verify email with code and receive tokens")
async def verify_email(req: VerifyReq, _rate: None = Depends(_auth_limiter)):
    user = await database.app.get_user_by_email(req.email)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.get("email_verified"):
        raise HTTPException(status_code=400, detail="Email already verified")
    if user.get("verification_code") != req.code:
        raise HTTPException(status_code=400, detail="Invalid verification code")
    expires = user.get("verification_expires", "")
    if expires and datetime.datetime.fromisoformat(expires).replace(tzinfo=timezone.utc) < datetime.datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Verification code expired")

    await database.app.verify_user_email(user["id"])

    access_token = auth.create_access_token(user["id"])
    refresh_token = auth.create_refresh_token(user["id"])

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "user": {"id": user["id"], "name": user["name"], "email": user["email"]},
    }


@app.post("/api/auth/login", summary="Login with email and password")
async def login(req: LoginReq, _rate: None = Depends(_auth_limiter)):
    user = await database.app.get_user_by_email(req.email)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    valid, updated_hash = auth.verify_and_update_password(
        req.password, user.get("password_hash", "")
    )
    if not valid:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.get("email_verified"):
        raise HTTPException(status_code=403, detail="Email not verified. Check your inbox.")
    if updated_hash:
        await database.app.update_user_password(user["id"], updated_hash)

    access_token = auth.create_access_token(user["id"])
    refresh_token = auth.create_refresh_token(user["id"])

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "user": {"id": user["id"], "name": user["name"], "email": user["email"]},
    }


@app.post("/api/auth/refresh", summary="Refresh an expired access token")
async def refresh_token(req: RefreshReq):
    payload = auth.decode_token_safe(req.refresh_token, "refresh")
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    user = await database.app.get_user_by_id(payload["sub"])
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    access_token = auth.create_access_token(user["id"])
    return {"access_token": access_token}


@app.post("/api/auth/resend-verification", summary="Resend verification code")
async def resend_verification(req: ResendReq, _rate: None = Depends(_register_limiter)):
    user = await database.app.get_user_by_email(req.email)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.get("email_verified"):
        raise HTTPException(status_code=400, detail="Email already verified")

    code = secrets.token_hex(3)[:6]
    expires = (datetime.datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    await database.app.set_verification_code(user["id"], code, expires)
    await mailer.send_verification_email(req.email, code)

    return {"status": "ok", "message": "New verification code sent"}


@app.get("/api/auth/me", summary="Get current user profile")
async def get_me(current_user: dict = Depends(auth.get_current_user)):
    return {"id": current_user["id"], "name": current_user["name"],
            "email": current_user["email"],
            "email_verified": bool(current_user.get("email_verified"))}

# ── Settings Endpoints ──────────────────────

@app.post("/api/settings", summary="Save user API keys and speech preferences")
async def save_settings(req: SettingsReq,
                        current_user: dict = Depends(auth.get_current_user)):
    data: dict = {}
    if req.gemini_api_key is not None and req.gemini_api_key != "":
        data["gemini_api_key"] = req.gemini_api_key
    if req.cartesia_api_key is not None and req.cartesia_api_key != "":
        data["cartesia_api_key"] = req.cartesia_api_key
    if req.soniox_api_key is not None:
        data["soniox_api_key"] = req.soniox_api_key
    if req.openai_api_key is not None and req.openai_api_key != "":
        data["openai_api_key"] = req.openai_api_key
    if req.anthropic_api_key is not None and req.anthropic_api_key != "":
        data["anthropic_api_key"] = req.anthropic_api_key
    if req.deepseek_api_key is not None and req.deepseek_api_key != "":
        data["deepseek_api_key"] = req.deepseek_api_key
    if req.llm_provider is not None:
        data["llm_provider"] = req.llm_provider
    if req.llm_model is not None:
        data["llm_model"] = req.llm_model
    if req.tts_voice is not None:
        data["tts_voice"] = req.tts_voice
    if req.tts_volume is not None:
        data["tts_volume"] = str(req.tts_volume)
    if req.tts_speed is not None:
        data["tts_speed"] = str(req.tts_speed)
    if req.tts_emotion is not None:
        data["tts_emotion"] = req.tts_emotion
    if req.stt_language is not None:
        data["stt_language"] = req.stt_language
    if req.stt_provider is not None:
        data["stt_provider"] = req.stt_provider
    if req.tts_language is not None:
        data["tts_language"] = req.tts_language
    if req.observer_screen_active is not None:
        data["observer_screen_active"] = "true" if req.observer_screen_active else "false"
    if req.observer_camera_active is not None:
        data["observer_camera_active"] = "true" if req.observer_camera_active else "false"
    if req.observer_screen_interval is not None:
        data["observer_screen_interval"] = str(req.observer_screen_interval)
    if req.observer_camera_interval is not None:
        data["observer_camera_interval"] = str(req.observer_camera_interval)
    if req.observer_process_interval is not None:
        data["observer_process_interval"] = str(req.observer_process_interval)
    if req.timezone is not None:
        data["timezone"] = req.timezone
    if req.speak_text is not None:
        data["speak_text"] = "true" if req.speak_text else "false"
    if req.hypogum_base_url is not None:
        data["hypogum_base_url"] = req.hypogum_base_url

    result = await Settings(current_user["id"]).save(data)
    return {"status": "ok", **result}


@app.get("/api/settings", summary="Retrieve active API keys and speech preferences")
async def get_settings(current_user: dict = Depends(auth.get_current_user)):
    s = await Settings(current_user["id"]).load()
    return {
        "gemini_key_configured": bool(s.get("gemini_api_key", "")),
        "cartesia_key_configured": bool(s.get("cartesia_api_key", "")),
        "soniox_key_configured": bool(s.get("soniox_api_key", "")),
        "openai_key_configured": bool(s.get("openai_api_key", "")),
        "anthropic_key_configured": bool(s.get("anthropic_api_key", "")),
        "deepseek_key_configured": bool(s.get("deepseek_api_key", "")),
        "llm_provider": s.get("llm_provider", "google"),
        "llm_model": s.get("llm_model", ""),
        "tts_voice": s.get("tts_voice"),
        "tts_volume": float(s.get("tts_volume", "1.0")),
        "tts_speed": float(s.get("tts_speed", "1.0")),
        "tts_emotion": s.get("tts_emotion"),
        "stt_language": s.get("stt_language"),
        "stt_provider": s.get("stt_provider"),
        "tts_language": s.get("tts_language"),
        "observer_screen_active": s.get("observer_screen_active", "false").lower() == "true",
        "observer_camera_active": s.get("observer_camera_active", "false").lower() == "true",
        "observer_capture_interval": int(s.get("observer_capture_interval", "60")),
        "observer_screen_interval": int(s.get("observer_screen_interval", "60")),
        "observer_camera_interval": int(s.get("observer_camera_interval", "120")),
        "observer_process_interval": int(s.get("observer_process_interval", "300")),
        "debug": s.get("debug", "false").lower() == "true",
        "timezone": s.get("timezone", ""),
        "speak_text": s.get("speak_text", "true").lower() == "true",
        "hypogum_base_url": s.get("hypogum_base_url", ""),
        # "ok" | "unreadable" | "no_cipher" — lets the UI explain why every key
        # suddenly reads as unconfigured instead of leaving the user guessing.
        "secrets_status": db_settings.secrets_status(current_user["id"]),
    }

# ── Chat model catalogue ────────────────────

@app.get("/api/llm/models", summary="List a provider's chat models, fetched live")
async def list_llm_models(provider: str = Query("google"),
                          refresh: bool = Query(False),
                          current_user: dict = Depends(auth.get_current_user)):
    """Proxy the provider's own models endpoint using this user's stored key.

    Proxied rather than called from the renderer so the API key never leaves the
    backend. `detail` carries a machine-readable code the UI maps to a message."""
    provider = (provider or "").strip().lower()
    if provider not in llm_models.PROVIDERS:
        raise HTTPException(status_code=400, detail="unknown_provider")

    s = await Settings(current_user["id"]).load()
    api_key = s.get(llm_models.KEY_FIELD[provider], "")
    try:
        models, cached = await llm_models.list_models(provider, api_key, refresh=refresh)
    except llm_models.MissingKey:
        raise HTTPException(status_code=400, detail="no_key")
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        logger.warning("llm_models: {} returned {}", provider, code)
        raise HTTPException(status_code=502,
                            detail="bad_key" if code in (401, 403) else "upstream_error")
    except Exception as e:
        logger.warning("llm_models: {} fetch failed: {}", provider, e)
        raise HTTPException(status_code=502, detail="upstream_error")

    return {"provider": provider, "cached": cached, "models": models}

# ── Health ──────────────────────────────────

@app.get("/api/health", summary="Health check endpoint")
async def health_check():
    return {"status": "healthy"}

# ── Observations ────────────────────────────
# NOTE (Phase 2): Molly no longer captures or processes observations — hypogum
# owns all capture/ingest/planning. The upload sink (POST /api/observations)
# and the processor trigger have been removed. The frontend reads observations
# and insights directly from the user's hypogum instance. The GET endpoints
# below remain only to serve any pre-migration local data and are otherwise
# dead; they are removed in the Phase 3 tab cleanup.

@app.get("/api/observations", summary="Retrieve past observations list")
async def get_observations(type: str | None = None, limit: int = 15, offset: int = 0,
                           current_user: dict = Depends(auth.get_current_user)):
    try:
        items, total = await database.app.get_observations(
            current_user["id"], obs_type=type, limit=limit, offset=offset
        )
        return {"items": items, "total": total}
    except Exception as e:
        logger.error(f"Failed to retrieve observations: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/api/observations/file", summary="Serve an observation image file")
async def serve_observation_file(
    path: str = Query(..., description="Relative path to the image file"),
    token: str = Query(..., description="Access token for authentication"),
):
    payload = auth.decode_token_safe(token, "access")
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    filedir = os.path.realpath(config.DATA_DIR)
    filepath = os.path.realpath(os.path.join(config.DATA_DIR, path))
    if not filepath.startswith(filedir + os.sep):
        raise HTTPException(status_code=403, detail="Access denied")
    if not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="File not found")
    if not await database.app.verify_observation_owner(path, payload["sub"]):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(filepath)


@app.get("/api/insights", summary="Retrieve past Gemini summaries and activity insights")
async def get_insights(limit: int = 15, offset: int = 0,
                       current_user: dict = Depends(auth.get_current_user)):
    try:
        items, total = await database.app.get_insights(
            current_user["id"], limit=limit, offset=offset
        )
        return {"items": items, "total": total}
    except Exception as e:
        logger.error(f"Failed to retrieve insights: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


# NOTE (Phase 3): Molly's memory + proactive-tip endpoints have been removed.
# Memory (list/search/add/delete) and tips now live in hypogum; the frontend
# talks to the user's hypogum instance directly (see frontend/src/hypogum.ts).
# The processor trigger + observation upload were removed in Phase 2.

# ── Conversations ───────────────────────────

@app.post("/api/conversations", summary="Create a new conversation session")
async def api_create_conversation(
    req: ConversationCreateReq,
    current_user: dict = Depends(auth.get_current_user)
):
    conv_id = req.id or str(uuid.uuid4())
    title = req.title or database.default_conversation_title()
    await database.app.create_conversation(conv_id, title, current_user["id"])
    return {"id": conv_id, "title": title}


@app.get("/api/conversations", summary="Retrieve all past conversations")
async def api_get_conversations(
    current_user: dict = Depends(auth.get_current_user)
):
    return await database.app.get_conversations(current_user["id"])


@app.post("/api/conversations/{conversation_id}/messages",
          summary="Add a message to a conversation via REST")
async def api_add_message(
    conversation_id: str,
    req: MessageAddReq,
    current_user: dict = Depends(auth.get_current_user),
):
    if not await database.app.verify_conversation_owner(conversation_id, current_user["id"]):
        raise HTTPException(status_code=404, detail="Conversation not found")
    await database.app.add_message(
        conversation_id, req.role, req.content, current_user["id"]
    )
    return {"status": "ok"}


@app.get("/api/conversations/{conversation_id}/messages",
         summary="Retrieve messages in a past session")
async def api_get_messages(
    conversation_id: str,
    current_user: dict = Depends(auth.get_current_user)
):
    if not await database.app.verify_conversation_owner(conversation_id, current_user["id"]):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return await database.app.get_messages(conversation_id, current_user["id"])


@app.delete("/api/conversations/{conversation_id}",
            summary="Delete a past conversation session")
async def api_delete_conversation(
    conversation_id: str,
    current_user: dict = Depends(auth.get_current_user)
):
    deleted = await database.app.delete_conversation(conversation_id, current_user["id"])
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"status": "ok"}

# ── WebRTC ──────────────────────────────────

@app.post("/api/webrtc/connect", summary="Handle WebRTC connection offer")
async def webrtc_connect(
    request: SmallWebRTCRequest,
    background_tasks: BackgroundTasks,
    conversation_id: str | None = None,
    token: str | None = None
):
    try:
        if not token:
            raise HTTPException(status_code=401, detail="Authentication token required")
        payload = auth.decode_token_safe(token, "access")
        if not payload:
            raise HTTPException(status_code=401, detail="Invalid or expired token")
        user = await database.app.get_user_by_id(payload["sub"])
        if not user:
            raise HTTPException(status_code=401, detail="User not found")

        conv_id = conversation_id or str(uuid.uuid4())
        if conversation_id and not await database.app.verify_conversation_owner(conversation_id, user["id"]):
            raise HTTPException(status_code=404, detail="Conversation not found")
        await database.app.create_conversation(conv_id, database.default_conversation_title(), user["id"])

        session = await SessionState.create(user["id"], conv_id)
        # The required LLM key depends on the selected chat provider.
        _llm_key = {
            "google": "gemini_api_key",
            "openai": "openai_api_key",
            "anthropic": "anthropic_api_key",
            "deepseek": "deepseek_api_key",
        }.get(session.prefs.get("llm_provider", "google"), "gemini_api_key")
        if not session.prefs.get(_llm_key) or not session.prefs.get("cartesia_api_key"):
            raise HTTPException(status_code=400, detail="Missing API keys. Configure in Settings.")

        async def webrtc_connection_callback(connection: SmallWebRTCConnection):
            async def run_pipeline(sess):
                while True:
                    try:
                        await start_pipecat_session(connection, sess)
                        break
                    except PipelineRestartRequested as e:
                        logger.info("Restarting pipeline due to changed keys: {}",
                                    list(e.changes.keys()))
                        sess = await SessionState.create(user["id"], conv_id)
            background_tasks.add_task(run_pipeline, session)

        answer = await webrtc_handler.handle_web_request(
            request=request,
            webrtc_connection_callback=webrtc_connection_callback
        )
        return answer
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"WebRTC connection error: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.patch("/api/webrtc/connect", summary="Receive trickle ICE candidates from client")
async def webrtc_patch(request: SmallWebRTCPatchRequest):
    await webrtc_handler.handle_patch_request(request)
    return {"status": "success"}

# ── Lifecycle ──────────────────────────────

@app.on_event("startup")
async def startup_event():
    await database.init()
    logger.info("Server startup complete")


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Server shutting down, closing WebRTC handler")
    await webrtc_handler.close()
    await database.app.close()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("BACKEND_PORT", "8000")))
