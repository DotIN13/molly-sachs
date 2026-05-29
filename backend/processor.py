import os
import time
import asyncio
from google import genai
from google.genai import types
from loguru import logger
from dotenv import load_dotenv

load_dotenv()

DATA_DIR = os.path.join("..", "data", "observers")
os.makedirs(DATA_DIR, exist_ok=True)

TIPS_QUEUE = []

async def process_interval():
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        logger.warning("GEMINI_API_KEY not configured. Skipping background processing.")
        return None

    client = genai.Client(api_key=api_key)

    file_paths = []
    for f in os.listdir(DATA_DIR):
        fp = os.path.join(DATA_DIR, f)
        if f.endswith(".png") or f.endswith(".jpg") or f.endswith(".jpeg"):
            file_paths.append(fp)

    if not file_paths:
        logger.info("No new observations to process.")
        return None

    logger.info(f"Processing {len(file_paths)} observations with Gemini...")

    image_parts = []
    for fp in file_paths:
        try:
            with open(fp, "rb") as f:
                image_parts.append(types.Part.from_bytes(
                    data=f.read(),
                    mime_type="image/jpeg",
                ))
        except Exception as e:
            logger.error(f"Failed to read observation file {fp}: {e}")

    if not image_parts:
        logger.warning("No valid images loaded. Cleaning up directory.")
        for f in file_paths:
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

    contents = [prompt] + image_parts

    try:
        logger.info("Generating workspace summary...")
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model='gemini-3.1-flash-lite',
                contents=contents,
            ), timeout=60
        )
        summary = response.text
        logger.info(f"Generated Workspace Summary: {summary}")

        tip_prompt = f"Based on this activity: '{summary}', what is a helpful, proactive 1-sentence tip you can give the user right now? If they are coding, maybe suggest taking a break or a coding tip. If they are browsing, maybe something relevant. Be very brief and friendly."
        tip_response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model='gemini-3.1-flash-lite',
                contents=tip_prompt,
            ), timeout=30
        )
        tip = tip_response.text
        TIPS_QUEUE.append(tip)
        logger.info(f"Generated Proactive Tip: {tip}")

        embed_response = await asyncio.wait_for(
            client.aio.models.embed_content(
                model='gemini-embedding-2',
                contents=summary,
            ), timeout=30
        )
        embedding = embed_response.embeddings[0].values

        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        raw_transcripts = str([os.path.basename(f) for f in file_paths])

        for f in file_paths:
            try:
                os.remove(f)
            except Exception:
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
