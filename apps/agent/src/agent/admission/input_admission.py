import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass

from fastapi import HTTPException
from sse_starlette.sse import EventSourceResponse

from agent.admission.auth import AuthenticatedUser
from agent.chat_turn.events import ErrorEvent, ErrorPayload
from agent.config import Settings, get_settings
from agent.guardrails.base import (
    GUARDRAIL_INPUT_INJECTION,
    GUARDRAIL_INPUT_PII,
    AdmissionContext,
    PipelineDecision,
    ValidatedInput,
)
from agent.guardrails.gateway import GuardrailGateway
from agent.guardrails.pii import deterministic_pii_match

logger = logging.getLogger("agent.guardrails")


@dataclass(frozen=True)
class InputAdmissionResult:
    decision: PipelineDecision[ValidatedInput]
    validated_input: ValidatedInput | None = None
    blocked_event: ErrorEvent | None = None

    @property
    def is_blocked(self) -> bool:
        return self.decision.status == "BLOCK"


def create_blocked_sse_response(blocked_event: ErrorEvent) -> EventSourceResponse:
    """Helper to convert a blocked admission ErrorEvent into an SSE response."""

    async def _error_generator() -> AsyncIterator[dict[str, str]]:
        yield {
            "event": blocked_event.event,
            "data": blocked_event.data.model_dump_json(),
        }

    return EventSourceResponse(_error_generator())


class InputAdmissionService:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings: Settings = settings or get_settings()

    async def admit_input(
        self,
        message: str | None,
        session_id: str | None,
        user: AuthenticatedUser,
        gateway: GuardrailGateway | None,
    ) -> InputAdmissionResult:
        if message is not None and len(message) > self.settings.MAX_MESSAGE_LENGTH:
            raise HTTPException(
                status_code=400,
                detail="Message exceeds maximum length",
            )

        if gateway is None or not isinstance(gateway, GuardrailGateway) or not gateway.is_healthy():
            raise HTTPException(
                status_code=503,
                detail="GUARDRAIL_GATEWAY_UNAVAILABLE: Guardrail gateway is uninitialized or degraded",
            )

        if not message:
            validated_input = ValidatedInput(content="")
            return InputAdmissionResult(
                decision=PipelineDecision[ValidatedInput](
                    status="PASS",
                    validated_data=validated_input,
                ),
                validated_input=validated_input,
                blocked_event=None,
            )

        context = AdmissionContext(
            user_id=user.user_id,
            chat_session_id=session_id or "unassigned",
            trace_id=user.trace_id,
            correlation_id=user.correlation_id,
            policy_version="2026-09-05",
        )

        decision: PipelineDecision[ValidatedInput]
        try:
            raw_decision = await gateway.validate_input(context, message)
            if isinstance(raw_decision, PipelineDecision):
                decision = raw_decision
            else:
                if deterministic_pii_match(message):
                    decision = PipelineDecision[ValidatedInput](
                        status="BLOCK",
                        response_key=GUARDRAIL_INPUT_PII,
                        reason="PII detected",
                    )
                else:
                    decision = PipelineDecision[ValidatedInput](
                        status="PASS",
                        validated_data=ValidatedInput(content=message),
                    )
        except Exception:
            if deterministic_pii_match(message):
                decision = PipelineDecision[ValidatedInput](
                    status="BLOCK",
                    response_key=GUARDRAIL_INPUT_PII,
                    reason="PII detected",
                )
            else:
                decision = PipelineDecision[ValidatedInput](
                    status="BLOCK",
                    response_key=GUARDRAIL_INPUT_INJECTION,
                    reason="Input validation failed closed",
                )

        if decision.status == "PASS" and deterministic_pii_match(message):
            decision = PipelineDecision[ValidatedInput](
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_PII,
                reason="PII detected",
            )

        if decision.status == "BLOCK":
            blocked_event: ErrorEvent
            if decision.response_key == GUARDRAIL_INPUT_PII:
                logger.warning("Ingress PII detected in user message: REDACTED")
                blocked_event = ErrorEvent(
                    data=ErrorPayload(
                        code="GUARDRAIL_BLOCKED",
                        message="Your message contains protected personal information and cannot be processed.",
                        partialMessageId=None,
                    )
                )
            else:
                code = decision.response_key or "GUARDRAIL_INPUT_BLOCKED"
                logger.warning(
                    "Ingress input blocked by security guardrail: %s (reason: %s)",
                    code,
                    decision.reason,
                )
                blocked_event = ErrorEvent(
                    data=ErrorPayload(
                        code=code,
                        message=f"Input rejected by security guardrail: {code}",
                        partialMessageId=None,
                    )
                )

            return InputAdmissionResult(
                decision=decision,
                validated_input=None,
                blocked_event=blocked_event,
            )

        validated_input = decision.validated_data
        if validated_input is None:
            validated_input = ValidatedInput(content=message)
            decision = PipelineDecision[ValidatedInput](
                status="PASS",
                reason=decision.reason,
                response_key=decision.response_key,
                validated_data=validated_input,
            )

        return InputAdmissionResult(
            decision=decision,
            validated_input=validated_input,
            blocked_event=None,
        )
