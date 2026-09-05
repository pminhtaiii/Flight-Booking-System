from types import MappingProxyType
from typing import Any, Generic, Literal, Mapping, Protocol, Tuple, TypeVar, runtime_checkable

from pydantic import BaseModel, ConfigDict, model_validator

GUARDRAIL_INPUT_LENGTH = "GUARDRAIL_INPUT_LENGTH"
GUARDRAIL_INPUT_PII = "GUARDRAIL_INPUT_PII"
GUARDRAIL_INPUT_INJECTION = "GUARDRAIL_INPUT_INJECTION"
GUARDRAIL_INPUT_TOPIC = "GUARDRAIL_INPUT_TOPIC"
GUARDRAIL_TOOL_SCHEMA = "GUARDRAIL_TOOL_SCHEMA"
GUARDRAIL_TOOL_PII = "GUARDRAIL_TOOL_PII"
GUARDRAIL_OUTPUT_PII = "GUARDRAIL_OUTPUT_PII"

GUARDRAIL_RESPONSE_KEYS: Mapping[str, str] = MappingProxyType(
    {
        "input_length": GUARDRAIL_INPUT_LENGTH,
        "input_pii": GUARDRAIL_INPUT_PII,
        "input_injection": GUARDRAIL_INPUT_INJECTION,
        "input_topic": GUARDRAIL_INPUT_TOPIC,
        "tool_schema": GUARDRAIL_TOOL_SCHEMA,
        "tool_pii": GUARDRAIL_TOOL_PII,
        "output_pii": GUARDRAIL_OUTPUT_PII,
    }
)


class _ImmutableContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class AdmissionContext(_ImmutableContract):
    """Authenticated context available before routing, with zero tool authority."""

    user_id: str
    chat_session_id: str
    trace_id: str
    correlation_id: str | None
    policy_version: str


class TurnCapabilities(_ImmutableContract):
    """Trusted, sealed authority derived after routing and deterministic gates."""

    intent: str
    provenance: str
    sealed_tools: tuple[str, ...]
    is_sealed: Literal[True] = True


class ValidatedInput(_ImmutableContract):
    content: str


class ValidatedToolResult(_ImmutableContract):
    tool_name: str
    data: Any


class ApprovedChunk(_ImmutableContract):
    content: str


T = TypeVar("T")


class PipelineDecision(_ImmutableContract, Generic[T]):
    status: Literal["PASS", "BLOCK"]
    reason: str | None = None
    response_key: str | None = None
    validated_data: T | None = None

    @model_validator(mode="before")
    @classmethod
    def discard_blocked_data(cls, data: Any) -> Any:
        """Remove rejected content before it can become accessible on the model."""
        if isinstance(data, Mapping) and data.get("status") == "BLOCK":
            return {**data, "validated_data": None}
        return data

    @model_validator(mode="after")
    def validate_transition(self) -> "PipelineDecision[T]":
        """Require a complete, static decision at the gateway seam."""
        if self.status == "PASS" and self.validated_data is None:
            raise ValueError("PASS decisions require validated_data")
        static_keys = set(GUARDRAIL_RESPONSE_KEYS.values())
        if self.response_key is not None and self.response_key not in static_keys:
            raise ValueError("response_key must be a static guardrail key")
        if self.status == "BLOCK" and self.response_key is None:
            raise ValueError("BLOCK decisions require response_key")
        return self


TIn = TypeVar("TIn", contravariant=True)
TOut = TypeVar("TOut", covariant=True)


@runtime_checkable
class GuardrailLayer(Protocol[TIn, TOut]):
    key: str
    stage: Literal["input", "tool", "output"]
    prerequisites: tuple[str, ...]

    async def check(
        self,
        context: AdmissionContext | TurnCapabilities,
        data: TIn,
    ) -> PipelineDecision[TOut]: ...


class GuardrailService(Protocol):
    async def validate_message(self, message: str) -> Tuple[bool, str]:
        """
        Validates the input message.

        Args:
            message: The raw input message string from the user.

        Returns:
            Tuple[bool, str]: A tuple where the first element indicates whether the message
                             is allowed, and the second element is the error reason if blocked
                             (or an empty string if allowed).
        """
        ...

    async def validate_output_chunk(self, chunk: str) -> Tuple[bool, str]:
        """
        Validates an output chunk.

        Args:
            chunk: The output chunk string.

        Returns:
            Tuple[bool, str]: A tuple where the first element indicates whether the chunk
                             is allowed, and the second element is the error reason if blocked
                             (or an empty string if allowed).
        """
        ...

    def is_healthy(self) -> bool:
        """
        Checks if the guardrail service is healthy and available.

        Returns:
            bool: True if the service is healthy, False otherwise.
        """
        ...
