import time
from collections import defaultdict
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.responses import JSONResponse
from typing import Dict, List

class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, limit: int = 60, window: int = 60):
        super().__init__(app)
        self.limit = limit
        self.window = window
        self.requests: Dict[str, List[float]] = defaultdict(list)

    async def dispatch(self, request: Request, call_next) -> Response:
        if request.url.path == "/health":
            return await call_next(request)

        # Identify client: user sub if authenticated, else IP
        user = getattr(request.state, "user", None)
        identifier = user.get("sub") if user and isinstance(user, dict) else (request.client.host if request.client else "unknown")

        now = time.time()
        # Clean up old timestamps
        user_requests = [t for t in self.requests[identifier] if now - t < self.window]
        self.requests[identifier] = user_requests

        if len(user_requests) >= self.limit:
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Please try again later."}
            )

        self.requests[identifier].append(now)
        return await call_next(request)
