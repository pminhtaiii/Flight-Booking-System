from typing import Any, AsyncIterator, Optional

from agent.chat_turn.command import ChatTurnCommand
from agent.chat_turn.events import ChatTurnEvent, ErrorEvent, ErrorPayload
from agent.guardrails.base import AdmissionContext
from agent.guardrails.gateway import GuardrailGateway


class ChatController:
    """
    Thin delegator orchestrating chat turns.
    Enforces mandatory security gateway validation before invoking execution runner.
    """

    def __init__(
        self,
        runner: Any,
        gateway: Optional[GuardrailGateway] = None,
    ) -> None:
        self.runner = runner
        self.gateway = gateway

    async def stream(self, command: ChatTurnCommand) -> AsyncIterator[ChatTurnEvent]:
        """
        Stream chat turn events with mandatory security gateway validation.
        """
        if self.gateway is None:
            yield ErrorEvent(
                data=ErrorPayload(
                    code="GUARDRAIL_CONFIGURATION_ERROR",
                    message=(
                        "Chat execution rejected: mandatory guardrail gateway is absent "
                        "or unconfigured."
                    ),
                )
            )
            return

        if command.message:
            context = AdmissionContext(
                user_id=command.user_id,
                chat_session_id=command.session_id or "unassigned",
                trace_id=command.trace_id or "trace-default",
                correlation_id=command.correlation_id,
                policy_version="2026-09-05",
            )
            try:
                decision = await self.gateway.validate_input(context, command.message)
            except Exception:
                yield ErrorEvent(
                    data=ErrorPayload(
                        code="GUARDRAIL_INPUT_INJECTION",
                        message="Input rejected by security guardrail: GUARDRAIL_INPUT_INJECTION",
                    )
                )
                return

            if decision.status == "BLOCK":
                code = decision.response_key or "GUARDRAIL_INPUT_BLOCKED"
                yield ErrorEvent(
                    data=ErrorPayload(
                        code=code,
                        message=f"Input rejected by security guardrail: {code}",
                    )
                )
                return

        async for event in self.runner.run(command):
            yield event


__all__ = ["ChatController"]
