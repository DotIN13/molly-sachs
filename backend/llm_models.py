"""Live model catalogues for the selectable chat LLM providers.

Each provider is queried with the user's own API key and its catalogue is
returned as the provider reports it — no hardcoded model names, so a model
released tomorrow shows up without a code change here.

Results are cached in-memory per (provider, key) for `TTL` seconds; the picker
can bypass the cache with `refresh=True`.
"""

import hashlib
import time

import httpx
from loguru import logger

PROVIDERS = ("google", "openai", "anthropic", "deepseek")

# Which stored setting holds the key for each provider.
KEY_FIELD = {
    "google": "gemini_api_key",
    "openai": "openai_api_key",
    "anthropic": "anthropic_api_key",
    "deepseek": "deepseek_api_key",
}

TTL = 600.0
TIMEOUT = 20.0

_cache: dict[str, tuple[float, list[dict]]] = {}


class MissingKey(Exception):
    """No API key is configured for the requested provider."""


# Substrings marking models the chat pipeline cannot drive (embeddings, speech,
# images, realtime sockets). These only clear the `chat` hint that the picker
# filters on by default — every model the provider returns is still in the
# response and reachable via "show all".
_NON_CHAT = (
    "embedding", "embed-", "whisper", "tts", "dall-e", "moderation", "imagen",
    "veo", "aqa", "image", "realtime", "transcribe", "audio", "sora", "search",
    "rerank", "guard", "computer-use",
)


def _looks_chat(model_id: str) -> bool:
    low = model_id.lower()
    return not any(tok in low for tok in _NON_CHAT)


async def _get_json(url: str, *, headers: dict | None = None,
                    params: dict | None = None) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(url, headers=headers or {}, params=params or {})
        resp.raise_for_status()
        return resp.json()


async def _google(api_key: str) -> list[dict]:
    """https://generativelanguage.googleapis.com/v1beta/models

    The key goes in a header, not the documented ``?key=`` query parameter, so
    httpx's INFO-level request log doesn't record it."""
    out: list[dict] = []
    page: str | None = None
    headers = {"x-goog-api-key": api_key}
    for _ in range(10):  # bounded pagination
        params: dict = {"pageSize": 200}
        if page:
            params["pageToken"] = page
        data = await _get_json(
            "https://generativelanguage.googleapis.com/v1beta/models",
            headers=headers, params=params)
        for m in data.get("models") or []:
            mid = (m.get("name") or "").removeprefix("models/")
            if not mid:
                continue
            methods = m.get("supportedGenerationMethods") or []
            out.append({
                "id": mid,
                "label": m.get("displayName") or mid,
                "description": (m.get("description") or "").strip(),
                # Only generateContent models work in the pipeline's LLM slot.
                "chat": "generateContent" in methods and _looks_chat(mid),
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


async def _openai(api_key: str) -> list[dict]:
    """https://api.openai.com/v1/models — newest first (no capability field)."""
    data = await _get_json("https://api.openai.com/v1/models",
                           headers={"Authorization": f"Bearer {api_key}"})
    items = sorted(data.get("data") or [],
                   key=lambda m: m.get("created") or 0, reverse=True)
    return [{
        "id": m["id"],
        "label": m["id"],
        "description": m.get("owned_by") or "",
        "chat": _looks_chat(m["id"]),
    } for m in items if m.get("id")]


async def _anthropic(api_key: str) -> list[dict]:
    """https://api.anthropic.com/v1/models — already chat-only, newest first."""
    out: list[dict] = []
    after: str | None = None
    headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    for _ in range(10):
        params: dict = {"limit": 100}
        if after:
            params["after_id"] = after
        data = await _get_json("https://api.anthropic.com/v1/models",
                               headers=headers, params=params)
        items = data.get("data") or []
        for m in items:
            if not m.get("id"):
                continue
            out.append({
                "id": m["id"],
                "label": m.get("display_name") or m["id"],
                "description": (m.get("created_at") or "")[:10],
                "chat": True,
            })
        if not data.get("has_more") or not items:
            break
        after = items[-1].get("id")
    return out


async def _deepseek(api_key: str) -> list[dict]:
    """https://api.deepseek.com/models"""
    data = await _get_json("https://api.deepseek.com/models",
                           headers={"Authorization": f"Bearer {api_key}"})
    return [{
        "id": m["id"],
        "label": m["id"],
        "description": m.get("owned_by") or "",
        "chat": True,
    } for m in (data.get("data") or []) if m.get("id")]


_FETCHERS = {
    "google": _google,
    "openai": _openai,
    "anthropic": _anthropic,
    "deepseek": _deepseek,
}


def _cache_key(provider: str, api_key: str) -> str:
    return f"{provider}:{hashlib.sha256(api_key.encode()).hexdigest()[:16]}"


async def list_models(provider: str, api_key: str, *,
                      refresh: bool = False) -> tuple[list[dict], bool]:
    """Fetch `provider`'s catalogue. Returns (models, served_from_cache).

    Raises MissingKey if no key is configured, ValueError for an unknown
    provider, and propagates httpx errors for the caller to map to a status."""
    provider = (provider or "").strip().lower()
    if provider not in _FETCHERS:
        raise ValueError(f"unknown provider: {provider}")
    if not api_key:
        raise MissingKey(provider)

    ck = _cache_key(provider, api_key)
    if not refresh:
        hit = _cache.get(ck)
        if hit and time.monotonic() - hit[0] < TTL:
            return hit[1], True

    models = await _FETCHERS[provider](api_key)
    # Providers occasionally repeat ids across pages; keep first occurrence.
    seen: set[str] = set()
    deduped = [m for m in models if not (m["id"] in seen or seen.add(m["id"]))]
    _cache[ck] = (time.monotonic(), deduped)
    logger.info("llm_models: fetched {} models from {}", len(deduped), provider)
    return deduped, False
