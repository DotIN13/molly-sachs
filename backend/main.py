import os
import sys
import asyncio
import base64
import time
import uuid
import datetime
from loguru import logger
from cryptography.fernet import Fernet

# FastAPI & Pydantic
from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# WebRTC request handler
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
    SmallWebRTCPatchRequest
)

# Core Pipecat session setup
from bot import start_pipecat_session
from processor import process_interval
import database
import config
from db import settings

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Configure logging
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

# Enable CORS for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

# Ensure observations directories exist and mount static route
os.makedirs(config.OBSERVATIONS_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=config.DATA_DIR), name="static")

# Shared global state injected into custom bot processors
global_state = {
    "voice_mode": False,
    "speak_text": True
}

webrtc_handler = SmallWebRTCRequestHandler(esp32_mode=False)

# --- FastAPI Models ---

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
    observer_capture_interval: int | None = None
    observer_process_interval: int | None = None

# --- REST Endpoints ---

@app.post("/api/settings", summary="Save user API keys and speech preferences")
async def save_settings(req: SettingsReq):
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
    if req.observer_process_interval is not None:
        data["observer_process_interval"] = str(req.observer_process_interval)

    await settings.settings.save("default", data)
    return {"status": "ok"}

@app.get("/api/settings", summary="Retrieve active API keys and speech preferences")
async def get_settings():
    s = settings.settings
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
        "observer_process_interval": int(s.get("observer_process_interval", "300")),
        "debug": s.get("debug", "false").lower() == "true",
    }

@app.get("/api/health", summary="Health check endpoint for active frontend connectivity")
async def health_check():
    return {"status": "healthy"}

@app.post("/api/state", summary="Update voice mode and speaker state")
async def update_state(req: StateConfigReq):
    global_state["voice_mode"] = req.voice_mode
    global_state["speak_text"] = req.speak_text
    logger.info(f"Updated global state: {global_state}")
    return {"status": "ok", "state": global_state}

@app.get("/api/state", summary="Get current voice mode and speaker state")
async def get_state():
    return global_state

# --- Observations & Insights Endpoints ---

class ObservationUploadReq(BaseModel):
    type: str          # 'screen' or 'camera'
    image_base64: str  # JPEG base64
    timestamp: str | None = None

@app.post("/api/observations", summary="Receive observer base64 capture and save files")
async def upload_observation(req: ObservationUploadReq):
    try:
        data_str = req.image_base64
        if "," in data_str:
            data_str = data_str.split(",")[1]
        
        image_bytes = base64.b64decode(data_str)
        
        timestamp_str = req.timestamp or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        safe_ts = timestamp_str.replace(":", "-").replace("Z", "").replace("T", "_")
        filename = f"{req.type}_{safe_ts}_{uuid.uuid4().hex[:6]}.jpg"
        
        # Save 1: Permanent History
        os.makedirs(config.OBSERVATIONS_DIR, exist_ok=True)
        history_path = os.path.join(config.OBSERVATIONS_DIR, filename)
        with open(history_path, "wb") as f:
            f.write(image_bytes)
            
        # Save 2: Monitored Directory for Gemini Processor
        os.makedirs(config.OBSERVERS_DIR, exist_ok=True)
        monitored_path = os.path.join(config.OBSERVERS_DIR, filename)
        with open(monitored_path, "wb") as f:
            f.write(image_bytes)
            
        db_image_path = f"observations/{filename}"
        await database.app.save_observation(req.type, db_image_path, timestamp_str)
        
        return {"status": "ok", "filename": filename, "db_path": db_image_path}
    except Exception as e:
        logger.error(f"Failed to upload observation: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/observations", summary="Retrieve past observations list")
async def get_observations(type: str | None = None, limit: int = 15):
    try:
        return await database.app.get_observations(obs_type=type, limit=limit)
    except Exception as e:
        logger.error(f"Failed to retrieve observations: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/insights", summary="Retrieve past Gemini summaries and activity insights")
async def get_insights(limit: int = 15):
    try:
        return await database.app.get_insights(limit=limit)
    except Exception as e:
        logger.error(f"Failed to retrieve insights: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/processor/trigger", summary="Trigger Gemini processor to run immediately")
async def trigger_processor():
    try:
        result = await process_interval()
        if result:
            event_id = await database.app.save_event(
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
                }])
            logger.info(f"Successfully saved event to database: {result['summary'][:100] + '...'}")
            return {"status": "ok", "summary": result["summary"][:100] + "..."}
        return {"status": "ok", "summary": "no new observations to process"}
    except Exception as e:
        logger.error(f"Failed to trigger processor: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- Conversation Endpoints ---

class ConversationCreateReq(BaseModel):
    id: str | None = None
    title: str | None = None

@app.post("/api/conversations", summary="Create a new conversation session")
async def api_create_conversation(req: ConversationCreateReq):
    conv_id = req.id or str(uuid.uuid4())
    title = req.title or database.default_conversation_title()
    await database.app.create_conversation(conv_id, title)
    return {"id": conv_id, "title": title}

@app.get("/api/conversations", summary="Retrieve all past conversations")
async def api_get_conversations():
    return await database.app.get_conversations()

@app.get("/api/conversations/{conversation_id}/messages", summary="Retrieve messages in a past session")
async def api_get_messages(conversation_id: str):
    return await database.app.get_messages(conversation_id)

@app.delete("/api/conversations/{conversation_id}", summary="Delete a past conversation session")
async def api_delete_conversation(conversation_id: str):
    await database.app.delete_conversation(conversation_id)
    return {"status": "ok"}

# --- WebRTC Endpoints ---

@app.post("/api/webrtc/connect", summary="Handle WebRTC connection offer")
async def webrtc_connect(request: SmallWebRTCRequest, background_tasks: BackgroundTasks, conversation_id: str | None = None):
    try:
        if not settings.settings.get("gemini_api_key") or not settings.settings.get("cartesia_api_key"):
            raise HTTPException(status_code=400, detail="Missing API keys in server.")

        conv_id = conversation_id or str(uuid.uuid4())
        # Ensure conversation entry exists
        await database.app.create_conversation(conv_id, database.default_conversation_title())

        async def webrtc_connection_callback(connection: SmallWebRTCConnection):
            background_tasks.add_task(start_pipecat_session, connection, global_state, conv_id)

        answer = await webrtc_handler.handle_web_request(
            request=request,
            webrtc_connection_callback=webrtc_connection_callback
        )
        return answer
    except Exception as e:
        logger.error(f"WebRTC connection error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.patch("/api/webrtc/connect", summary="Receive trickle ICE candidates from client")
async def webrtc_patch(request: SmallWebRTCPatchRequest):
    await webrtc_handler.handle_patch_request(request)
    return {"status": "success"}

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

    if not config.fernet_key():
        key = Fernet.generate_key().decode()
        os.environ["FERNET_KEY"] = key
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
        with open(env_path, "a") as f:
            f.write(f"\nFERNET_KEY={key}\n")
        logger.info("Generated new FERNET_KEY and appended to .env")

    await settings.settings.load()
    logger.info("Server startup complete")

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Server shutting down, closing WebRTC handler")
    await webrtc_handler.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
