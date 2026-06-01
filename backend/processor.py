import os
import json
import time
import asyncio
from google import genai
from google.genai import types
from loguru import logger
import database
import config

_PROMPTS_DIR = os.path.join(os.path.dirname(__file__), "prompts")
_CONFIDENCE_THRESHOLD = int(os.environ.get("MOLLY_CONFIDENCE_THRESHOLD", "5"))


def _load_prompt() -> str:
    with open(os.path.join(_PROMPTS_DIR, "analysis_prompt.md"), "r", encoding="utf-8") as f:
        return f.read()


def _load_schema() -> dict:
    with open(os.path.join(_PROMPTS_DIR, "analysis_schema.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def _build_item(event_id: int, timestamp: str, user_id: str,
                item_type: str, item: dict, index: int) -> dict:
    content_key = item_type.rstrip("s")
    content = item.get(content_key, "")
    evidence = item.get("evidence", "")
    confidence = item.get("confidence", 0)

    return {
        "id": f"{event_id}_{item_type}_{index}",
        "vector": None,
        "metadata": {
            "type": content_key,
            "content": f"{content_key}: {content}",
            "timestamp": timestamp,
            "user_id": user_id,
            "user_event_id": str(event_id),
            "confidence": confidence,
            "evidence": evidence,
        },
    }


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

    windows_section = ""
    if all_windows:
        win_list = "\n  ".join(sorted(all_windows))
        windows_section = f"\n\nOpen windows visible in the screenshots:\n  {win_list}"

    prompt = _load_prompt().format(
        windows_section=windows_section,
    )

    contents = [prompt]

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
        logger.info("Generating structured analysis...")
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model='gemini-3.1-flash-lite',
                contents=contents,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_json_schema=_load_schema(),
                ),
            ), timeout=90
        )

        raw_text = response.text
        if not raw_text:
            logger.error("Empty response from Gemini")
            return None

        analysis = json.loads(raw_text)
        summary = analysis.get("summary", "")
        logger.info("Generated Summary: {}", summary[:120])

        analysis_json = json.dumps(analysis, ensure_ascii=False)

        categories = [
            "events", "personalities", "skills", "interests",
            "preferences", "ownerships", "relationships", "weaknesses", "goals",
        ]
        all_items = []
        for cat in categories:
            items = analysis.get(cat, [])
            if not items:
                continue
            for i, item in enumerate(items):
                if item.get("confidence", 0) >= _CONFIDENCE_THRESHOLD:
                    all_items.append((cat, item, i))

        logger.info("Extracted {} items across {} categories",
                    len(all_items), len(set(c[0] for c in all_items)))

        embed_task = asyncio.wait_for(
            client.aio.models.embed_content(
                model='gemini-embedding-2',
                contents=summary,
            ), timeout=30
        )

        item_texts = [item[1].get(item[0].rstrip("s"), "")
                      for item in all_items] if all_items else []
        if item_texts:
            items_embed_task = asyncio.wait_for(
                client.aio.models.embed_content(
                    model='gemini-embedding-2',
                    contents=item_texts,
                ), timeout=60
            )
            summary_embed, items_embed = await asyncio.gather(
                embed_task, items_embed_task
            )
        else:
            summary_embed = await embed_task
            items_embed = None

        summary_embedding = summary_embed.embeddings[0].values if summary_embed.embeddings else None

        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        raw_transcripts = str([os.path.basename(p) for p in image_paths])

        await database.app.mark_observations_processed(image_paths)

        item_records = []
        if items_embed and items_embed.embeddings:
            for idx, ((cat, item, i), embedding) in enumerate(
                zip(all_items, items_embed.embeddings)
            ):
                rec = _build_item(0, timestamp, user_id, cat, item, i)
                rec["vector"] = embedding.values
                item_records.append(rec)

        return {
            "timestamp": timestamp,
            "summary": summary,
            "analysis_data": analysis_json,
            "raw_transcripts": raw_transcripts,
            "embedding": summary_embedding,
            "items": item_records,
        }

    except json.JSONDecodeError as e:
        logger.error("Failed to parse Gemini JSON response: {}", e)
        logger.error("Raw response: {}", raw_text[:500] if 'raw_text' in dir() else "N/A")
        return None
    except Exception as e:
        logger.error("Error during Gemini processing run: {}", e)
        return None
