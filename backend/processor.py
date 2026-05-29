import os
import time
import asyncio
from google import genai
from google.genai import types
from loguru import logger
import database
from dotenv import load_dotenv

load_dotenv()

DATA_DIR = os.path.join("..", "frontend", "data", "observers")
os.makedirs(DATA_DIR, exist_ok=True)

TIPS_QUEUE = []

def process_interval():
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        logger.warning("GEMINI_API_KEY not configured. Skipping background processing.")
        return None

    client = genai.Client(api_key=api_key)

    files = []
    for f in os.listdir(DATA_DIR):
        files.append(os.path.join(DATA_DIR, f))
    
    if not files:
        logger.info("No new observations to process.")
        return None

    logger.info(f"Processing {len(files)} observations with Gemini...")

    uploaded_files = []
    for fpath in files:
        if fpath.endswith(".png") or fpath.endswith(".jpg") or fpath.endswith(".webm") or fpath.endswith(".wav"):
            try:
                uploaded_file = client.files.upload(file=fpath)
                uploaded_files.append(uploaded_file)
            except Exception as e:
                logger.error(f"Failed to upload observation file {fpath}: {e}")

    if not uploaded_files:
        logger.warning("No valid files successfully uploaded to Gemini. Cleaning up directory.")
        for f in files:
            try:
                os.remove(f)
            except Exception:
                pass
        return None

    prompt = (
        "You are Molly, a personal AI companion analyzing what the user is doing right now. "
        "Here are the screenshots and camera pictures from the last few minutes. "
        "Write a concise summary of the user's activities, focusing on context, apps used, desktop states, and general intent."
    )

    contents = [prompt] + uploaded_files

    try:
        response = client.models.generate_content(
            model='gemini-3.1-flash-lite',
            contents=contents,
        )
        summary = response.text
        logger.info(f"Generated Workspace Summary: {summary}")

        tip_prompt = f"Based on this activity: '{summary}', what is a helpful, proactive 1-sentence tip you can give the user right now? If they are coding, maybe suggest taking a break or a coding tip. If they are browsing, maybe something relevant. Be very brief and friendly."
        tip_response = client.models.generate_content(
            model='gemini-3.1-flash-lite',
            contents=tip_prompt,
        )
        tip = tip_response.text
        TIPS_QUEUE.append(tip)
        logger.info(f"Generated Proactive Tip: {tip}")

        embed_response = client.models.embed_content(
            model='gemini-embedding-2',
            contents=summary,
        )
        embedding = embed_response.embeddings[0].values

        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        raw_transcripts = str([os.path.basename(f) for f in files])

        for f in uploaded_files:
            try:
                client.files.delete(name=f.name)
            except Exception as e:
                logger.error(f"Failed to delete Gemini file {f.name}: {e}")
        for f in files:
            try:
                os.remove(f)
            except Exception as e:
                pass

        return {
            "timestamp": timestamp,
            "summary": summary,
            "raw_transcripts": raw_transcripts,
            "tip": tip,
            "embedding": embedding,
        }

    except Exception as e:
        logger.error(f"Error during Gemini processing run: {e}")
        return None


async def processor_loop():
    logger.info("Initializing Gemini background processor loop...")
    while True:
        interval = int(os.environ.get("OBSERVER_PROCESS_INTERVAL", "300"))
        screen_active = os.environ.get("OBSERVER_SCREEN_ACTIVE", "false").lower() == "true"
        camera_active = os.environ.get("OBSERVER_CAMERA_ACTIVE", "false").lower() == "true"

        logger.debug(f"[HEARTBEAT] Processor loop cycle — screen={screen_active} camera={camera_active} interval={interval}s")

        if screen_active or camera_active:
            logger.info("Observers are active. Triggering periodic observations analysis...")
            try:
                result = await asyncio.to_thread(process_interval)
                if result:
                    logger.debug("Saving processor result to database on event loop thread...")
                    database.save_event(
                        result["timestamp"],
                        result["summary"],
                        result["raw_transcripts"],
                        result["tip"],
                        result["embedding"],
                    )
            except Exception as e:
                logger.error(f"Error in background processor loop execution: {e}")
        else:
            logger.debug("Observers are inactive. Skipping Gemini processor run.")

        logger.debug(f"[HEARTBEAT] Processor sleeping for {interval}s...")
        await asyncio.sleep(interval)


if __name__ == "__main__":
    asyncio.run(processor_loop())
