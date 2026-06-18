import json
import os
import asyncio
from google import genai
from google.genai import types
from loguru import logger
import config
import database

_PROMPTS_DIR = os.path.join(os.path.dirname(__file__), "prompts")
_MAX_GOALS = 5
_MAX_EVENTS = 5
_MAX_TRAITS = 20
_MAX_SUMMARY_CHARS = 1000
_TRAIT_SIMILARITY_THRESHOLD = float(os.environ.get("MOLLY_TRAIT_SIMILARITY_THRESHOLD", "0.5"))
_TRAIT_TYPES = {"personality", "skill", "interest", "preference", "ownership", "relationship", "weakness"}


def _load_proactive_prompt() -> str:
    with open(os.path.join(_PROMPTS_DIR, "proactive_prompt.md"), "r", encoding="utf-8") as f:
        return f.read()


def _load_proactive_schema() -> dict:
    with open(os.path.join(_PROMPTS_DIR, "proactive_schema.json"), "r", encoding="utf-8") as f:
        return json.load(f)


async def _find_similar_goals(client: genai.Client, query: str, user_id: str) -> list[dict]:
    """Embed the current events query and search for semantically similar goals."""
    embed_result = await asyncio.wait_for(
        client.aio.models.embed_content(
            model='gemini-embedding-2',
            contents=query,
        ), timeout=30
    )
    embedding = embed_result.embeddings[0].values
    goals = await database.vector.search(
        embedding, limit=_MAX_GOALS, user_id=user_id, item_type="goal"
    )

    lines = [f"[proactive-tip] goals query: \"{query[:120]}\""]
    if goals:
        for g in goals:
            sim = g.get("similarity", 0)
            lines.append(f"  {sim:.2f}  [goal] \"{g.get('content','')[:80]}\"")
        lines.append(f"  → matched {len(goals)} goals")
    else:
        lines.append(f"  → no matching goals found")
    logger.info("\n".join(lines))

    return goals


async def _find_similar_traits(client: genai.Client, query: str, user_id: str) -> list[dict]:
    """Embed the summary and search for semantically similar user traits."""
    embed_result = await asyncio.wait_for(
        client.aio.models.embed_content(
            model='gemini-embedding-2',
            contents=query,
        ), timeout=30
    )
    embedding = embed_result.embeddings[0].values
    results = await database.vector.search(
        embedding, limit=200, user_id=user_id, exclude_type="event"
    )
    traits = [r for r in results
              if r.get("type") in _TRAIT_TYPES
              and r.get("similarity", 0) >= _TRAIT_SIMILARITY_THRESHOLD][:_MAX_TRAITS]

    lines = [f"[proactive-tip] traits query (threshold={_TRAIT_SIMILARITY_THRESHOLD}): \"{query[:120]}\""]
    if traits:
        for t in traits:
            sim = t.get("similarity", 0)
            lines.append(f"  {sim:.2f}  [{t.get('type','?')}] \"{t.get('content','')[:80]}\"")
        lines.append(f"  → matched {len(traits)} traits")
    else:
        lines.append(f"  → no matching traits found")
    logger.info("\n".join(lines))

    return traits


async def generate_proactive_tip(user_id: str, prefs: dict,
                                current_events: list[dict] | None = None,
                                current_timestamp: str | None = None,
                                current_summary: str | None = None,
                                latest_observation: dict | None = None,
                                latest_screen_image_path: str | None = None) -> dict | None:
    api_key = prefs.get("gemini_api_key", "").strip()
    if not api_key:
        logger.warning("No Gemini API key; skipping proactive tip generation.")
        return None

    client = genai.Client(api_key=api_key)

    if current_events:
        events = current_events
    else:
        events, _ = await database.vector.get_all(user_id, item_type="event", limit=_MAX_EVENTS)

    if not events:
        logger.info("No events found; skipping proactive tip.")
        return None

    event_texts = [e.get('event', e.get('content', str(e))) for e in events]
    search_query = " ".join(event_texts)

    goals = await _find_similar_goals(client, search_query, user_id)

    if not goals:
        logger.info("No relevant goals found; returning empty tips.")
        return {"tips": []}

    goals_section = "\n".join(
        f"- {g.get('content', '')} (confidence: {g.get('confidence', '?')}, similarity: {g.get('similarity', 0):.2f})"
        for g in goals
    )

    now_ts = current_timestamp or "just now"
    events_section = "\n".join(
        f"- [{now_ts}] {e.get('event', e.get('content', str(e)))}"
        for e in events
    )

    summary_section = current_summary[: _MAX_SUMMARY_CHARS] if current_summary else "(no summary available)"
    traits_query = current_summary[: _MAX_SUMMARY_CHARS] if current_summary else " ".join(event_texts)
    traits = await _find_similar_traits(client, traits_query, user_id)
    traits_section = "\n".join(
        f"- [{t.get('type','?')}] {t.get('content','')} (similarity: {t.get('similarity', 0):.2f})"
        for t in traits
    ) if traits else "(no matching traits found)"

    observation_section = ""
    if latest_observation:
        obs_parts = []
        windows = latest_observation.get("windows") or []
        if windows:
            obs_parts.append("Open windows:\n  " + "\n  ".join(windows))
        prompt_text = latest_observation.get("prompt_text", "")
        if prompt_text:
            obs_parts.append(prompt_text)
        if obs_parts:
            observation_section = "\n".join(obs_parts)
        else:
            observation_section = "(no observation details)"

    prompt = _load_proactive_prompt().format(
        goals_section=goals_section,
        events_section=events_section,
        summary_section=summary_section,
        traits_section=traits_section,
        observation_section=observation_section,
    )

    try:
        contents: list = []
        if latest_screen_image_path:
            image_abs = os.path.join(config.DATA_DIR, latest_screen_image_path)
            if os.path.exists(image_abs):
                with open(image_abs, "rb") as f:
                    image_bytes = f.read()
                contents.append("Here is the latest screenshot of the user's screen:")
                contents.append(types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"))
                logger.info("Attached latest screenshot to proactive tip prompt")
            else:
                logger.warning("Latest screen image not found: {}", image_abs)
        contents.append(prompt)

        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model='gemini-3.1-flash-lite',
                contents=contents,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_json_schema=_load_proactive_schema(),
                ),
            ), timeout=60
        )

        raw_text = response.text
        if not raw_text:
            logger.error("Empty response from proactive tip generation")
            return None

        tip_data = json.loads(raw_text)
        tip_count = len(tip_data.get("tips", []))
        first_summary = tip_data["tips"][0]["tip_summary"][:80] if tip_data.get("tips") else "(empty)"
        logger.info("Generated {} proactive tip(s), first: {}", tip_count, first_summary)
        return tip_data

    except json.JSONDecodeError as e:
        logger.error("Failed to parse proactive tip JSON: {}", e)
        return None
    except Exception as e:
        logger.error("Error generating proactive tip: {}", e)
        return None
