"""
agent.guardrails.input_pipeline
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Sequential input guardrail execution pipeline enforcing deterministic layer ordering,
fail-closed error handling, immediate short-circuiting, and bounded input normalization.
"""

from agent.guardrails.base import (
    GUARDRAIL_INPUT_INJECTION,
    GUARDRAIL_RESPONSE_KEYS,
    AdmissionContext,
    PipelineDecision,
    ValidatedInput,
)
from agent.guardrails.normalization import bounded_normalize
from agent.guardrails.registry import GuardrailRegistry


class InputGuardrailPipeline:
    """
    Orchestrates the sequential execution of input guardrail layers in strict
    dependency order from the GuardrailRegistry.
    Short-circuits on the first BLOCK decision and returns normalized content on PASS.
    """

    def __init__(self, registry: GuardrailRegistry) -> None:
        self.registry = registry

    async def execute(
        self,
        context: AdmissionContext,
        content: str,
    ) -> PipelineDecision[ValidatedInput]:
        """
        Executes registered input layers sequentially against user input.

        Args:
            context: Authenticated AdmissionContext (no tool authority).
            content: Raw input string from the user.

        Returns:
            PipelineDecision[ValidatedInput] with normalized content on PASS,
            or BLOCK with static response key and None validated_data.
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

        current_content = content
        for layer in layers:
            try:
                decision = await layer.check(context, current_content)
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

        normalized = bounded_normalize(current_content)
        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content=normalized),
        )


__all__ = ["InputGuardrailPipeline"]
