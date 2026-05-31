import os
import json
import time
import asyncio
from google import genai
from google.genai import types
from loguru import logger
import database
import config

TIPS_QUEUE = []


async def process_pending_observations(user_id: str, prefs: dict[str, str]) -> dict | None:
    api_key = prefs.get("gemini_api_key", "").strip()
    if not api_key:
        logger.warning("GEMINI_API_KEY not configured. Skipping background processing.")
        return None

    client = genai.Client(api_key=api_key)

    rows = await database.app.get_unprocessed_observations(user_id)
    if not rows:
        return None

    logger.info("Processing {} unprocessed observations for user {}...",
                len(rows), user_id[:8])

    def _artefact_to_entry(p: str) -> str:
        return p.replace("/artefacts/", "/entries/").rsplit(".", 1)[0] + ".json"

    image_paths = []
    all_windows = set()
    for row in rows:
        image_path = row["image_path"]
        image_paths.append(image_path)

        entry_rel = _artefact_to_entry(image_path)
        entry_abs = os.path.join(config.DATA_DIR, entry_rel)

        if os.path.exists(entry_abs):
            with open(entry_abs, "r", encoding="utf-8") as f:
                entry = json.load(f)
            if entry.get("type") == "screen":
                windows = entry.get("windows") or []
                all_windows.update(windows)

    deduped_text = ""
    if all_windows:
        win_list = "\n  ".join(sorted(all_windows))
        deduped_text = f"Open windows in the screenshots:\n  {win_list}"

    contents = [
        "You are Molly, a personal AI companion analyzing what the user is doing right now. "
        "Here are the screenshots and camera pictures from the last few minutes. "
        "Write a concise summary of the user's activities, focusing on context, apps used, "
        "desktop states, and general intent."
        + (f"\n\n{deduped_text}" if deduped_text else "")
    ]

    for image_path in image_paths:
        artefact_abs = os.path.join(config.DATA_DIR, image_path)
        if os.path.exists(artefact_abs):
            with open(artefact_abs, "rb") as f:
                contents.append(types.Part.from_bytes(
                    data=f.read(),
                    mime_type="image/jpeg",
                ))
        else:
            logger.warning("Artefact not found on disk: {}", artefact_abs)

    try:
        logger.info("Generating workspace summary...")
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model='gemini-3.1-flash-lite',
                contents=contents,
            ), timeout=60
        )
        summary = response.text
        logger.info("Generated Workspace Summary: {}", summary[:120])

        tip_prompt = (
            f"Based on this activity: '{summary}', what is a helpful, proactive "
            f"1-sentence tip you can give the user right now? If they are coding, "
            f"maybe suggest taking a break or a coding tip. If they are browsing, "
            f"maybe something relevant. Be very brief and friendly."
        )
        tip_response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model='gemini-3.1-flash-lite',
                contents=tip_prompt,
            ), timeout=30
        )
        tip = tip_response.text
        TIPS_QUEUE.append(tip)
        logger.info("Generated Proactive Tip: {}", tip[:120])

        embed_response = await asyncio.wait_for(
            client.aio.models.embed_content(
                model='gemini-embedding-2',
                contents=summary,
            ), timeout=30
        )
        embedding = embed_response.embeddings[0].values

        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        raw_transcripts = str([os.path.basename(p) for p in image_paths])

        await database.app.mark_observations_processed(image_paths)

        return {
            "timestamp": timestamp,
            "summary": summary,
            "raw_transcripts": raw_transcripts,
            "tip": tip,
            "embedding": embedding,
        }

    except Exception as e:
        logger.error("Error during Gemini processing run: {}", e)
        return None
