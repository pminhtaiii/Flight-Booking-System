"""Allowlisted, value-free telemetry for the chat rollout.

This module deliberately accepts a small set of scalar operational fields. It
does not serialize arbitrary mappings, request bodies, exception text, or
identifiers, so callers cannot accidentally turn logs into a data exfiltration
path.
"""

from __future__ import annotations

import json
import logging
import math
import re
import secrets
from collections.abc import Mapping
from typing import Any

from agent.sanitization.pii_scrubber import detect_pii


logger = logging.getLogger("agent.chat_observability")

_OPAQUE_ID = re.compile(r"chat_[a-f0-9]{32}\Z")
_SAFE_VALUE = re.compile(r"[A-Za-z0-9_.:/-]{1,64}\Z")
FORBIDDEN_TELEMETRY_FIELD_NAMES = frozenset(
    {
        "authorization",
        "booking_db_id",
        "contact_data",
        "duffel_offer_id",
        "handoff_token",
        "handoff_token_hash",
        "local_offer_id",
        "message_content",
        "passenger_data",
        "passport_data",
        "payment_data",
        "pnr",
        "raw_tool_payload",
        "secret",
        "session_id",
        "summary_content",
        "url",
        "user_id",
    }
)
FORBIDDEN_TELEMETRY_VALUE_MARKERS = frozenset(
    {
        "authorization",
        "booking_db_id",
        "contact",
        "duffel_offer_id",
        "handoff_token",
        "handoff_token_hash",
        "local_offer_id",
        "message",
        "passport",
        "passenger",
        "payment",
        "pnr",
        "raw_tool_payload",
        "secret",
        "summary",
        "token",
    }
)
_FORBIDDEN_VALUE = re.compile(
    r"(?:https?://|bearer\s|@|"
    + "|".join(re.escape(marker) for marker in FORBIDDEN_TELEMETRY_VALUE_MARKERS)
    + r")",
    re.IGNORECASE,
)

ALLOWED_OPERATIONS = frozenset(
    {
        "quota_admission",
        "router_decision",
        "tool_call",
        "snapshot_read",
        "handoff_create",
        "handoff_resolve",
        "handoff_consume",
        "handoff_replay",
    }
)

ALLOWED_FIELDS = frozenset(
    {
        "outcome",
        "dependency",
        "error_class",
        "tool_name",
        "route",
        "snapshot_state",
        "handoff_state",
        "result_count",
        "snapshot_version",
        "intent",
        "confidence_bucket",
        "specialist",
    }
)

_ALLOWED_STRING_VALUES: dict[str, frozenset[str]] = {
    "status": frozenset(
        {
            "accepted", "rejected", "failed", "hit", "miss", "unavailable",
            "created", "completed", "resolved", "replayed", "fallback", "classified", "ok",
        }
    ),
    "outcome": frozenset(
        {
            "admitted", "rejected", "unavailable", "empty_state", "non_human_message",
            "malformed_output", "low_confidence", "completed", "created", "handoff_rejected",
            "resolved", "consumed", "already_consumed", "idempotent_retry", "classified",
            "hit", "miss",
        }
    ),
    "dependency": frozenset({"redis", "nestjs", "llm", "control_plane"}),
    "error_class": frozenset(
        {
            "daily_quota", "burst_limit", "control_plane_unavailable", "handoff_rejected",
            "dependency_unavailable", "timeout", "unknown",
        }
    ),
    "tool_name": frozenset(
        {"check_booking_readiness", "search_flights", "signal_checkout_intent", "handoff_creator", "other"}
    ),
    "route": frozenset({"search", "checkout", "general", "booking_inquiry"}),
    "snapshot_state": frozenset({"hit", "miss", "unavailable"}),
    "handoff_state": frozenset({"created", "resolved", "consumed", "replayed", "rejected"}),
    "intent": frozenset({"SEARCH", "CHECKOUT", "GENERAL", "BOOKING_INQUIRY"}),
    "confidence_bucket": frozenset({"low", "medium", "high"}),
    "specialist": frozenset({"travel_assistant", "checkout", "search", "general"}),
}

_ALLOWED_INTEGER_FIELDS = frozenset({"result_count", "snapshot_version"})

# These are deliberately narrower than the validation allowlists.  The
# allowlists describe safe vocabulary that future call sites may use; this set
# describes the telemetry emitted by the agent today.
EMITTED_AGENT_OPERATIONS = frozenset(
    {
        "handoff_create",
        "quota_admission",
        "router_decision",
        "snapshot_read",
        "tool_call",
    }
)
EMITTED_AGENT_FIELDS = frozenset(
    {
        "confidence_bucket",
        "dependency",
        "error_class",
        "intent",
        "outcome",
        "tool_name",
    }
)

_SAFE_TOOL_NAMES = frozenset(
    {
        "check_booking_readiness",
        "search_flights",
        "signal_checkout_intent",
        "handoff_creator",
    }
)

STANDARDIZED_METRIC_COUNTERS: dict[str, str] = {
    "chat_messages_accepted_total": "chat_messages_accepted_total",
    "chat_messages_denied_total": "chat_messages_denied_total",
    "quota_daily_utilization": "quota_daily_utilization",
    "handoff_tokens_issued_total": "handoff_tokens_issued_total",
    "handoff_tokens_resolved_total": "handoff_tokens_resolved_total",
    "handoff_tokens_consumed_total": "handoff_tokens_consumed_total",
    "handoff_claims_conflicted_total": "handoff_claims_conflicted_total",
}

STANDARDIZED_METRICS: tuple[str, ...] = (
    "chat_messages_accepted_total",
    "chat_messages_denied_total",
    "quota_daily_utilization",
    "handoff_tokens_issued_total",
    "handoff_tokens_resolved_total",
    "handoff_tokens_consumed_total",
    "handoff_claims_conflicted_total",
)


def dashboard_alert_contract() -> dict[str, object]:
    """Return the maintained dashboard/alert contract for agent telemetry.

    This distinguishes signals the agent currently emits from dashboard panels
    that remain required by the feature specification but cannot yet be backed
    by an emitted agent signal.
    """
    return {
        "emitted_operations": tuple(sorted(EMITTED_AGENT_OPERATIONS)),
        "emitted_fields": tuple(sorted(EMITTED_AGENT_FIELDS)),
        "allowed_but_not_yet_emitted_capabilities": {
            "operations": tuple(sorted(ALLOWED_OPERATIONS - EMITTED_AGENT_OPERATIONS)),
            "fields": tuple(sorted(ALLOWED_FIELDS - EMITTED_AGENT_FIELDS)),
        },
        "required_but_not_yet_emitted_panels": (
            "active_streams",
            "daily_quota_utilization_buckets",
            "disambiguations",
            "handoff_expired",
            "handoff_foreign",
            "handoff_stale",
            "redis_latency",
            "snapshot_expire",
            "snapshot_replace",
            "stream_time_to_first_safe_token",
        ),
        "standardized_metric_counters": tuple(sorted(STANDARDIZED_METRICS)),
        "alert_thresholds": {
            "error_rate": {"baseline_multiplier": 2, "window_minutes": 5},
            "handoff_consume_p95_ms": 300,
            "handoff_resolve_p95_ms": 300,
        },
        "performance_gates": {"router_overhead_p95_ms_under": 100},
        "forbidden_field_names": tuple(sorted(FORBIDDEN_TELEMETRY_FIELD_NAMES)),
        "forbidden_value_markers": tuple(sorted(FORBIDDEN_TELEMETRY_VALUE_MARKERS)),
    }


class TelemetryPrivacyError(ValueError):
    """Raised when an event would exceed the chat telemetry contract."""


def _new_opaque_id() -> str:
    return f"chat_{secrets.token_hex(16)}"


def safe_opaque_id(value: str | None) -> str:
    if value is not None and _OPAQUE_ID.fullmatch(value):
        return value
    return _new_opaque_id()


def _safe_string(field_name: str, value: Any) -> str:
    if not isinstance(value, str):
        raise TelemetryPrivacyError(f"field {field_name!r} must be a bounded enum-like value")
    allowed_values = _ALLOWED_STRING_VALUES.get(field_name)
    if allowed_values is not None and value in allowed_values:
        return value
    if _FORBIDDEN_VALUE.search(value) or detect_pii(value):
        raise TelemetryPrivacyError(f"field {field_name!r} contains protected data")
    if not _SAFE_VALUE.fullmatch(value):
        raise TelemetryPrivacyError(f"field {field_name!r} must be a bounded enum-like value")
    raise TelemetryPrivacyError(f"field {field_name!r} is not an allowlisted value")



def _safe_scalar(field_name: str, value: Any) -> str | int | float | bool | None:
    if field_name in _ALLOWED_STRING_VALUES:
        return _safe_string(field_name, value)
    if field_name in _ALLOWED_INTEGER_FIELDS:
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 1_000_000:
            raise TelemetryPrivacyError(f"field {field_name!r} must be a bounded non-negative integer")
        return value
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return _safe_string(field_name, value)
    if isinstance(value, int):
        if abs(value) > 1_000_000:
            raise TelemetryPrivacyError(f"field {field_name!r} is out of bounds")
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or abs(value) > 1_000_000:
            raise TelemetryPrivacyError(f"field {field_name!r} is out of bounds")
        return value
    raise TelemetryPrivacyError(f"field {field_name!r} must be scalar")


def safe_tool_name(value: str | None) -> str:
    """Map runtime tool names to a bounded, non-sensitive telemetry label."""
    if value == "create_handoff_token":
        return "handoff_creator"
    if value in _SAFE_TOOL_NAMES:
        return value
    return "other"


class ChatTelemetry:
    """Emit bounded structured chat events through the standard logger."""

    def __init__(self, event_logger: logging.Logger | None = None) -> None:
        self._logger = event_logger or logger

    def emit(
        self,
        operation: str,
        *,
        status: str,
        latency_ms: int | float = 0,
        trace_id: str | None = None,
        correlation_id: str | None = None,
        fields: Mapping[str, Any] | None = None,
        level: int = logging.INFO,
    ) -> dict[str, Any]:
        if operation not in ALLOWED_OPERATIONS:
            raise TelemetryPrivacyError("operation is not allowlisted")
        if not isinstance(fields, Mapping):
            if fields is not None:
                raise TelemetryPrivacyError("fields must be an allowlisted mapping")
            fields = {}

        unknown_fields = set(fields).difference(ALLOWED_FIELDS)
        if unknown_fields:
            raise TelemetryPrivacyError("fields contain non-allowlisted keys")

        safe_latency = _safe_scalar("latency_ms", latency_ms)
        if not isinstance(safe_latency, (int, float)) or isinstance(safe_latency, bool):
            raise TelemetryPrivacyError("latency_ms must be numeric")

        event: dict[str, Any] = {
            "operation": operation,
            "status": _safe_string("status", status),
            "latency_ms": max(0, min(600_000, int(round(safe_latency)))),
            "trace_id": safe_opaque_id(trace_id),
            "correlation_id": safe_opaque_id(correlation_id),
        }
        for field_name, value in fields.items():
            event[field_name] = _safe_scalar(field_name, value)

        self._logger.log(
            level,
            "chat_telemetry %s",
            json.dumps(event, sort_keys=True, separators=(",", ":")),
        )
        return event

    def emit_safely(
        self,
        operation: str,
        *,
        status: str,
        latency_ms: int | float = 0,
        trace_id: str | None = None,
        correlation_id: str | None = None,
        fields: Mapping[str, Any] | None = None,
        level: int = logging.INFO,
    ) -> dict[str, Any] | None:
        """Emit runtime telemetry without changing chat behavior on rejection."""
        try:
            return self.emit(
                operation,
                status=status,
                latency_ms=latency_ms,
                trace_id=trace_id,
                correlation_id=correlation_id,
                fields=fields,
                level=level,
            )
        except TelemetryPrivacyError:
            try:
                self._logger.warning("chat_telemetry_rejected")
            except Exception:  # noqa: BLE001
                return None
            return None
        except Exception:  # noqa: BLE001
            return None
