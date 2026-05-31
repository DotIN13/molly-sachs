import time
from collections import defaultdict

from fastapi import HTTPException, Request


class RateLimiter:
    def __init__(self, max_requests: int, window_seconds: float):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: dict[str, list[float]] = defaultdict(list)

    async def __call__(self, request: Request):
        identifier = request.client.host if request.client else "unknown"
        now = time.monotonic()
        self._hits[identifier] = [
            t for t in self._hits[identifier] if now - t < self.window_seconds
        ]
        if not self._hits[identifier]:
            del self._hits[identifier]
        if len(self._hits[identifier]) >= self.max_requests:
            raise HTTPException(status_code=429, detail="Too many requests")
        self._hits[identifier].append(now)
        return True


def rate_limit(max_requests: int, window_seconds: float):
    limiter = RateLimiter(max_requests, window_seconds)

    async def dependency(request: Request):
        return await limiter(request)

    return limiter
