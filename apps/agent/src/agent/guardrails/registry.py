from typing import Any, ClassVar, Literal

from agent.guardrails.base import (
    GUARDRAIL_OUTPUT_PII,
    AdmissionContext,
    ApprovedChunk,
    BaseGuardrailLayer,
    PipelineDecision,
    TurnCapabilities,
)
from agent.guardrails.layers.injection import (
    INJECTION_SIGNATURES,
)
from agent.guardrails.layers.input import (
    OUT_OF_DOMAIN_PATTERNS,
    InjectionDetector,
    LengthValidator,
    PIIDetector,
    TopicBoundary,
)
from agent.guardrails.layers.tool_output import (
    PIIScanner,
    SchemaValidator,
    SizeStructureValidator,
    UntrustedContentInjectionDetector,
)
from agent.sanitization.pii_scrubber import detect_pii

# Re-export and maintain backwards-compatible aliases
InputLengthLayer = LengthValidator
InputPIILayer = PIIDetector
InputInjectionLayer = InjectionDetector
InputTopicLayer = TopicBoundary
INJECTION_PATTERNS = INJECTION_SIGNATURES

COMPULSORY_PRODUCTION_LAYERS: frozenset[str] = frozenset(
    {
        "input.length",
        "input.pii",
        "input.injection",
        "input.topic",
        "output.pii",
        "tool.size_structure",
        "tool.schema",
        "tool.pii",
        "tool.untrusted_content_injection",
    }
)


class RegistryContractError(Exception):
    """Raised when a guardrail registry contract rule is violated."""


class OutputPIILayer(BaseGuardrailLayer):
    key: ClassVar[str] = "output.pii"
    stage: ClassVar[Literal["output"]] = "output"
    prerequisites: ClassVar[tuple[str, ...]] = ()

    async def check(
        self,
        context: AdmissionContext | TurnCapabilities,
        data: Any,
    ) -> PipelineDecision[Any]:
        content = data if isinstance(data, str) else getattr(data, "content", str(data))
        if detect_pii(content):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_OUTPUT_PII,
                reason="Output contains personally identifiable information (PII)",
                validated_data=None,
            )
        return PipelineDecision(
            status="PASS",
            validated_data=ApprovedChunk(content=content),
        )


class GuardrailRegistry:
    """Closed registry managing guardrail layers, dependency ordering, and execution stages."""

    def __init__(
        self,
        allowed_keys: set[str] | None = None,
        production: bool = False,
    ) -> None:
        self.allowed_keys: set[str] | None = set(allowed_keys) if allowed_keys is not None else None
        self.production: bool = bool(production)
        self._layers: dict[str, Any] = {}

    def register(self, layer: Any) -> None:
        key = getattr(layer, "key", None)
        if not key or not isinstance(key, str):
            raise RegistryContractError("Layer must define a non-empty string 'key' attribute.")

        if self.allowed_keys is not None and key not in self.allowed_keys:
            raise RegistryContractError(f"Layer key '{key}' is not in allowed_keys.")

        if key in self._layers:
            raise RegistryContractError(f"Duplicate layer key '{key}' is already registered.")

        stage = getattr(layer, "stage", None)
        if stage not in ("input", "tool", "output"):
            raise RegistryContractError(
                f"Layer '{key}' stage must be 'input', 'tool', or 'output', got '{stage}'."
            )

        self._layers[key] = layer

    def get(self, key: str) -> Any:
        if self.allowed_keys is not None and key not in self.allowed_keys:
            raise RegistryContractError(f"Layer key '{key}' is not permitted by allowed_keys.")

        if key not in self._layers:
            raise RegistryContractError(f"Layer key '{key}' is not registered.")

        return self._layers[key]

    def keys(self) -> set[str]:
        return set(self._layers.keys())

    def inject_for_test(self, layer: Any) -> None:
        if self.production:
            raise RegistryContractError("inject_for_test is strictly forbidden in production mode.")

        key = getattr(layer, "key", None)
        if not key or not isinstance(key, str):
            raise RegistryContractError("Layer must define a non-empty string 'key' attribute.")

        if self.allowed_keys is not None and key not in self.allowed_keys:
            raise RegistryContractError(f"Layer key '{key}' is not in allowed_keys.")

        stage = getattr(layer, "stage", None)
        if stage not in ("input", "tool", "output"):
            raise RegistryContractError(
                f"Layer '{key}' stage must be 'input', 'tool', or 'output', got '{stage}'."
            )

        self._layers[key] = layer

    def ordered_layers(self, stage: Literal["input", "tool", "output"]) -> list[Any]:
        if stage not in ("input", "tool", "output"):
            raise RegistryContractError(
                f"Invalid stage '{stage}'. Must be 'input', 'tool', or 'output'."
            )

        stage_layers = {k: v for k, v in self._layers.items() if getattr(v, "stage", None) == stage}
        if not stage_layers:
            return []

        stage_order = {"input": 0, "tool": 1, "output": 2}
        current_stage_rank = stage_order[stage]

        for v_key, layer in stage_layers.items():
            prereqs = getattr(layer, "prerequisites", ())
            for p in prereqs:
                if p not in self._layers:
                    raise RegistryContractError(
                        f"Missing prerequisite '{p}' required by layer '{v_key}'."
                    )
                p_layer = self._layers[p]
                p_stage = getattr(p_layer, "stage", None)
                if stage_order.get(p_stage, 99) > current_stage_rank:
                    raise RegistryContractError(
                        f"Prerequisite '{p}' in stage '{p_stage}' cannot precede stage '{stage}'."
                    )

        reg_order = {k: idx for idx, k in enumerate(self._layers.keys())}
        in_degree: dict[str, int] = {k: 0 for k in stage_layers}
        dependents: dict[str, list[str]] = {k: [] for k in stage_layers}

        for v_key, layer in stage_layers.items():
            prereqs = getattr(layer, "prerequisites", ())
            for p in set(prereqs):
                if p in stage_layers:
                    dependents[p].append(v_key)
                    in_degree[v_key] += 1

        ready = [k for k, deg in in_degree.items() if deg == 0]
        ready.sort(key=lambda k: reg_order[k])

        result: list[Any] = []
        while ready:
            curr = ready.pop(0)
            result.append(stage_layers[curr])
            for dep in dependents[curr]:
                in_degree[dep] -= 1
                if in_degree[dep] == 0:
                    ready.append(dep)
                    ready.sort(key=lambda k: reg_order[k])

        if len(result) != len(stage_layers):
            raise RegistryContractError(
                f"Cyclic prerequisites detected among layers in stage '{stage}'."
            )

        return result


def create_production_registry(
    disabled_keys: set[str] | None = None,
) -> GuardrailRegistry:
    effective_disabled = set(disabled_keys) if disabled_keys is not None else set()
    disabled_compulsory = effective_disabled.intersection(COMPULSORY_PRODUCTION_LAYERS)
    if disabled_compulsory:
        raise RegistryContractError(
            f"Compulsory production layers cannot be disabled: {sorted(disabled_compulsory)}"
        )

    registry = GuardrailRegistry(
        allowed_keys=set(COMPULSORY_PRODUCTION_LAYERS),
        production=True,
    )

    default_layers = (
        LengthValidator(),
        PIIDetector(),
        InjectionDetector(),
        TopicBoundary(),
        OutputPIILayer(),
        SizeStructureValidator(),
        SchemaValidator(),
        PIIScanner(),
        UntrustedContentInjectionDetector(),
    )
    for layer in default_layers:
        if layer.key not in effective_disabled:
            registry.register(layer)

    return registry


__all__ = [
    "COMPULSORY_PRODUCTION_LAYERS",
    "RegistryContractError",
    "BaseGuardrailLayer",
    "OutputPIILayer",
    "GuardrailRegistry",
    "create_production_registry",
    "LengthValidator",
    "PIIDetector",
    "InjectionDetector",
    "TopicBoundary",
    "InputLengthLayer",
    "InputPIILayer",
    "InputInjectionLayer",
    "InputTopicLayer",
    "INJECTION_PATTERNS",
    "OUT_OF_DOMAIN_PATTERNS",
]
