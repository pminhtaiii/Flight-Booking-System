import logging
import time
from typing import Optional

import redis.asyncio as redis
from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from agent.config import get_settings
from agent.infrastructure.redis import get_redis_client
from agent.repositories.chat_budget_repository import (
    BudgetExceededException,
    ChatBudgetRepository,
    RedisUnavailableException,
)

logger = logging.getLogger("agent.middleware.rate_limit")


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    Middleware that enforces two-level rate limiting (burst limit and daily quota)
    atomically across instances using ChatBudgetRepository and Redis.
    """

    def __init__(
        self,
        app,
        limit: Optional[int] = None,
        window: Optional[int] = None,
        daily_limit: Optional[int] = None,
        redis_client: Optional[redis.Redis] = None,
    ):
        super().__init__(app)
        self.burst_limit = limit
        self.window = window
        self.daily_limit = daily_limit
        self.redis_client = redis_client

    async def dispatch(self, request: Request, call_next) -> Response:
        if request.method == "OPTIONS":
            return await call_next(request)

        path = request.url.path
        if path == "/health" or path.startswith(("/docs", "/openapi.json", "/redoc")):
            return await call_next(request)

        settings = get_settings()
        burst_limit = (
            self.burst_limit
            if self.burst_limit is not None
            else getattr(settings, "CHAT_QUOTA_BURST", 60)
        )
        daily_limit = (
            self.daily_limit
            if self.daily_limit is not None
            else getattr(settings, "CHAT_QUOTA_DAILY", 50)
        )
        window_seconds = (
            self.window
            if self.window is not None
            else getattr(settings, "CHAT_BURST_WINDOW_SECONDS", 60)
        )

        user = getattr(request.state, "user", None)
        user_id = None
        if user and isinstance(user, dict):
            user_id = str(user.get("sub") or user.get("id") or "")

        if not user_id:
            user_id = request.client.host if request.client else "unknown"

        now_ts = int(time.time())
        burst_window_id = f"w_{now_ts // window_seconds}"

        try:
            r_client = self.redis_client or get_redis_client()
            repo = ChatBudgetRepository(r_client)
            await repo.admit_request(
                user_id=user_id,
                burst_window_id=burst_window_id,
                daily_limit=daily_limit,
                burst_limit=burst_limit,
                burst_ttl=window_seconds,
            )
        except BudgetExceededException as e:
            reason_str = str(getattr(e, "reason", e)).lower()
            if "daily" in reason_str:
                logger.warning(f"Daily quota exceeded for user {user_id}")
                return JSONResponse(
                    status_code=429,
                    content={
                        "code": "CHAT_DAILY_QUOTA_EXCEEDED",
                        "detail": "Daily quota exceeded",
                        "message": "Daily quota exceeded",
                    },
                )
            else:
                logger.warning(f"Burst limit exceeded for user {user_id}")
                return JSONResponse(
                    status_code=429,
                    content={
                        "code": "CHAT_BURST_LIMIT_EXCEEDED",
                        "detail": "Burst limit exceeded",
                        "message": "Burst limit exceeded",
                    },
                )
        except (RedisUnavailableException, RuntimeError, redis.RedisError) as e:
            logger.error(f"Control plane unavailable for rate limiting: {e}")
            return JSONResponse(
                status_code=503,
                content={
                    "code": "CHAT_CONTROL_PLANE_UNAVAILABLE",
                    "detail": "Control plane unavailable",
                    "message": "Control plane unavailable",
                },
            )

        return await call_next(request)
