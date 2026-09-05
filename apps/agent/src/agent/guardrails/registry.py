import re
from typing import Any, ClassVar, Literal

from agent.guardrails.base import (
    GUARDRAIL_INPUT_INJECTION,
    GUARDRAIL_INPUT_LENGTH,
    GUARDRAIL_INPUT_PII,
    GUARDRAIL_INPUT_TOPIC,
    GUARDRAIL_OUTPUT_PII,
    AdmissionContext,
    ApprovedChunk,
    PipelineDecision,
    TurnCapabilities,
    ValidatedInput,
)
from agent.guardrails.normalization import (
    bounded_normalize,
    detect_base64_payloads,
    safe_regex_match,
)
from agent.sanitization.pii_scrubber import detect_pii

COMPULSORY_PRODUCTION_LAYERS: frozenset[str] = frozenset(
    {
        "input.length",
        "input.pii",
        "input.injection",
        "input.topic",
        "output.pii",
    }
)


class RegistryContractError(Exception):
    """Raised when a guardrail registry contract rule is violated."""


class BaseGuardrailLayer:
    """Standard base implementation satisfying the GuardrailLayer protocol."""

    key: ClassVar[str] = ""
    stage: ClassVar[Literal["input", "tool", "output"]] = "input"
    prerequisites: ClassVar[tuple[str, ...]] = ()

    def __init__(
        self,
        key: str | None = None,
        stage: Literal["input", "tool", "output"] | None = None,
        prerequisites: tuple[str, ...] | None = None,
    ) -> None:
        if key is not None:
            self.key = key
        if stage is not None:
            self.stage = stage
        if prerequisites is not None:
            self.prerequisites = prerequisites

    async def check(
        self,
        context: AdmissionContext | TurnCapabilities,
        data: Any,
    ) -> PipelineDecision[Any]:
        if self.stage == "input":
            content = data if isinstance(data, str) else getattr(data, "content", str(data))
            return PipelineDecision(status="PASS", validated_data=ValidatedInput(content=content))
        if self.stage == "output":
            content = data if isinstance(data, str) else getattr(data, "content", str(data))
            return PipelineDecision(status="PASS", validated_data=ApprovedChunk(content=content))
        return PipelineDecision(status="PASS", validated_data=data)


class InputLengthLayer(BaseGuardrailLayer):
    key: ClassVar[str] = "input.length"
    stage: ClassVar[Literal["input"]] = "input"
    prerequisites: ClassVar[tuple[str, ...]] = ()

    def __init__(
        self,
        max_characters: int = 4096,
        max_bytes: int = 16384,
        key: str | None = None,
        stage: Literal["input", "tool", "output"] | None = None,
        prerequisites: tuple[str, ...] | None = None,
    ) -> None:
        super().__init__(key=key, stage=stage, prerequisites=prerequisites)
        self.max_characters = max_characters
        self.max_bytes = max_bytes

    async def check(
        self,
        context: AdmissionContext | TurnCapabilities,
        data: Any,
    ) -> PipelineDecision[Any]:
        content = data if isinstance(data, str) else getattr(data, "content", str(data))
        if len(content) > self.max_characters:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_LENGTH,
                reason=f"Input exceeds maximum character length {self.max_characters}",
                validated_data=None,
            )
        if len(content.encode("utf-8")) > self.max_bytes:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_LENGTH,
                reason=f"Input exceeds maximum byte length {self.max_bytes}",
                validated_data=None,
            )
        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content=content),
        )


INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"ignore\s+previous\s+instructions", re.IGNORECASE),
    re.compile(r"ignore\s+all\s+previous\s+instructions", re.IGNORECASE),
    re.compile(r"system\s+prompt", re.IGNORECASE),
    re.compile(r"reveal\s+prompt", re.IGNORECASE),
    re.compile(r"reveal\s+the\s+prompt", re.IGNORECASE),
    re.compile(r"forget\s+what\s+you", re.IGNORECASE),
    re.compile(r"disregard\s+instructions", re.IGNORECASE),
    re.compile(r"disregard\s+all\s+instructions", re.IGNORECASE),
    re.compile(r"\bdrop\s+table\b", re.IGNORECASE),
)

OUT_OF_DOMAIN_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Code generation and programming requests
    re.compile(r"\bpython\s+script\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+code\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+some\s+code\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+script\b", re.IGNORECASE),
    re.compile(r"\bhow\s+to\s+code\b", re.IGNORECASE),
    re.compile(r"\bcode\s+in\s+typescript\b", re.IGNORECASE),
    re.compile(r"\bcode\s+in\s+python\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+program\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+an\s+algorithm\b", re.IGNORECASE),
    # Creative writing (essays, stories, poems)
    re.compile(r"\bwrite\s+an\s+essay\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+essay\b", re.IGNORECASE),
    re.compile(r"\btell\s+me\s+a\s+story\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+story\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+poem\b", re.IGNORECASE),
    re.compile(r"\bcompose\s+a\s+poem\b", re.IGNORECASE),
    # Medical advice
    re.compile(r"\bmedical\s+advice\b", re.IGNORECASE),
    re.compile(r"\bwhat\s+medicine\s+should\s+i\s+take\b", re.IGNORECASE),
    re.compile(r"\bdiagnose\s+my\b", re.IGNORECASE),
    re.compile(r"\bprescribe\s+me\b", re.IGNORECASE),
    # Legal advice
    re.compile(r"\blegal\s+advice\b", re.IGNORECASE),
    re.compile(r"\blegal\s+counsel\b", re.IGNORECASE),
    re.compile(r"\bhow\s+to\s+sue\b", re.IGNORECASE),
    re.compile(r"\bfile\s+a\s+lawsuit\b", re.IGNORECASE),
)


class InputPIILayer(BaseGuardrailLayer):
    key: ClassVar[str] = "input.pii"
    stage: ClassVar[Literal["input"]] = "input"
    prerequisites: ClassVar[tuple[str, ...]] = ("input.length",)

    async def check(
        self,
        context: AdmissionContext | TurnCapabilities,
        data: Any,
    ) -> PipelineDecision[Any]:
        content = data if isinstance(data, str) else getattr(data, "content", str(data))
        if detect_pii(content):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_PII,
                reason="Input contains personally identifiable information (PII)",
                validated_data=None,
            )
        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content=content),
        )


class InputInjectionLayer(BaseGuardrailLayer):
    key: ClassVar[str] = "input.injection"
    stage: ClassVar[Literal["input"]] = "input"
    prerequisites: ClassVar[tuple[str, ...]] = ("input.length",)

    async def check(
        self,
        context: AdmissionContext | TurnCapabilities,
        data: Any,
    ) -> PipelineDecision[Any]:
        content = data if isinstance(data, str) else getattr(data, "content", str(data))
        candidates = [content, bounded_normalize(content)]
        for payload in detect_base64_payloads(content):
            candidates.append(payload)
            candidates.append(bounded_normalize(payload))

        for candidate in candidates:
            for pattern in INJECTION_PATTERNS:
                if safe_regex_match(pattern, candidate):
                    return PipelineDecision(
                        status="BLOCK",
                        response_key=GUARDRAIL_INPUT_INJECTION,
                        reason="Prompt injection detected",
                        validated_data=None,
                    )

        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content=content),
        )


class InputTopicLayer(BaseGuardrailLayer):
    key: ClassVar[str] = "input.topic"
    stage: ClassVar[Literal["input"]] = "input"
    prerequisites: ClassVar[tuple[str, ...]] = ("input.length",)

    async def check(
        self,
        context: AdmissionContext | TurnCapabilities,
        data: Any,
    ) -> PipelineDecision[Any]:
        content = data if isinstance(data, str) else getattr(data, "content", str(data))
        for pattern in OUT_OF_DOMAIN_PATTERNS:
            if safe_regex_match(pattern, content):
                return PipelineDecision(
                    status="BLOCK",
                    response_key=GUARDRAIL_INPUT_TOPIC,
                    reason="Input contains out-of-domain request",
                    validated_data=None,
                )

        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content=content),
        )


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
        InputLengthLayer(),
        InputPIILayer(),
        InputInjectionLayer(),
        InputTopicLayer(),
        OutputPIILayer(),
    )
    for layer in default_layers:
        if layer.key not in effective_disabled:
            registry.register(layer)

    return registry
