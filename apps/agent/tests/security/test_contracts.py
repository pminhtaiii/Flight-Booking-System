import pytest
from pydantic import ValidationError

from agent.guardrails.base import (
    GUARDRAIL_INPUT_INJECTION,
    GUARDRAIL_INPUT_LENGTH,
    GUARDRAIL_INPUT_PII,
    GUARDRAIL_INPUT_TOPIC,
    GUARDRAIL_OUTPUT_PII,
    GUARDRAIL_RESPONSE_KEYS,
    GUARDRAIL_TOOL_PII,
    GUARDRAIL_TOOL_SCHEMA,
    AdmissionContext,
    ApprovedChunk,
    PipelineDecision,
    TurnCapabilities,
    ValidatedInput,
    ValidatedToolResult,
)

pytestmark = pytest.mark.security


def test_admission_context_is_immutable_and_has_zero_tool_authority() -> None:
    context = AdmissionContext(
        user_id="user-123",
        chat_session_id="session-123",
        trace_id="trace-123",
        correlation_id=None,
        policy_version="2026-09-05",
    )

    assert set(type(context).model_fields) == {
        "user_id",
        "chat_session_id",
        "trace_id",
        "correlation_id",
        "policy_version",
    }
    assert not any("tool" in field.lower() for field in type(context).model_fields)
    with pytest.raises(ValidationError):
        AdmissionContext(
            user_id="user-123",
            chat_session_id="session-123",
            trace_id="trace-123",
            correlation_id=None,
            policy_version="2026-09-05",
            sealed_tools=("search_flights",),
        )
    with pytest.raises(ValidationError):
        context.user_id = "attacker"


def test_turn_capabilities_are_sealed_and_immutable() -> None:
    capabilities = TurnCapabilities(
        intent="SEARCH",
        provenance="trusted_router",
        sealed_tools=("search_flights",),
    )

    assert capabilities.is_sealed is True
    with pytest.raises(ValidationError):
        capabilities.sealed_tools = ("signal_checkout_intent",)
    with pytest.raises(ValidationError):
        TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router",
            sealed_tools=("search_flights",),
            is_sealed=False,
        )


def test_block_decision_discards_rejected_payload() -> None:
    rejected = ValidatedInput(content="private rejected content")

    decision = PipelineDecision[ValidatedInput](
        status="BLOCK",
        reason="input policy violation",
        response_key=GUARDRAIL_INPUT_PII,
        validated_data=rejected,
    )

    assert decision.validated_data is None
    assert "private rejected content" not in decision.model_dump_json()


def test_pass_decision_preserves_only_validated_payload() -> None:
    validated = ValidatedToolResult(tool_name="search_flights", data={"count": 1})

    decision = PipelineDecision[ValidatedToolResult](
        status="PASS",
        validated_data=validated,
    )

    assert decision.validated_data == validated


def test_payload_types_are_immutable_and_strict() -> None:
    payloads = (
        ValidatedInput(content="find flights"),
        ValidatedToolResult(tool_name="search_flights", data={"count": 1}),
        ApprovedChunk(content="One approved chunk"),
    )

    for payload in payloads:
        with pytest.raises(ValidationError):
            payload.unexpected = "value"


def test_static_response_keys_are_closed_and_non_leaking() -> None:
    expected = {
        "input_length": GUARDRAIL_INPUT_LENGTH,
        "input_pii": GUARDRAIL_INPUT_PII,
        "input_injection": GUARDRAIL_INPUT_INJECTION,
        "input_topic": GUARDRAIL_INPUT_TOPIC,
        "tool_schema": GUARDRAIL_TOOL_SCHEMA,
        "tool_pii": GUARDRAIL_TOOL_PII,
        "output_pii": GUARDRAIL_OUTPUT_PII,
    }

    assert GUARDRAIL_RESPONSE_KEYS == expected
    assert len(set(GUARDRAIL_RESPONSE_KEYS.values())) == len(expected)
    assert all(value.startswith("GUARDRAIL_") for value in expected.values())
    assert all("{" not in value and "}" not in value for value in expected.values())
