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


logger = logging.getLogger("agent.chat_observability")

_OPAQUE_ID = re.compile(r"chat_[a-f0-9]{32}\Z")
_SAFE_VALUE = re.compile(r"[A-Za-z0-9_.:/-]{1,64}\Z")
_FORBIDDEN_VALUE = re.compile(
    r"(?:https?://|Bearer\s|@|passport|token|session|user[_-]?id|offer[_-]?id|"
    r"message|passenger|payment|card|secret|authorization)",
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

_SAFE_TOOL_NAMES = frozenset(
    {
        "check_booking_readiness",
        "search_flights",
        "signal_checkout_intent",
        "handoff_creator",
    }
)


class TelemetryPrivacyError(ValueError):
    """Raised when an event would exceed the chat telemetry contract."""


def _new_opaque_id() -> str:
    return f"chat_{secrets.token_hex(16)}"


def _safe_opaque_id(value: str | None) -> str:
    if value is not None and _OPAQUE_ID.fullmatch(value):
        return value
    return _new_opaque_id()


def _safe_string(field_name: str, value: Any) -> str:
    if not isinstance(value, str) or not _SAFE_VALUE.fullmatch(value):
        raise TelemetryPrivacyError(f"field {field_name!r} must be a bounded enum-like value")
    if _FORBIDDEN_VALUE.search(value):
        raise TelemetryPrivacyError(f"field {field_name!r} contains protected data")
    allowed_values = _ALLOWED_STRING_VALUES.get(field_name)
    if allowed_values is not None and value not in allowed_values:
        raise TelemetryPrivacyError(f"field {field_name!r} is not an allowlisted value")
    return value


def _safe_scalar(field_name: str, value: Any) -> str | int | float | bool | None:
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
            "trace_id": _safe_opaque_id(trace_id),
            "correlation_id": _safe_opaque_id(correlation_id),
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
            self._logger.warning("chat_telemetry_rejected")
            return None
