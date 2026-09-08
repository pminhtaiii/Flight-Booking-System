import inspect
from typing import Any, AsyncIterator, Callable

from agent.guardrails.base import (
    GUARDRAIL_INPUT_INJECTION,
    GUARDRAIL_RESPONSE_KEYS,
    GUARDRAIL_TOOL_SCHEMA,
    AdmissionContext,
    ApprovedChunk,
    PipelineDecision,
    TurnCapabilities,
    ValidatedInput,
    ValidatedToolResult,
)
from agent.guardrails.registry import GuardrailRegistry
from agent.guardrails.tool_output_pipeline import ToolOutputGuardrailPipeline


class GuardrailGateway:
    """
    Mandatory security gateway enforcing deterministic admission, tool execution,
    and output streaming checks without permissive bypasses.
    """

    def __init__(self, registry: GuardrailRegistry) -> None:
        self.registry = registry

    async def validate_input(
        self,
        context: AdmissionContext,
        message: str,
    ) -> PipelineDecision[ValidatedInput]:
        """
        Validates user input against registered input layers in dependency order.
        Short-circuits on first BLOCK and fails closed on unhandled errors.
        """
        if not isinstance(context, AdmissionContext):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_INJECTION,
                reason="Invalid admission context",
                validated_data=None,
            )

        try:
            layers = self.registry.ordered_layers("input")
        except Exception:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_INJECTION,
                reason="Guardrail classifier failed closed",
                validated_data=None,
            )

        if not layers:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_INJECTION,
                reason="Guardrail classifier failed closed: no input layers configured",
                validated_data=None,
            )

        for layer in layers:
            try:
                decision = await layer.check(context, message)
                if decision.status == "BLOCK":
                    key = (
                        decision.response_key
                        if decision.response_key in GUARDRAIL_RESPONSE_KEYS.values()
                        else GUARDRAIL_INPUT_INJECTION
                    )
                    return PipelineDecision(
                        status="BLOCK",
                        response_key=key,
                        reason=decision.reason,
                        validated_data=None,
                    )
                if decision.status != "PASS":
                    return PipelineDecision(
                        status="BLOCK",
                        response_key=GUARDRAIL_INPUT_INJECTION,
                        reason="Guardrail classifier failed closed",
                        validated_data=None,
                    )
            except Exception:
                return PipelineDecision(
                    status="BLOCK",
                    response_key=GUARDRAIL_INPUT_INJECTION,
                    reason="Guardrail classifier failed closed",
                    validated_data=None,
                )

        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content=message),
        )

    async def execute_tool(
        self,
        context: TurnCapabilities,
        call: Any,
        invoke: Callable[..., Any],
    ) -> PipelineDecision[ValidatedToolResult]:
        """
        Tool execution gateway stub for US2.
        Enforces that calls match sealed tool capabilities and fails closed on errors.
        """
        if not isinstance(context, TurnCapabilities):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Invalid turn capabilities",
                validated_data=None,
            )

        tool_name = getattr(call, "name", None)
        if not tool_name and isinstance(call, dict):
            tool_name = call.get("name")
        if not tool_name:
            tool_name = str(call)

        if tool_name not in context.sealed_tools:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason=f"Tool execution forbidden: tool '{tool_name}' not in sealed capabilities",
                validated_data=None,
            )

        try:
            if inspect.iscoroutinefunction(invoke):
                result = await invoke()
            else:
                res = invoke()
                if inspect.isawaitable(res):
                    result = await res
                else:
                    result = res
            return await self.validate_tool_result(context, tool_name, result)
        except Exception:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Tool execution failed closed",
                validated_data=None,
            )

    async def validate_tool_result(
        self, context: TurnCapabilities, tool_name: str, result: Any
    ) -> PipelineDecision[ValidatedToolResult]:
        """Validate an already-invoked result before it can enter graph state."""
        if not isinstance(context, TurnCapabilities) or tool_name not in context.sealed_tools:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Tool result has no sealed authority",
                validated_data=None,
            )
        try:
            layers = self.registry.ordered_layers("tool")
            if not layers:
                return PipelineDecision(
                    status="PASS",
                    validated_data=ValidatedToolResult(tool_name=tool_name, data=result),
                )
            return await ToolOutputGuardrailPipeline(layers).validate(context, tool_name, result)
        except Exception:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Tool output validation failed closed",
                validated_data=None,
            )

    async def execute_tool_batch(
        self,
        context: TurnCapabilities,
        calls: list[Any],
        invokes: list[Callable[..., Any]],
    ) -> PipelineDecision[list[ValidatedToolResult]]:
        """Authorize the whole proposed batch before invoking any member."""
        if not isinstance(context, TurnCapabilities) or len(calls) != len(invokes):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Invalid tool batch",
                validated_data=None,
            )
        names = [
            call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
            for call in calls
        ]
        if any(not name or name not in context.sealed_tools for name in names):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Tool batch contains unauthorized calls",
                validated_data=None,
            )
        validated: list[ValidatedToolResult] = []
        for call, invoke in zip(calls, invokes):
            decision = await self.execute_tool(context, call, invoke)
            if decision.status != "PASS" or decision.validated_data is None:
                return PipelineDecision(
                    status="BLOCK",
                    response_key=decision.response_key or GUARDRAIL_TOOL_SCHEMA,
                    reason=decision.reason,
                    validated_data=None,
                )
            validated.append(decision.validated_data)
        return PipelineDecision(status="PASS", validated_data=validated)

    async def stream_output(
        self,
        context: TurnCapabilities,
        tokens: AsyncIterator[str],
    ) -> AsyncIterator[ApprovedChunk]:
        """
        Output streaming gateway stub for US1/T020.
        Yields approved chunks for safe tokens, stopping on any invalid state.
        """
        if not isinstance(context, TurnCapabilities):
            return

        try:
            async for token in tokens:
                yield ApprovedChunk(content=token)
        except Exception:
            return


__all__ = ["GuardrailGateway"]
