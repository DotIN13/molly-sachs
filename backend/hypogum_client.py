"""Async client for a user's hypogum instance — the memory + autonomy brain.

Molly is the interaction layer; hypogum owns long-term memory. These helpers
call hypogum's REST API (semantic search + memory write) over plain HTTP.

Base URL resolution, in priority order:
  1. explicit ``base_url`` argument (the user's ``hypogum_base_url`` setting)
  2. ``HYPOGUM_BASE_URL`` env / config default (``config.hypogum_base_url()``)
"""

import httpx
from loguru import logger

import config

# Molly's category taxonomy → hypogum's. Nearly 1:1; the two exceptions are
# Molly's "trait" (hypogum calls it "personality") and "other" (no hypogum
# equivalent — folded into the general "personality" bucket).
_CATEGORY_MAP = {
    "trait": "personality",
    "preference": "preference",
    "interest": "interest",
    "skill": "skill",
    "goal": "goal",
    "relationship": "relationship",
    "ownership": "ownership",
    "weakness": "weakness",
    "event": "event",
    "other": "personality",
}


def resolve_base_url(base_url: str | None = None) -> str:
    return (base_url or "").strip() or config.hypogum_base_url()


def map_category(category: str) -> str:
    return _CATEGORY_MAP.get(category, "personality")


async def health(base_url: str | None = None, timeout: float = 3.0) -> bool:
    """True if the hypogum instance is reachable (used for auto-detect)."""
    url = resolve_base_url(base_url)
    try:
        async with httpx.AsyncClient(base_url=url, timeout=timeout) as client:
            r = await client.get("/api/v1/health")
            return r.status_code == 200
    except Exception as e:
        logger.warning("[hypogum] health check failed for {}: {}", url, e)
        return False


async def search_memory(query: str, limit: int = 8,
                        base_url: str | None = None,
                        timeout: float = 30.0) -> list[dict]:
    """Semantic search over the user's memory pages. Returns a list of
    ``{path, title, type, category, confidence, score, snippet}`` dicts."""
    url = resolve_base_url(base_url)
    async with httpx.AsyncClient(base_url=url, timeout=timeout) as client:
        r = await client.get(
            "/api/v1/memory/semantic", params={"q": query, "limit": limit},
        )
        r.raise_for_status()
        return r.json().get("results", [])


async def fetch_prompt(name: str, base_url: str | None = None,
                       timeout: float = 5.0) -> str:
    """Read a hand-authored prompt out of hypogum's ``data/prompts``.

    Molly's persona lives there rather than in this repo — it's the user's own
    writing about their own companion, so it belongs with their memory store.
    Fetched on every context build so an edit lands on the next reply.

    Returns "" when the prompt doesn't exist or hypogum can't be reached; the
    caller falls back to the bundled default. A missing persona must never take
    the chat down with it.
    """
    url = resolve_base_url(base_url)
    try:
        async with httpx.AsyncClient(base_url=url, timeout=timeout) as client:
            r = await client.get(f"/api/v1/prompts/{name}")
            if r.status_code == 404:
                return ""
            r.raise_for_status()
            return r.json().get("content", "")
    except Exception as e:
        logger.warning("[hypogum] prompt {!r} unavailable, using default: {}", name, e)
        return ""


async def grep_memory(pattern: str, limit: int = 8, context: int = 1,
                      base_url: str | None = None,
                      timeout: float = 20.0) -> list[dict]:
    """Literal/regex search over memory pages, with surrounding lines. Returns
    a list of ``{file, block}`` where ``block`` is grep-style text: ``12:`` for
    a matched line, ``13-`` for context, ``--`` between runs."""
    url = resolve_base_url(base_url)
    async with httpx.AsyncClient(base_url=url, timeout=timeout) as client:
        r = await client.get(
            "/api/v1/memory/grep",
            params={"pattern": pattern, "limit": limit, "context": context},
        )
        r.raise_for_status()
        return r.json().get("blocks", [])


async def submit_run(prompt: str, base_url: str | None = None,
                     timeout: float = 30.0) -> dict:
    """Queue a freeform agent run in hypogum. Returns the run meta (incl. id)."""
    url = resolve_base_url(base_url)
    async with httpx.AsyncClient(base_url=url, timeout=timeout) as client:
        r = await client.post("/api/v1/runs", json={"prompt": prompt})
        r.raise_for_status()
        return r.json()


async def get_run(run_id: str, base_url: str | None = None,
                  timeout: float = 15.0) -> dict | None:
    """Fetch a run's current state/meta (status, summary, workspace)."""
    url = resolve_base_url(base_url)
    async with httpx.AsyncClient(base_url=url, timeout=timeout) as client:
        r = await client.get(f"/api/v1/runs/{run_id}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()


async def list_artifacts(limit: int = 20, base_url: str | None = None,
                         timeout: float = 15.0) -> list[dict]:
    """List recent artifacts produced by hypogum runs."""
    url = resolve_base_url(base_url)
    async with httpx.AsyncClient(base_url=url, timeout=timeout) as client:
        r = await client.get("/api/v1/artifacts", params={"limit": limit})
        r.raise_for_status()
        return r.json().get("artifacts", [])


async def submit_note(text: str, title: str | None = None, *,
                      base_url: str | None = None,
                      timeout: float = 15.0) -> dict:
    """Drop raw user input into hypogum's ingest inbox. The ingest agent picks
    it up next cycle and folds it into memory (categorization + dedup handled
    agent-side). Returns ``{queued: <filename>}``."""
    url = resolve_base_url(base_url)
    async with httpx.AsyncClient(base_url=url, timeout=timeout) as client:
        r = await client.post("/api/v1/note", json={"text": text, "title": title})
        r.raise_for_status()
        return r.json()


async def read_memory_page(path: str, base_url: str | None = None,
                           timeout: float = 15.0) -> dict | None:
    """Fetch a single memory page: ``{path, title, frontmatter, body, content,
    wikilinks, backlinks}``. Returns None if the page doesn't exist."""
    url = resolve_base_url(base_url)
    async with httpx.AsyncClient(base_url=url, timeout=timeout) as client:
        r = await client.get("/api/v1/memory/page", params={"path": path})
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()


async def fetch_calendar(frm: str | None = None, to: str | None = None,
                         base_url: str | None = None,
                         timeout: float = 15.0) -> list[dict]:
    """List calendar entries (observed / planned / suggested), optionally within
    a ``YYYY-MM-DD`` date range. Each entry: ``{bucket, date, start, end,
    title, category, ...}``."""
    url = resolve_base_url(base_url)
    params: dict[str, str] = {}
    if frm:
        params["from"] = frm
    if to:
        params["to"] = to
    async with httpx.AsyncClient(base_url=url, timeout=timeout) as client:
        r = await client.get("/api/v1/calendar", params=params)
        r.raise_for_status()
        return r.json().get("entries", [])
