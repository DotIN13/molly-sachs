import os
import sys
import base64
import time
from loguru import logger
from dotenv import load_dotenv

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
import uuid
import datetime
import database

load_dotenv()

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Configure logging
logger.remove(0)
if os.environ.get("DEBUG", "false").lower() == "true":
    logger.add(sys.stderr, level="DEBUG")
else:
    logger.add(sys.stderr, level="INFO")

app = FastAPI(
    title="Molly Sachs Assistant Backend",
    description="FastAPI WebRTC server hosting real-time Pipecat sessions with Gemini & Cartesia.",
    version="1.0.0"
)

# Enable CORS for frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

# Ensure observations directories exist and mount static route
os.makedirs("data/observations", exist_ok=True)
app.mount("/static", StaticFiles(directory="data"), name="static")

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
    input_device: int | None = None
    output_device: int | None = None
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

@app.post("/api/settings", summary="Save user API keys and speech preferences to .env")
async def save_settings(req: SettingsReq):
    os.environ["GEMINI_API_KEY"] = req.gemini_api_key
    os.environ["CARTESIA_API_KEY"] = req.cartesia_api_key
    if req.soniox_api_key is not None:
        os.environ["SONIOX_API_KEY"] = req.soniox_api_key
    if req.input_device is not None:
        os.environ["AUDIO_INPUT_DEVICE"] = str(req.input_device)
    if req.output_device is not None:
        os.environ["AUDIO_OUTPUT_DEVICE"] = str(req.output_device)
    if req.tts_voice is not None:
        os.environ["CARTESIA_VOICE"] = req.tts_voice
    if req.tts_volume is not None:
        os.environ["CARTESIA_VOLUME"] = str(req.tts_volume)
    if req.tts_speed is not None:
        os.environ["CARTESIA_SPEED"] = str(req.tts_speed)
    if req.tts_emotion is not None:
        os.environ["CARTESIA_EMOTION"] = req.tts_emotion
    if req.stt_language is not None:
        os.environ["STT_LANGUAGE"] = req.stt_language
    if req.stt_provider is not None:
        os.environ["STT_PROVIDER"] = req.stt_provider
    if req.tts_language is not None:
        os.environ["CARTESIA_TTS_LANGUAGE"] = req.tts_language
    if req.observer_screen_active is not None:
        os.environ["OBSERVER_SCREEN_ACTIVE"] = "true" if req.observer_screen_active else "false"
    if req.observer_camera_active is not None:
        os.environ["OBSERVER_CAMERA_ACTIVE"] = "true" if req.observer_camera_active else "false"
    if req.observer_capture_interval is not None:
        os.environ["OBSERVER_CAPTURE_INTERVAL"] = str(req.observer_capture_interval)
    if req.observer_process_interval is not None:
        os.environ["OBSERVER_PROCESS_INTERVAL"] = str(req.observer_process_interval)
        
    with open(".env", "w") as f:
        f.write(f"GEMINI_API_KEY={req.gemini_api_key}\n")
        f.write(f"CARTESIA_API_KEY={req.cartesia_api_key}\n")
        if req.soniox_api_key is not None:
            f.write(f"SONIOX_API_KEY={req.soniox_api_key}\n")
        if req.input_device is not None:
            f.write(f"AUDIO_INPUT_DEVICE={req.input_device}\n")
        if req.output_device is not None:
            f.write(f"AUDIO_OUTPUT_DEVICE={req.output_device}\n")
        if req.tts_voice is not None:
            f.write(f"CARTESIA_VOICE={req.tts_voice}\n")
        if req.tts_volume is not None:
            f.write(f"CARTESIA_VOLUME={req.tts_volume}\n")
        if req.tts_speed is not None:
            f.write(f"CARTESIA_SPEED={req.tts_speed}\n")
        if req.tts_emotion is not None:
            f.write(f"CARTESIA_EMOTION={req.tts_emotion}\n")
        if req.stt_language is not None:
            f.write(f"STT_LANGUAGE={req.stt_language}\n")
        if req.stt_provider is not None:
            f.write(f"STT_PROVIDER={req.stt_provider}\n")
        if req.tts_language is not None:
            f.write(f"CARTESIA_TTS_LANGUAGE={req.tts_language}\n")
        if req.observer_screen_active is not None:
            f.write(f"OBSERVER_SCREEN_ACTIVE={'true' if req.observer_screen_active else 'false'}\n")
        if req.observer_camera_active is not None:
            f.write(f"OBSERVER_CAMERA_ACTIVE={'true' if req.observer_camera_active else 'false'}\n")
        if req.observer_capture_interval is not None:
            f.write(f"OBSERVER_CAPTURE_INTERVAL={req.observer_capture_interval}\n")
        if req.observer_process_interval is not None:
            f.write(f"OBSERVER_PROCESS_INTERVAL={req.observer_process_interval}\n")
            
    return {"status": "ok"}

@app.get("/api/settings", summary="Retrieve active API keys and speech preferences")
async def get_settings():
    input_device = os.environ.get("AUDIO_INPUT_DEVICE")
    output_device = os.environ.get("AUDIO_OUTPUT_DEVICE")
    tts_volume = os.environ.get("CARTESIA_VOLUME")
    tts_speed = os.environ.get("CARTESIA_SPEED")
    screen_active = os.environ.get("OBSERVER_SCREEN_ACTIVE", "false").lower() == "true"
    camera_active = os.environ.get("OBSERVER_CAMERA_ACTIVE", "false").lower() == "true"
    capture_interval = os.environ.get("OBSERVER_CAPTURE_INTERVAL")
    process_interval = os.environ.get("OBSERVER_PROCESS_INTERVAL")
    return {
        "gemini_api_key": os.environ.get("GEMINI_API_KEY", ""),
        "cartesia_api_key": os.environ.get("CARTESIA_API_KEY", ""),
        "soniox_api_key": os.environ.get("SONIOX_API_KEY", ""),
        "input_device": int(input_device) if input_device else None,
        "output_device": int(output_device) if output_device else None,
        "tts_voice": os.environ.get("CARTESIA_VOICE", "79a125e8-cd45-4c13-8a67-188112f4dd22"),
        "tts_volume": float(tts_volume) if tts_volume else 1.0,
        "tts_speed": float(tts_speed) if tts_speed else 1.0,
        "tts_emotion": os.environ.get("CARTESIA_EMOTION", "neutral"),
        "stt_language": os.environ.get("STT_LANGUAGE", "zh"),
        "stt_provider": os.environ.get("STT_PROVIDER", "soniox"),
        "tts_language": os.environ.get("CARTESIA_TTS_LANGUAGE", "en"),
        "observer_screen_active": screen_active,
        "observer_camera_active": camera_active,
        "observer_capture_interval": int(capture_interval) if capture_interval else 60,
        "observer_process_interval": int(process_interval) if process_interval else 300,
        "debug": os.environ.get("DEBUG", "false").lower() == "true"
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
        
        # Save 1: Permanent History in data/observations/
        history_dir = os.path.join("data", "observations")
        os.makedirs(history_dir, exist_ok=True)
        history_path = os.path.join(history_dir, filename)
        with open(history_path, "wb") as f:
            f.write(image_bytes)
            
        # Save 2: Monitored Directory for Gemini Processor in ../frontend/data/observers
        monitored_dir = os.path.join("..", "frontend", "data", "observers")
        os.makedirs(monitored_dir, exist_ok=True)
        monitored_path = os.path.join(monitored_dir, filename)
        with open(monitored_path, "wb") as f:
            f.write(image_bytes)
            
        db_image_path = f"observations/{filename}"
        database.save_observation(req.type, db_image_path, timestamp_str)
        
        return {"status": "ok", "filename": filename, "db_path": db_image_path}
    except Exception as e:
        logger.error(f"Failed to upload observation: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/observations", summary="Retrieve past observations list")
async def get_observations(type: str | None = None, limit: int = 15):
    try:
        return database.get_observations(obs_type=type, limit=limit)
    except Exception as e:
        logger.error(f"Failed to retrieve observations: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/insights", summary="Retrieve past Gemini summaries and activity insights")
async def get_insights(limit: int = 15):
    try:
        return database.get_insights(limit=limit)
    except Exception as e:
        logger.error(f"Failed to retrieve insights: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/processor/trigger", summary="Trigger Gemini processor to run immediately")
async def trigger_processor():
    try:
        from processor import process_interval
        import asyncio
        result = await asyncio.to_thread(process_interval)
        if result:
            import database
            database.save_event(
                result["timestamp"],
                result["summary"],
                result["raw_transcripts"],
                result["tip"],
                result["embedding"],
            )
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
    database.create_conversation(conv_id, title)
    return {"id": conv_id, "title": title}

@app.get("/api/conversations", summary="Retrieve all past conversations")
async def api_get_conversations():
    return database.get_conversations()

@app.get("/api/conversations/{conversation_id}/messages", summary="Retrieve messages in a past session")
async def api_get_messages(conversation_id: str):
    return database.get_messages(conversation_id)

@app.delete("/api/conversations/{conversation_id}", summary="Delete a past conversation session")
async def api_delete_conversation(conversation_id: str):
    database.delete_conversation(conversation_id)
    return {"status": "ok"}

# --- WebRTC Endpoints ---

@app.post("/api/webrtc/connect", summary="Handle WebRTC connection offer")
async def webrtc_connect(request: SmallWebRTCRequest, background_tasks: BackgroundTasks, conversation_id: str | None = None):
    try:
        if not os.environ.get("GEMINI_API_KEY") or not os.environ.get("CARTESIA_API_KEY"):
            raise HTTPException(status_code=400, detail="Missing API keys in server.")

        conv_id = conversation_id or str(uuid.uuid4())
        # Ensure conversation entry exists
        database.create_conversation(conv_id, database.default_conversation_title())

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
    import asyncio
    from processor import processor_loop

    async def heartbeat():
        count = 0
        while True:
            await asyncio.sleep(10)
            count += 1
            logger.info(f"[LOOP-HEARTBEAT #{count}] Event loop is alive")

    asyncio.create_task(heartbeat())

    logger.info("Starting background Gemini processor task...")
    asyncio.create_task(processor_loop())

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Server shutting down, closing WebRTC handler")
    await webrtc_handler.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
