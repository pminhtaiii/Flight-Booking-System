"""Fail-closed orchestration for the fixed tool-result validation chain."""

from typing import Any, Sequence

from agent.guardrails.base import (
    GUARDRAIL_TOOL_SCHEMA,
    PipelineDecision,
    TurnCapabilities,
    ValidatedToolResult,
)
from agent.guardrails.layers.tool_output import (
    PIIScanner,
    SchemaValidator,
    SizeStructureValidator,
    ToolOutput,
    UntrustedContentInjectionDetector,
)

_EXPECTED_LAYER_TYPES = (
    SizeStructureValidator,
    SchemaValidator,
    PIIScanner,
    UntrustedContentInjectionDetector,
)


class ToolOutputGuardrailPipeline:
    def __init__(self, layers: Sequence[Any]) -> None:
        self._layers = tuple(layers)

    async def validate(
        self,
        context: TurnCapabilities,
        tool_name: str,
        raw_result: Any,
    ) -> PipelineDecision[ValidatedToolResult]:
        if len(self._layers) != len(_EXPECTED_LAYER_TYPES) or any(
            not isinstance(layer, expected)
            for layer, expected in zip(self._layers, _EXPECTED_LAYER_TYPES)
        ):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Tool output guardrail pipeline is misconfigured",
                validated_data=None,
            )

        current: Any = ToolOutput(tool_name=tool_name, data=raw_result)
        for layer in self._layers:
            try:
                decision = await layer.check(context, current)
            except Exception:
                return PipelineDecision(
                    status="BLOCK",
                    response_key=GUARDRAIL_TOOL_SCHEMA,
                    reason="Tool output validation failed closed",
                    validated_data=None,
                )
            if decision.status != "PASS" or not isinstance(decision.validated_data, ToolOutput):
                if isinstance(layer, SchemaValidator):
                    pii_decision = await self._layers[2].check(context, current)
                    if pii_decision.status == "BLOCK":
                        return PipelineDecision(
                            status="BLOCK",
                            response_key=pii_decision.response_key or GUARDRAIL_TOOL_SCHEMA,
                            reason=pii_decision.reason or "Tool output validation failed closed",
                            validated_data=None,
                        )
                return PipelineDecision(
                    status="BLOCK",
                    response_key=decision.response_key or GUARDRAIL_TOOL_SCHEMA,
                    reason=decision.reason or "Tool output validation failed closed",
                    validated_data=None,
                )
            current = decision.validated_data

        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedToolResult(tool_name=tool_name, data=current.data),
        )


__all__ = ["ToolOutputGuardrailPipeline"]
