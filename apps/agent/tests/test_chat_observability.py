import json
import logging

import pytest

from agent.observability.chat_observability import (
    ChatTelemetry,
    TelemetryPrivacyError,
    safe_tool_name,
)


def test_chat_telemetry_emits_only_allowlisted_bounded_fields(caplog):
    telemetry = ChatTelemetry()

    with caplog.at_level(logging.INFO, logger="agent.chat_observability"):
        event = telemetry.emit(
            "quota_admission",
            status="accepted",
            latency_ms=12.4,
            trace_id="chat_" + ("a1" * 16),
            correlation_id="chat_" + ("b2" * 16),
            fields={
                "outcome": "admitted",
                "dependency": "redis",
            },
        )

    assert event["operation"] == "quota_admission"
    assert event["status"] == "accepted"
    assert event["latency_ms"] == 12
    assert event["trace_id"] == "chat_" + ("a1" * 16)
    assert event["correlation_id"] == "chat_" + ("b2" * 16)
    assert json.loads(caplog.records[-1].message.split(" ", 1)[1]) == event


@pytest.mark.parametrize(
    "field_name,field_value",
    [
        ("message", "book flight from HAN to NRT"),
        ("token", "handoff-secret"),
        ("offer_id", "off_123"),
        ("user_id", "user_123"),
        ("session_id", "session_123"),
        ("url", "https://example.test/checkout"),
        ("passenger_name", "Ada Lovelace"),
        ("payment_data", "4111111111111111"),
        ("passport_number", "P1234567"),
    ],
)
def test_chat_telemetry_rejects_sensitive_or_unknown_fields(field_name, field_value):
    telemetry = ChatTelemetry()

    with pytest.raises(TelemetryPrivacyError):
        telemetry.emit(
            "tool_call",
            status="failed",
            fields={field_name: field_value},
        )


@pytest.mark.parametrize(
    "field_name",
    [
        "outcome",
        "dependency",
        "error_class",
        "tool_name",
        "route",
        "snapshot_state",
        "handoff_state",
        "intent",
        "confidence_bucket",
        "specialist",
    ],
)
def test_chat_telemetry_rejects_unallowlisted_values_under_known_fields(field_name):
    telemetry = ChatTelemetry()

    with pytest.raises(TelemetryPrivacyError):
        telemetry.emit("tool_call", status="failed", fields={field_name: "opaque_user_value"})


@pytest.mark.parametrize("field_value", [123, True])
def test_chat_telemetry_rejects_non_string_values_for_enum_fields(field_value):
    telemetry = ChatTelemetry()

    with pytest.raises(TelemetryPrivacyError):
        telemetry.emit("tool_call", status="failed", fields={"outcome": field_value})


def test_chat_telemetry_runtime_emission_is_fail_open():
    telemetry = ChatTelemetry()

    assert telemetry.emit_safely(
        "tool_call",
        status="failed",
        fields={"tool_name": "opaque_user_value"},
    ) is None


def test_chat_telemetry_runtime_emission_is_fail_open_when_logger_fails():
    class FailingLogger(logging.Logger):
        def log(self, level, msg, *args, **kwargs):
            raise RuntimeError("logger unavailable")

        def warning(self, msg, *args, **kwargs):
            raise RuntimeError("logger unavailable")

    telemetry = ChatTelemetry(FailingLogger("failing-chat-telemetry"))

    assert telemetry.emit_safely("tool_call", status="completed") is None


def test_chat_telemetry_replaces_malformed_trace_values_with_opaque_ids():
    telemetry = ChatTelemetry()

    event = telemetry.emit(
        "handoff_create",
        status="failed",
        trace_id="session_123",
        correlation_id="jwt-token",
        fields={"error_class": "dependency_unavailable"},
    )

    assert event["trace_id"] != "session_123"
    assert event["correlation_id"] != "jwt-token"
    assert event["trace_id"].startswith("chat_")
    assert event["correlation_id"].startswith("chat_")
    assert len(event["trace_id"]) == 37
    assert len(event["correlation_id"]) == 37


def test_chat_telemetry_covers_rollout_operation_allowlist():
    telemetry = ChatTelemetry()

    for operation in (
        "quota_admission",
        "router_decision",
        "tool_call",
        "snapshot_read",
        "handoff_create",
        "handoff_resolve",
        "handoff_consume",
        "handoff_replay",
    ):
        event = telemetry.emit(operation, status="ok")
        assert event["operation"] == operation


@pytest.mark.parametrize("snapshot_state", ["hit", "miss"])
def test_snapshot_telemetry_emits_normal_read_outcomes(snapshot_state):
    telemetry = ChatTelemetry()

    event = telemetry.emit(
        "snapshot_read",
        status=snapshot_state,
        fields={"outcome": snapshot_state},
    )

    assert event["outcome"] == snapshot_state


def test_safe_tool_name_uses_non_sensitive_allowlisted_labels():
    assert safe_tool_name("create_handoff_token") == "handoff_creator"
    assert safe_tool_name("search_flights") == "search_flights"
    assert safe_tool_name("arbitrary_user_supplied_name") == "other"
