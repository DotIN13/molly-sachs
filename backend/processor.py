import os
import json
import time
import uuid
import asyncio
from dataclasses import dataclass
from google import genai
from google.genai import types
from loguru import logger
import database
import config

_PROMPTS_DIR = os.path.join(os.path.dirname(__file__), "prompts")
_CONFIDENCE_THRESHOLD = int(os.environ.get("MOLLY_CONFIDENCE_THRESHOLD", "5"))
_MAX_ARTEFACTS = int(os.environ.get("MOLLY_MAX_ARTEFACTS", "20"))
_MERGE_THRESHOLD = float(os.environ.get("MOLLY_MERGE_THRESHOLD", "0.85"))
_MAX_EVIDENCE_ENTRIES = 10


def _load_prompt() -> str:
    with open(os.path.join(_PROMPTS_DIR, "analysis_prompt.md"), "r", encoding="utf-8") as f:
        return f.read()


def _load_schema() -> dict:
    with open(os.path.join(_PROMPTS_DIR, "analysis_schema.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def _wrap_evidence(evidence_text: str, timestamp: str) -> str:
    return json.dumps(
        [{"text": evidence_text, "timestamp": timestamp}],
        ensure_ascii=False,
    )


def _merge_evidence(existing_json: str | None, new_json: str) -> str:
    existing = []
    if existing_json:
        try:
            parsed = json.loads(existing_json)
            if isinstance(parsed, list):
                existing = parsed
            else:
                existing = [{"text": str(parsed), "timestamp": ""}]
        except (json.JSONDecodeError, TypeError):
            pass

    try:
        new_entries = json.loads(new_json)
        if not isinstance(new_entries, list):
            new_entries = [{"text": str(new_entries), "timestamp": ""}]
    except (json.JSONDecodeError, TypeError):
        new_entries = [{"text": str(new_json), "timestamp": ""}]

    merged = existing + new_entries
    if len(merged) > _MAX_EVIDENCE_ENTRIES:
        merged = merged[-_MAX_EVIDENCE_ENTRIES:]

    return json.dumps(merged, ensure_ascii=False)


@dataclass
class _ItemEntry:
    """A single analysis item extracted from the Gemini response, ready for embedding
    and ingestion.  category is the plural array key (e.g. "personalities"),
    content_key is the singular dict key (e.g. "personality")."""
    category: str
    index: int
    item: dict

    @property
    def content_key(self) -> str:
        return self.category.rstrip("s")

    @property
    def content_text(self) -> str:
        return self.item.get(self.content_key, "").strip()

    @property
    def confidence(self) -> int:
        return self.item.get("confidence", 0)

    @property
    def evidence(self) -> str:
        return self.item.get("evidence", "")

    @property
    def lifespan(self) -> int:
        return self.item.get("lifespan", 0)


def _build_item_record(entry: _ItemEntry, event_id: int, timestamp: str, user_id: str) -> dict:
    """Build a ChromaDB-ready item record from an _ItemEntry."""
    return {
        "id": f"{entry.category}_{entry.index}_{uuid.uuid4().hex[:8]}",
        "vector": None,
        "category": entry.category,
        "index": entry.index,
        "metadata": {
            "type": entry.content_key,
            "content": f"{entry.content_key}: {entry.content_text}",
            "timestamp": timestamp,
            "user_id": user_id,
            "user_event_id": str(event_id),
            "confidence": entry.confidence,
            "evidence": entry.evidence,
            "lifespan": entry.lifespan,
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

    if len(rows) > _MAX_ARTEFACTS:
        skipped = rows[:-_MAX_ARTEFACTS]
        skipped_paths = [r["image_path"] for r in skipped]
        await database.app.mark_observations_processed(skipped_paths)
        logger.info("Skipped {} older observations to keep context under {} artefacts",
                    len(skipped), _MAX_ARTEFACTS)
        rows = rows[-_MAX_ARTEFACTS:]

    logger.info("Processing {} unprocessed observations for user {}...",
                len(rows), user_id[:8])

    def _artefact_to_entry(p: str) -> str:
        return p.replace("/artefacts/", "/entries/").rsplit(".", 1)[0] + ".json"

    image_paths = []
    all_windows = set()
    latest_screen_entry = None
    latest_screen_image_path = None
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
                latest_screen_entry = entry
                latest_screen_image_path = image_path

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

        categories = [
            "events", "personalities", "skills", "interests",
            "preferences", "ownerships", "relationships", "weaknesses",
        ]

        analysis_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for cat in categories:
            for item in analysis.get(cat, []):
                evidence_text = item.get("evidence", "")
                if evidence_text and not evidence_text.startswith("["):
                    item["evidence"] = _wrap_evidence(evidence_text, analysis_ts)

        entries: list[_ItemEntry] = []
        for cat in categories:
            items = analysis.get(cat, [])
            for i, item in enumerate(items):
                entry = _ItemEntry(category=cat, index=i, item=item)
                if entry.confidence >= _CONFIDENCE_THRESHOLD and entry.content_text:
                    entries.append(entry)

        logger.info("Extracted {} items across {} categories",
                    len(entries), len({e.category for e in entries}))

        item_texts = [e.content_text for e in entries]
        if item_texts:
            items_embed_tasks = [
                asyncio.wait_for(
                    client.aio.models.embed_content(
                        model='gemini-embedding-2',
                        contents=text,
                    ), timeout=30
                )
                for text in item_texts
            ]
            items_embeds = await asyncio.gather(*items_embed_tasks)
        else:
            items_embeds = []

        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        raw_transcripts = str([os.path.basename(p) for p in image_paths])

        await database.app.mark_observations_processed(image_paths)

        item_records = []
        for entry, embed_resp in zip(entries, items_embeds):
            if embed_resp and embed_resp.embeddings:
                rec = _build_item_record(entry, 0, timestamp, user_id)
                rec["vector"] = embed_resp.embeddings[0].values
                item_records.append(rec)

        # Merge similar propositions into existing entries, skip duplicates.
        # Also update analysis dict so the JSON saved to SQLite reflects merged state.
        merged_count = 0
        deduped_records = []
        for rec in item_records:
            meta = rec["metadata"]
            if meta["type"] == "event":
                deduped_records.append(rec)
                continue
            existing, sim, candidates = await database.vector.find_similar(
                rec["vector"], meta["type"], user_id, _MERGE_THRESHOLD
            )
            target = meta.get("content", "")

            lines = [f"[{meta['type']}] \"{target[:80]}\""]
            if candidates:
                lines.append(f"  threshold={_MERGE_THRESHOLD}")
                for c, s in candidates:
                    mark = "  ✓" if (existing and c.get("id") == existing.get("id")) else "   "
                    lines.append(f"  {s:.2f}{mark} \"{c.get('content','')[:70]}\"")
            if existing:
                lines.append(f"  → merged into \"{existing.get('content','')[:70]}\"")
            else:
                lines.append(f"  → no match (best={sim:.2f})")
            logger.info("\n".join(lines))
            if existing:
                merged_evidence = _merge_evidence(
                    existing.get("evidence", ""), meta.get("evidence", "")
                )
                merged_meta = {
                    **existing,
                    "type": meta["type"],
                    "content": meta.get("content", existing.get("content", "")),
                    "confidence": max(meta.get("confidence", 0), existing.get("confidence", 0)),
                    "lifespan": max(meta.get("lifespan", 0), existing.get("lifespan", 0)),
                    "evidence": merged_evidence,
                    "timestamp": existing.get("timestamp", meta["timestamp"]),
                }
                await database.vector.update_metadata(existing["id"], merged_meta)
                merged_count += 1

                # Update analysis dict in-place so SQLite JSON gets merged evidence
                cat = rec.get("category", "")
                idx = rec.get("index", 0)
                cat_items = analysis.get(cat, [])
                if idx < len(cat_items):
                    cat_items[idx]["evidence"] = merged_evidence

                logger.debug("Merged [{}] sim={:.2f} into {}", meta["type"], sim, existing["id"])
            else:
                deduped_records.append(rec)

        if merged_count:
            logger.info("Merged {} similar propositions into existing entries", merged_count)
            item_records = deduped_records

        # Re-serialize after merging so SQLite gets the merged evidence arrays
        analysis_json = json.dumps(analysis, ensure_ascii=False)

        return {
            "timestamp": timestamp,
            "summary": summary,
            "analysis_data": analysis_json,
            "raw_transcripts": raw_transcripts,
            "items": item_records,
            "latest_screen_observation": latest_screen_entry,
            "latest_screen_image_path": latest_screen_image_path,
        }

    except json.JSONDecodeError as e:
        logger.error("Failed to parse Gemini JSON response: {}", e)
        logger.error("Raw response: {}", raw_text[:500] if 'raw_text' in dir() else "N/A")
        return None
    except Exception as e:
        logger.error("Error during Gemini processing run: {}", e)
        return None
