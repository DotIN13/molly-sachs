import os
import sys
import asyncio
import base64
import json
import time
import uuid
import secrets
import datetime
from datetime import timedelta, timezone
from loguru import logger
from cryptography.fernet import Fernet

from fastapi import FastAPI, BackgroundTasks, HTTPException, Depends
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
    SmallWebRTCPatchRequest
)

from bot import start_pipecat_session
from processor import process_pending_observations
import database
import config
from db.settings import Settings
import auth
import mailer

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

logger.remove(0)
if config.is_debug():
    logger.add(sys.stderr, level="DEBUG")
else:
    logger.add(sys.stderr, level="INFO")

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
app.mount("/static", StaticFiles(directory=config.DATA_DIR), name="static")

# Per-user voice/speaker state
global_states: dict[str, dict] = {}

webrtc_handler = SmallWebRTCRequestHandler(esp32_mode=False)

# ── FastAPI Models ───────────────────────────

class StateConfigReq(BaseModel):
    voice_mode: bool
    speak_text: bool

class SettingsReq(BaseModel):
    gemini_api_key: str
    cartesia_api_key: str
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
    observer_capture_interval: int | None = None  # deprecated — kept for compat
    observer_process_interval: int | None = None

class RegisterReq(BaseModel):
    email: str
    password: str
    name: str | None = None

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


def _get_user_state(user_id: str) -> dict:
    if user_id not in global_states:
        global_states[user_id] = {"voice_mode": False, "speak_text": True}
    return global_states[user_id]


# ── Auth Endpoints ──────────────────────────

@app.post("/api/auth/register", summary="Register a new user account")
async def register(req: RegisterReq):
    existing = await database.app.get_user_by_email(req.email)
    if existing:
        if existing.get("email_verified"):
            raise HTTPException(status_code=409, detail="Email already registered")
        # Unverified — remove stale account so user can re-register
        await database.app.delete_user(existing["id"])

    password_hash = auth.hash_password(req.password)
    user = await database.app.create_user(req.email, password_hash, req.name)

    code = secrets.token_hex(3)[:6]
    expires = (datetime.datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    await database.app.set_verification_code(user["id"], code, expires)

    await mailer.send_verification_email(req.email, code)

    return {"status": "ok", "message": "Verification code sent to email",
            "user_id": user["id"]}


@app.post("/api/auth/verify", summary="Verify email with code and receive tokens")
async def verify_email(req: VerifyReq):
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
async def login(req: LoginReq):
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
async def resend_verification(req: ResendReq):
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
    data: dict = {
        "gemini_api_key": req.gemini_api_key,
        "cartesia_api_key": req.cartesia_api_key,
    }
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
    if req.observer_capture_interval is not None:
        data["observer_capture_interval"] = str(req.observer_capture_interval)
    if req.observer_screen_interval is not None:
        data["observer_screen_interval"] = str(req.observer_screen_interval)
    if req.observer_camera_interval is not None:
        data["observer_camera_interval"] = str(req.observer_camera_interval)
    if req.observer_process_interval is not None:
        data["observer_process_interval"] = str(req.observer_process_interval)

    await Settings(current_user["id"]).save(data)
    return {"status": "ok"}


@app.get("/api/settings", summary="Retrieve active API keys and speech preferences")
async def get_settings(current_user: dict = Depends(auth.get_current_user)):
    s = await Settings(current_user["id"]).load()
    return {
        "gemini_api_key": s.get("gemini_api_key", ""),
        "cartesia_api_key": s.get("cartesia_api_key", ""),
        "soniox_api_key": s.get("soniox_api_key", ""),
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
    }

# ── Health ──────────────────────────────────

@app.get("/api/health", summary="Health check endpoint")
async def health_check():
    return {"status": "healthy"}

# ── State ───────────────────────────────────

@app.post("/api/state", summary="Update voice mode and speaker state")
async def update_state(req: StateConfigReq,
                       current_user: dict = Depends(auth.get_current_user)):
    state = _get_user_state(current_user["id"])
    state["voice_mode"] = req.voice_mode
    state["speak_text"] = req.speak_text
    logger.info("Updated state for user {}: {}", current_user["id"][:8], state)
    return {"status": "ok", "state": state}


@app.get("/api/state", summary="Get current voice mode and speaker state")
async def get_state(current_user: dict = Depends(auth.get_current_user)):
    return _get_user_state(current_user["id"])

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


@app.get("/api/insights", summary="Retrieve past Gemini summaries and activity insights")
async def get_insights(limit: int = 15,
                       current_user: dict = Depends(auth.get_current_user)):
    try:
        return await database.app.get_insights(current_user["id"], limit=limit)
    except Exception as e:
        logger.error(f"Failed to retrieve insights: {e}")
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
                result["tip"],
            )
            embedding = result["embedding"]
            if embedding:
                await database.vector.add([{
                    "id": event_id,
                    "timestamp": result["timestamp"],
                    "summary": result["summary"],
                    "vector": embedding,
                    "user_id": current_user["id"],
                }])
            logger.info("Saved event: {}", result["summary"][:100] + "...")
            return {"status": "ok", "summary": result["summary"][:100] + "..."}
        return {"status": "ok", "summary": "no new observations to process"}
    except Exception as e:
        logger.error(f"Failed to trigger processor: {e}")
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

        prefs = await Settings(user["id"]).load()
        if not prefs.get("gemini_api_key") or not prefs.get("cartesia_api_key"):
            raise HTTPException(status_code=400, detail="Missing API keys. Configure in Settings.")

        conv_id = conversation_id or str(uuid.uuid4())
        await database.app.create_conversation(conv_id, database.default_conversation_title(), user["id"])

        user_state = _get_user_state(user["id"])

        async def webrtc_connection_callback(connection: SmallWebRTCConnection):
            background_tasks.add_task(
                start_pipecat_session, connection, user_state, conv_id,
                user["id"], prefs
            )

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
    auth._get_secret()  # ensure JWT_SECRET exists

    if not config.fernet_key():
        key = Fernet.generate_key().decode()
        os.environ["FERNET_KEY"] = key
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
        with open(env_path, "a") as f:
            f.write(f"\nFERNET_KEY={key}\n")
        logger.info("Generated new FERNET_KEY and appended to .env")

    logger.info("Server startup complete")


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Server shutting down, closing WebRTC handler")
    await webrtc_handler.close()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
