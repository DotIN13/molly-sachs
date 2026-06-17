import os
import sys
import asyncio
import base64
import json
import time
import uuid
import secrets
import logging
import datetime
from datetime import timedelta, timezone
from loguru import logger
from fastapi import FastAPI, BackgroundTasks, HTTPException, Depends, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator
from fastapi.middleware.cors import CORSMiddleware

from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
    SmallWebRTCPatchRequest
)

from bot import start_pipecat_session, SessionState, PipelineRestartRequested, _embed_query
from processor import process_pending_observations
from proactive import generate_proactive_tip
import database
import config
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

    await Settings(current_user["id"]).save(data)
    return {"status": "ok"}


@app.get("/api/settings", summary="Retrieve active API keys and speech preferences")
async def get_settings(current_user: dict = Depends(auth.get_current_user)):
    s = await Settings(current_user["id"]).load()
    return {
        "gemini_key_configured": bool(s.get("gemini_api_key", "")),
        "cartesia_key_configured": bool(s.get("cartesia_api_key", "")),
        "soniox_key_configured": bool(s.get("soniox_api_key", "")),
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
    }

# ── Health ──────────────────────────────────

@app.get("/api/health", summary="Health check endpoint")
async def health_check():
    return {"status": "healthy"}

# ── Observations ────────────────────────────

@app.post("/api/observations", summary="Receive observer base64 capture and save entry + artefact")
async def upload_observation(req: ObservationUploadReq,
                             current_user: dict = Depends(auth.get_current_user)):
    try:
        data_str = req.image_base64
        if "," in data_str:
            data_str = data_str.split(",")[1]
        image_bytes = base64.b64decode(data_str)

        timestamp_str = req.timestamp or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        date_str = timestamp_str[:10]
        safe_ts = timestamp_str.replace(":", "-").replace("Z", "").replace("T", "_")
        stem = f"{req.type}_{safe_ts}_{uuid.uuid4().hex[:6]}"

        entries_dir = config.observation_entries_dir(date_str)
        artefacts_dir = config.observation_artefacts_dir(date_str)
        os.makedirs(entries_dir, exist_ok=True)
        os.makedirs(artefacts_dir, exist_ok=True)

        artefact_filename = f"{stem}.jpg"
        artefact_path = os.path.join(artefacts_dir, artefact_filename)
        with open(artefact_path, "wb") as f:
            f.write(image_bytes)

        windows = req.window_titles or []
        prompt_text = ""
        if req.type == "screen" and windows:
            win_list = "\n  ".join(windows)
            prompt_text = f"[Screenshot {date_str}] Open windows:\n  {win_list}"
        elif req.type == "screen":
            prompt_text = f"[Screenshot {date_str}]"
        else:
            prompt_text = f"[Camera {date_str}]"

        entry = {
            "type": req.type,
            "observer": req.type,
            "timestamp": timestamp_str,
            "windows": windows,
            "prompt_text": prompt_text,
            "artefact_path": f"../artefacts/{artefact_filename}",
        }
        entry_filename = f"{stem}.json"
        entry_path = os.path.join(entries_dir, entry_filename)
        with open(entry_path, "w", encoding="utf-8") as f:
            json.dump(entry, f, ensure_ascii=False, indent=2)

        db_image_path = f"observations/{date_str}/artefacts/{artefact_filename}"
        await database.app.save_observation(
            req.type, db_image_path, timestamp_str, current_user["id"]
        )

        return {
            "status": "ok",
            "filename": artefact_filename,
            "db_path": db_image_path,
            "entry_path": f"observations/{date_str}/entries/{entry_filename}",
        }
    except Exception as e:
        logger.error(f"Failed to upload observation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/observations", summary="Retrieve past observations list")
async def get_observations(type: str | None = None, limit: int = 15,
                           current_user: dict = Depends(auth.get_current_user)):
    try:
        return await database.app.get_observations(
            current_user["id"], obs_type=type, limit=limit
        )
    except Exception as e:
        logger.error(f"Failed to retrieve observations: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
async def get_insights(limit: int = 15,
                       current_user: dict = Depends(auth.get_current_user)):
    try:
        return await database.app.get_insights(current_user["id"], limit=limit)
    except Exception as e:
        logger.error(f"Failed to retrieve insights: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/memories", summary="List or search vector memories")
async def get_memories(q: str | None = None,
                       type: str | None = None,
                       limit: int = 50,
                       offset: int = 0,
                       current_user: dict = Depends(auth.get_current_user)):
    try:
        if q:
            settings = await Settings(current_user["id"]).load()
            api_key = settings.get("gemini_api_key", "")
            if not api_key:
                raise HTTPException(status_code=400, detail="Gemini API key not configured")
            embedding = await _embed_query(q, api_key)
            results = await database.vector.search(
                embedding, limit=20, user_id=current_user["id"],
                item_type=type or None)
            return {"items": results, "total": len(results)}
        page, total = await database.vector.get_all(
            current_user["id"], item_type=type, limit=limit, offset=offset)
        return {"items": page, "total": total}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to retrieve memories: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/processor/trigger", summary="Trigger Gemini processor to run immediately")
async def trigger_processor(
    current_user: dict = Depends(auth.get_current_user)
):
    try:
        prefs = await Settings(current_user["id"]).load()
        result = await process_pending_observations(current_user["id"], prefs)
        if result:
            event_id = await database.app.save_event(
                current_user["id"],
                result["timestamp"],
                result["summary"],
                result["raw_transcripts"],
                result["analysis_data"],
            )

            items = result.get("items", [])
            if items:
                for item in items:
                    item["metadata"]["user_event_id"] = str(event_id)
                await database.vector.add(items)
                logger.info("Indexed {} analysis items into vector DB", len(items))

            try:
                analysis = json.loads(result.get("analysis_data", "{}"))
                current_events = analysis.get("events", [])
                tip_data = await generate_proactive_tip(
                    current_user["id"], prefs,
                    current_events=current_events,
                    current_timestamp=result.get("timestamp"),
                )
                if tip_data:
                    await database.app.update_event_proactive_tip(
                        event_id, json.dumps(tip_data, ensure_ascii=False)
                    )
                    logger.info("Stored proactive tip for event {}", event_id)
            except Exception as e:
                logger.error("Failed to generate proactive tip: {}", e)

            logger.info("Saved event: {}", result["summary"][:100] + "...")
            return {"status": "ok", "summary": result["summary"][:100] + "..."}
        return {"status": "ok", "summary": "no new observations to process"}
    except Exception as e:
        logger.error(f"Failed to trigger processor: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ── Proactive Tips ─────────────────────────

@app.get("/api/proactive/tips", summary="List all proactive tips with pagination")
async def get_tips(limit: int = 50, offset: int = 0,
                   current_user: dict = Depends(auth.get_current_user)):
    try:
        items, total = await database.app.get_proactive_tips(
            current_user["id"], limit, offset
        )
        return {"items": items, "total": total}
    except Exception as e:
        logger.error(f"Failed to retrieve proactive tips: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/proactive/tip", summary="Generate a proactive tip matching goals to recent events")
async def generate_tip(current_user: dict = Depends(auth.get_current_user)):
    try:
        prefs = await Settings(current_user["id"]).load()
        tip_data = await generate_proactive_tip(current_user["id"], prefs)
        if tip_data:
            return {"status": "ok", "tip": tip_data}
        return {"status": "ok", "tip": None, "message": "No goals found to generate tip from."}
    except Exception as e:
        logger.error(f"Failed to generate proactive tip: {e}")
        raise HTTPException(status_code=500, detail=str(e))

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
        if not session.prefs.get("gemini_api_key") or not session.prefs.get("cartesia_api_key"):
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
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/webrtc/connect", summary="Receive trickle ICE candidates from client")
async def webrtc_patch(request: SmallWebRTCPatchRequest):
    await webrtc_handler.handle_patch_request(request)
    return {"status": "success"}

# ── Lifecycle ──────────────────────────────

@app.on_event("startup")
async def startup_event():

    async def heartbeat():
        count = 0
        while True:
            await asyncio.sleep(10)
            count += 1
            logger.info(f"[LOOP-HEARTBEAT #{count}] Event loop is alive")

    asyncio.create_task(heartbeat())

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
