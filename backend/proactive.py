import json
import os
import asyncio
from google import genai
from google.genai import types
from loguru import logger
import database

_PROMPTS_DIR = os.path.join(os.path.dirname(__file__), "prompts")
_MAX_GOALS = 5
_MAX_EVENTS = 5


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

    lines = [f"[proactive-tip] query: \"{query[:120]}\""]
    if goals:
        for g in goals:
            sim = g.get("similarity", 0)
            lines.append(f"  {sim:.2f}  [goal] \"{g.get('content','')[:80]}\"")
        lines.append(f"  → matched {len(goals)} goals")
    else:
        lines.append(f"  → no matching goals found")
    logger.info("\n".join(lines))

    return goals


async def generate_proactive_tip(user_id: str, prefs: dict,
                                current_events: list[dict] | None = None,
                                current_timestamp: str | None = None) -> dict | None:
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
        logger.info("No relevant goals found for user; skipping proactive tip.")
        return None

    goals_section = "\n".join(
        f"- {g.get('content', '')} (confidence: {g.get('confidence', '?')}, similarity: {g.get('similarity', 0):.2f})"
        for g in goals
    )

    now_ts = current_timestamp or "just now"
    events_section = "\n".join(
        f"- [{now_ts}] {e.get('event', e.get('content', str(e)))}"
        for e in events
    )

    prompt = _load_proactive_prompt().format(
        goals_section=goals_section,
        events_section=events_section,
    )

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model='gemini-3.1-flash-lite',
                contents=prompt,
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
        logger.info("Generated proactive tip: {}", tip_data.get("intent_guess", "")[:80])
        return tip_data

    except json.JSONDecodeError as e:
        logger.error("Failed to parse proactive tip JSON: {}", e)
        return None
    except Exception as e:
        logger.error("Error generating proactive tip: {}", e)
        return None
