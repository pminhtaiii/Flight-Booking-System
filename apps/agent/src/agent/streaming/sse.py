import asyncio
import json
import logging
import time

from fastapi import APIRouter, Header, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from agent.chat_turn import (
    ChatTurnCommand,
    ChatTurnRunner,
    ErrorEvent,
    ErrorPayload,
)
from agent.chat_turn.runner import _persist_response
from agent.config import get_settings
from agent.graph.graph import graph
from agent.guardrails.gateway import GuardrailGateway
from agent.guardrails.registry import create_production_registry
from agent.infrastructure.redis import get_redis_client
from agent.models.requests import ChatStreamRequest
from agent.observability.chat_observability import ChatTelemetry, safe_opaque_id
from agent.repositories import chat_budget_repository
from agent.repositories.chat_budget_repository import (
    BudgetExceededException,
    ChatBudgetRepository,
    RedisUnavailableException,
)
from agent.sanitization.pii_scrubber import detect_pii
from agent.tools.nestjs_client import NestJSClient
from agent.trusted_search_snapshot import TrustedSnapshotRepository

__all__ = [
    "ChatBudgetRepository",
    "ChatTurnCommand",
    "ChatTurnRunner",
    "NestJSClient",
    "TrustedSnapshotRepository",
    "_persist_response",
    "chat_stream",
    "get_redis_client",
    "graph",
    "router",
]

_ORIGINAL_BUDGET_REPO = chat_budget_repository.ChatBudgetRepository

logger = logging.getLogger("agent.streaming")
guardrails_logger = logging.getLogger("agent.guardrails")
router = APIRouter()
chat_telemetry = ChatTelemetry(logger)


def _resolve_correlation_id(value: str | None) -> str:
    """Return an opaque telemetry identifier, never a request/session identifier."""
    return safe_opaque_id(value)


@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    body: ChatStreamRequest,
    authorization: str = Header(None),
    x_trace_id: str = Header(None, alias="X-Trace-Id"),
    x_correlation_id: str = Header(None, alias="X-Correlation-Id"),
):
    """
    Handle POST /chat/stream requests, performing validation, checking guardrails,
    and delegating streaming execution to ChatTurnRunner.
    """
    settings = get_settings()

    # 1. Authorization validation first (canonical JWT profile: sub, iss, aud, jti)
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization.split(" ", 1)[1]

    from agent.utils.auth import decode_and_verify_jwt

    try:
        issuer = getattr(settings, "JWT_ISSUER", "booking-systems-api")
        audience = getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")
        secrets_to_try = (
            settings.jwt_secret_ring
            if hasattr(settings, "jwt_secret_ring")
            else settings.JWT_SECRET
        )
        payload = decode_and_verify_jwt(
            token=token,
            secret=secrets_to_try,
            issuer=issuer,
            audience=audience,
        )
        user_id = str(payload.get("sub") or payload.get("id") or "")
        jti = payload.get("jti")
    except Exception as err:
        raise HTTPException(status_code=401, detail="Invalid token") from err

    trace_id = _resolve_correlation_id(x_trace_id)
    correlation_id = _resolve_correlation_id(x_correlation_id)

    client = NestJSClient(
        base_url=settings.NESTJS_API_URL,
        token=token,
        trace_id=trace_id,
        correlation_id=correlation_id,
    )
    if hasattr(client, "trace_id"):
        client.trace_id = trace_id
    if hasattr(client, "correlation_id"):
        client.correlation_id = correlation_id

    # 2. NestJS access check (active user & revocation check) BEFORE quota or session lock
    access_res = await client.check_user_access(sub=user_id, jti=jti)
    if not access_res.get("allowed"):
        raise HTTPException(status_code=401, detail="User account inactive or token revoked")

    # 3. Message length check
    if body.message and len(body.message) > settings.MAX_MESSAGE_LENGTH:
        raise HTTPException(status_code=400, detail="Message exceeds maximum length")

    # 4. Guardrails check (input safety & ingress PII detection)
    if body.message and detect_pii(body.message):
        guardrails_logger.warning("Ingress PII detected in user message: REDACTED")

        async def pii_error_generator():
            event = ErrorEvent(
                data=ErrorPayload(
                    code="GUARDRAIL_BLOCKED",
                    message="Your message contains protected personal information and cannot be processed.",
                    partialMessageId=None,
                )
            )
            yield {"event": event.event, "data": event.data.model_dump_json()}

        return EventSourceResponse(pii_error_generator())

    guardrails = getattr(request.app.state, "guardrails", None)
    if guardrails and body.message:
        is_allowed, reason = await guardrails.validate_message(body.message)
        if not is_allowed:
            if "unavailable" in reason.lower():
                raise HTTPException(status_code=503, detail="Safety check unavailable")

            async def error_generator():
                event = ErrorEvent(
                    data=ErrorPayload(
                        code="GUARDRAIL_BLOCKED",
                        message="Your message could not be processed.",
                        partialMessageId=None,
                    )
                )
                yield {"event": event.event, "data": event.data.model_dump_json()}

            return EventSourceResponse(error_generator())

    # 5. Rate Limit / Quota check (accepted-only charge) BEFORE session lock / model / persistence
    quota_started = time.perf_counter()
    try:
        redis_client = get_redis_client()
        if not redis_client:
            raise ValueError("Redis client not initialized")
    except Exception as e:
        raise HTTPException(status_code=503, detail="CHAT_CONTROL_PLANE_UNAVAILABLE") from e

    if chat_budget_repository.ChatBudgetRepository is not _ORIGINAL_BUDGET_REPO:
        budget_repo_cls = chat_budget_repository.ChatBudgetRepository
    elif ChatBudgetRepository is not _ORIGINAL_BUDGET_REPO:
        budget_repo_cls = ChatBudgetRepository
    else:
        budget_repo_cls = chat_budget_repository.ChatBudgetRepository

    budget_repo = budget_repo_cls(redis_client)
    try:
        burst_window_seconds = getattr(settings, "CHAT_BURST_WINDOW_SECONDS", 60)
        daily_limit = getattr(
            settings, "CHAT_DAILY_MESSAGE_LIMIT", getattr(settings, "CHAT_QUOTA_DAILY", 50)
        )
        burst_limit = getattr(
            settings, "CHAT_BURST_LIMIT", getattr(settings, "CHAT_QUOTA_BURST", 60)
        )
        burst_window_id = f"w_{int(time.time()) // burst_window_seconds}"
        await budget_repo.admit_request(
            user_id=user_id,
            burst_window_id=burst_window_id,
            daily_limit=daily_limit,
            burst_limit=burst_limit,
            burst_ttl=burst_window_seconds,
        )
        chat_telemetry.emit_safely(
            "quota_admission",
            status="accepted",
            latency_ms=(time.perf_counter() - quota_started) * 1000,
            trace_id=trace_id,
            correlation_id=correlation_id,
            fields={"outcome": "admitted", "dependency": "redis"},
        )
    except BudgetExceededException as e:
        reason = "daily_quota" if "daily" in str(e).lower() else "burst_limit"
        chat_telemetry.emit_safely(
            "quota_admission",
            status="rejected",
            latency_ms=(time.perf_counter() - quota_started) * 1000,
            trace_id=trace_id,
            correlation_id=correlation_id,
            fields={"outcome": "rejected", "error_class": reason},
        )
        if "daily" in str(e).lower():
            raise HTTPException(status_code=429, detail="CHAT_DAILY_QUOTA_EXCEEDED") from e
        raise HTTPException(status_code=429, detail="CHAT_BURST_LIMIT_EXCEEDED") from e
    except RedisUnavailableException as e:
        chat_telemetry.emit_safely(
            "quota_admission",
            status="failed",
            latency_ms=(time.perf_counter() - quota_started) * 1000,
            trace_id=trace_id,
            correlation_id=correlation_id,
            fields={"outcome": "unavailable", "error_class": "control_plane_unavailable"},
        )
        raise HTTPException(status_code=503, detail="CHAT_CONTROL_PLANE_UNAVAILABLE") from e

    # 6. Construct ChatTurnCommand
    command = ChatTurnCommand(
        user_id=user_id,
        session_id=body.sessionId,
        message=body.message,
        action_required=getattr(body, "actionRequired", False),
        action_type=getattr(body, "actionType", None),
        action_payload=getattr(body, "actionPayload", None),
        token=token,
        trace_id=trace_id,
        correlation_id=correlation_id,
    )

    # 7. Delegate streaming to ChatTurnRunner
    queue_manager = getattr(request.app.state, "message_queue", None)
    gateway = getattr(request.app.state, "guardrail_gateway", None)
    if gateway is None:
        gateway = GuardrailGateway(create_production_registry())

    runner = ChatTurnRunner(
        settings=settings,
        graph=graph,
        guardrails=guardrails,
        queue_manager=queue_manager,
        redis_client=get_redis_client(),
        client_factory=NestJSClient,
        gateway=gateway,
        require_gateway=True,
    )

    async def sse_generator():
        current_task = asyncio.current_task()
        if current_task is not None:
            try:
                from agent.main import active_runners

                active_runners.add(current_task)
            except ImportError:
                pass

        generator = runner.run(command)
        try:
            async for event in generator:
                try:
                    if await request.is_disconnected():
                        logger.warning("client_disconnected_during_stream")
                        break
                except (RuntimeError, AttributeError):
                    pass
                event_name = event.event
                data_val = (
                    event.data.model_dump_json()
                    if hasattr(event.data, "model_dump_json")
                    else json.dumps(event.data)
                )
                yield {"event": event_name, "data": data_val}
                if event_name == "error":
                    break
        finally:
            await generator.aclose()
            if current_task is not None:
                try:
                    from agent.main import active_runners

                    active_runners.discard(current_task)
                except ImportError:
                    pass

    return EventSourceResponse(sse_generator())
