import asyncio
import json
import logging
import sys

from fastapi import APIRouter, Depends, Header, Request
from sse_starlette.sse import EventSourceResponse

from agent.admission import (
    AuthenticatedUser,
    AuthService,
    InputAdmissionResult,
    InputAdmissionService,
    QuotaService,
    create_blocked_sse_response,
)
from agent.chat_turn.command import ChatTurnCommand
from agent.chat_turn.controller import ChatController
from agent.chat_turn.events import (
    ChatTurnEvent,
    ErrorEvent,
    ErrorPayload,
)
from agent.chat_turn.runner import ChatTurnRunner, _persist_response
from agent.config import get_settings
from agent.graph.graph import graph
from agent.guardrails.gateway import GuardrailGateway
from agent.infrastructure.redis import get_redis_client
from agent.models.requests import ChatStreamRequest
from agent.observability.chat_observability import safe_opaque_id
from agent.repositories import chat_budget_repository
from agent.repositories.chat_budget_repository import ChatBudgetRepository
from agent.tools.nestjs_client import NestJSClient
from agent.trusted_search_snapshot import TrustedSnapshotRepository

__all__ = [
    "ChatBudgetRepository",
    "ChatController",
    "ChatTurnCommand",
    "ChatTurnRunner",
    "NestJSClient",
    "TrustedSnapshotRepository",
    "_persist_response",
    "chat_budget_repository",
    "chat_stream",
    "check_chat_quota",
    "format_sse",
    "get_admitted_input",
    "get_auth_service",
    "get_authenticated_user",
    "get_input_admission_service",
    "get_quota_service",
    "get_redis_client",
    "graph",
    "router",
]

logger = logging.getLogger("agent.streaming")
router = APIRouter()


def format_sse(event: ChatTurnEvent) -> str:
    return f"event: {event.event}\ndata: {event.data.model_dump_json()}\n\n"


def _resolve_correlation_id(value: str | None) -> str:
    """Return an opaque telemetry identifier, never a request/session identifier."""
    return safe_opaque_id(value)


def get_auth_service() -> AuthService:
    mod = sys.modules[__name__]
    client_factory = getattr(mod, "NestJSClient")
    return AuthService(client_factory=client_factory)


def get_input_admission_service() -> InputAdmissionService:
    return InputAdmissionService()


_ORIGINAL_BUDGET_REPO: type[ChatBudgetRepository] = ChatBudgetRepository


def get_quota_service() -> QuotaService:
    mod = sys.modules[__name__]
    redis_client_factory = getattr(mod, "get_redis_client")
    chat_budget_repo = getattr(mod, "ChatBudgetRepository")
    cbr_mod = getattr(mod, "chat_budget_repository", None)
    if chat_budget_repo is not _ORIGINAL_BUDGET_REPO:
        budget_repo_factory = chat_budget_repo
    elif (
        cbr_mod is not None
        and hasattr(cbr_mod, "ChatBudgetRepository")
        and getattr(cbr_mod, "ChatBudgetRepository") is not _ORIGINAL_BUDGET_REPO
    ):
        budget_repo_factory = getattr(cbr_mod, "ChatBudgetRepository")
    else:
        budget_repo_factory = chat_budget_repo
    return QuotaService(
        redis_client_factory=redis_client_factory,
        budget_repo_factory=budget_repo_factory,
    )


async def get_authenticated_user(
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None, alias="X-Trace-Id"),
    x_correlation_id: str | None = Header(None, alias="X-Correlation-Id"),
    auth_service: AuthService = Depends(get_auth_service),
) -> AuthenticatedUser:
    return await auth_service.authenticate(
        authorization=authorization,
        x_trace_id=x_trace_id,
        x_correlation_id=x_correlation_id,
    )


async def get_admitted_input(
    request: Request,
    body: ChatStreamRequest,
    user: AuthenticatedUser = Depends(get_authenticated_user),
    input_service: InputAdmissionService = Depends(get_input_admission_service),
) -> InputAdmissionResult:
    gateway: GuardrailGateway | None = getattr(request.app.state, "guardrail_gateway", None)
    return await input_service.admit_input(
        message=body.message,
        session_id=body.sessionId,
        user=user,
        gateway=gateway,
    )


async def check_chat_quota(
    user: AuthenticatedUser = Depends(get_authenticated_user),
    admitted: InputAdmissionResult = Depends(get_admitted_input),
    quota_service: QuotaService = Depends(get_quota_service),
) -> None:
    if not admitted.is_blocked:
        await quota_service.check_quota(
            user_id=user.user_id,
            trace_id=user.trace_id,
            correlation_id=user.correlation_id,
        )


@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    body: ChatStreamRequest,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None, alias="X-Trace-Id"),
    x_correlation_id: str | None = Header(None, alias="X-Correlation-Id"),
    user: AuthenticatedUser | None = Depends(get_authenticated_user),
    admitted_input: InputAdmissionResult | None = Depends(get_admitted_input),
    _quota: None = Depends(check_chat_quota),
) -> EventSourceResponse:
    """
    Handle POST /chat/stream requests, delegating admission to dependencies
    and streaming execution to ChatTurnRunner.
    """
    if not isinstance(user, AuthenticatedUser):
        auth_service = get_auth_service()
        user = await auth_service.authenticate(
            authorization=authorization,
            x_trace_id=x_trace_id,
            x_correlation_id=x_correlation_id,
        )
    if not isinstance(admitted_input, InputAdmissionResult):
        input_service = get_input_admission_service()
        gateway_candidate: GuardrailGateway | None = getattr(
            request.app.state, "guardrail_gateway", None
        )
        admitted_input = await input_service.admit_input(
            message=body.message,
            session_id=body.sessionId,
            user=user,
            gateway=gateway_candidate,
        )
        if not admitted_input.is_blocked:
            quota_service = get_quota_service()
            await quota_service.check_quota(
                user_id=user.user_id,
                trace_id=user.trace_id,
                correlation_id=user.correlation_id,
            )

    if admitted_input.is_blocked:
        if admitted_input.blocked_event is not None:
            return create_blocked_sse_response(admitted_input.blocked_event)
        return create_blocked_sse_response(
            ErrorEvent(
                data=ErrorPayload(
                    code=admitted_input.decision.response_key or "GUARDRAIL_INPUT_BLOCKED",
                    message="Input rejected by security guardrail",
                    partialMessageId=None,
                )
            )
        )

    settings = get_settings()

    command = ChatTurnCommand(
        user_id=user.user_id,
        session_id=body.sessionId,
        message=body.message,
        action_required=getattr(body, "actionRequired", False),
        action_type=getattr(body, "actionType", None),
        action_payload=getattr(body, "actionPayload", None),
        token=user.token,
        trace_id=user.trace_id,
        correlation_id=user.correlation_id,
    )

    gateway: GuardrailGateway | None = getattr(request.app.state, "guardrail_gateway", None)
    queue_manager = getattr(request.app.state, "message_queue", None)

    mod = sys.modules[__name__]
    client_factory = getattr(mod, "NestJSClient")
    runner_cls = getattr(mod, "ChatTurnRunner")
    redis_factory = getattr(mod, "get_redis_client")

    runner = runner_cls(
        settings=settings,
        graph=graph,
        queue_manager=queue_manager,
        redis_client=redis_factory(),
        client_factory=client_factory,
        gateway=gateway,
        require_gateway=True,
    )

    controller_cls = getattr(mod, "ChatController")
    controller = controller_cls(runner=runner, gateway=gateway)

    async def sse_generator():
        current_task = asyncio.current_task()
        if current_task is not None:
            try:
                from agent.main import active_runners

                active_runners.add(current_task)
            except ImportError:
                pass

        generator = controller.stream(command, admission_decision=admitted_input.decision)
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
