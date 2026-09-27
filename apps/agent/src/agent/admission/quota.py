import time
from collections.abc import Callable

from fastapi import HTTPException
from redis.asyncio import Redis

from agent.config import Settings, get_settings
from agent.infrastructure.redis import get_redis_client
from agent.observability.chat_observability import ChatTelemetry
from agent.repositories import chat_budget_repository
from agent.repositories.chat_budget_repository import (
    BudgetExceededException,
    ChatBudgetRepository,
    RedisUnavailableException,
)

_ORIGINAL_BUDGET_REPO: type[ChatBudgetRepository] = chat_budget_repository.ChatBudgetRepository


class QuotaService:
    def __init__(
        self,
        settings: Settings | None = None,
        redis_client_factory: Callable[[], Redis | None] | None = None,
        budget_repo_factory: type[ChatBudgetRepository] | None = None,
        telemetry: ChatTelemetry | None = None,
    ) -> None:
        self.settings: Settings = settings or get_settings()
        self.redis_client_factory: Callable[[], Redis | None] = (
            redis_client_factory or get_redis_client
        )
        self.budget_repo_factory: type[ChatBudgetRepository] | None = budget_repo_factory
        self.telemetry: ChatTelemetry = telemetry or ChatTelemetry()

    def _resolve_budget_repo_class(self) -> type[ChatBudgetRepository]:
        if (
            self.budget_repo_factory is not None
            and self.budget_repo_factory is not _ORIGINAL_BUDGET_REPO
        ):
            return self.budget_repo_factory
        if chat_budget_repository.ChatBudgetRepository is not _ORIGINAL_BUDGET_REPO:
            return chat_budget_repository.ChatBudgetRepository
        if ChatBudgetRepository is not _ORIGINAL_BUDGET_REPO:
            return ChatBudgetRepository
        if self.budget_repo_factory is not None:
            return self.budget_repo_factory
        return chat_budget_repository.ChatBudgetRepository

    async def check_quota(self, user_id: str, trace_id: str, correlation_id: str) -> None:
        quota_started = time.perf_counter()
        try:
            redis_client = self.redis_client_factory()
            if redis_client is None:
                raise ValueError("Redis client not initialized")
        except Exception as e:
            self.telemetry.emit_safely(
                "quota_admission",
                status="degraded",
                latency_ms=(time.perf_counter() - quota_started) * 1000,
                trace_id=trace_id,
                correlation_id=correlation_id,
                fields={"outcome": "unavailable", "error_class": "control_plane_unavailable"},
            )
            raise HTTPException(
                status_code=503,
                detail="CHAT_CONTROL_PLANE_UNAVAILABLE",
            ) from e

        budget_repo_cls = self._resolve_budget_repo_class()
        budget_repo = budget_repo_cls(redis_client)

        burst_window_seconds: int = int(getattr(self.settings, "CHAT_BURST_WINDOW_SECONDS", 60))
        daily_limit: int = int(
            getattr(
                self.settings,
                "CHAT_DAILY_MESSAGE_LIMIT",
                getattr(self.settings, "CHAT_QUOTA_DAILY", 50),
            )
        )
        burst_limit: int = int(
            getattr(
                self.settings,
                "CHAT_BURST_LIMIT",
                getattr(self.settings, "CHAT_QUOTA_BURST", 60),
            )
        )
        burst_window_id: str = f"w_{int(time.time()) // burst_window_seconds}"

        try:
            await budget_repo.admit_request(
                user_id=user_id,
                burst_window_id=burst_window_id,
                daily_limit=daily_limit,
                burst_limit=burst_limit,
                burst_ttl=burst_window_seconds,
            )
            self.telemetry.emit_safely(
                "quota_admission",
                status="accepted",
                latency_ms=(time.perf_counter() - quota_started) * 1000,
                trace_id=trace_id,
                correlation_id=correlation_id,
                fields={"outcome": "admitted", "dependency": "redis"},
            )
        except BudgetExceededException as e:
            reason: str = "daily_quota" if "daily" in str(e).lower() else "burst_limit"
            self.telemetry.emit_safely(
                "quota_admission",
                status="rejected",
                latency_ms=(time.perf_counter() - quota_started) * 1000,
                trace_id=trace_id,
                correlation_id=correlation_id,
                fields={"outcome": "rejected", "error_class": reason},
            )
            detail: str = (
                "CHAT_DAILY_QUOTA_EXCEEDED"
                if "daily" in str(e).lower()
                else "CHAT_BURST_LIMIT_EXCEEDED"
            )
            raise HTTPException(status_code=429, detail=detail) from e
        except RedisUnavailableException as e:
            self.telemetry.emit_safely(
                "quota_admission",
                status="degraded",
                latency_ms=(time.perf_counter() - quota_started) * 1000,
                trace_id=trace_id,
                correlation_id=correlation_id,
                fields={"outcome": "unavailable", "error_class": "control_plane_unavailable"},
            )
            raise HTTPException(
                status_code=503,
                detail="CHAT_CONTROL_PLANE_UNAVAILABLE",
            ) from e
        except Exception as e:
            self.telemetry.emit_safely(
                "quota_admission",
                status="degraded",
                latency_ms=(time.perf_counter() - quota_started) * 1000,
                trace_id=trace_id,
                correlation_id=correlation_id,
                fields={"outcome": "unavailable", "error_class": "control_plane_unavailable"},
            )
            raise HTTPException(
                status_code=503,
                detail="CHAT_CONTROL_PLANE_UNAVAILABLE",
            ) from e
