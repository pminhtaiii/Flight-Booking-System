"""Characterization tests for ToolResultResolver (T006).

Tests domain projections for tool outputs and handoff node resolution
extracted from ChatTurnRunner into ToolResultResolver.
"""

import json
from dataclasses import dataclass
from typing import Optional

import pytest

from agent.chat_turn.events import (
    ActionHandoffEvent,
    ActionRequiredEvent,
    FlightResultsEvent,
)
from agent.chat_turn.resolver import (
    HandoffResolution,
    ToolResolution,
    ToolResultResolver,
)


@dataclass
class FakeProjectedFlight:
    """Mock projected flight item matching browser payload interface."""

    data: dict[str, object]

    def model_dump(self, *, mode: str = "python") -> dict[str, object]:
        return dict(self.data)


class FakeSnapshotLifecycle:
    """Mock search snapshot lifecycle for resolver tests."""

    def __init__(self, flights: Optional[list[dict[str, object]]] = None) -> None:
        self._flights = flights or []

    async def load_active(self, owner: object) -> Optional[object]:
        if self._flights:
            return object()
        return None

    def project_for_browser(self, snapshot: object) -> list[FakeProjectedFlight]:
        return [FakeProjectedFlight(data=f) for f in self._flights]


@dataclass
class FakeTurnContext:
    """Mock turn execution context providing duck-typed identity and lifecycle."""

    user_id: str = "test-user-001"
    session_id: str = "test-session-001"
    chat_session_id: str = "test-session-001"
    snapshot_lifecycle: Optional[object] = None
    snapshot_repository: Optional[object] = None
    redis_client: Optional[object] = None


@pytest.fixture
def resolver() -> ToolResultResolver:
    return ToolResultResolver()


@pytest.fixture
def default_context() -> FakeTurnContext:
    return FakeTurnContext()


# ============================================================================
# 1. Generic / Non-Significant Tools
# ============================================================================


async def test_resolve_generic_tool_string_result(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    res: ToolResolution = await resolver.resolve("random_tool", "some text result", default_context)
    assert res.is_blocked is False
    assert res.summary_override == "some text result"
    assert res.follow_up_event is None
    assert res.error_code is None
    assert res.error_message is None


async def test_resolve_generic_tool_dict_result(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    res: ToolResolution = await resolver.resolve("dict_tool", {"status": "ok"}, default_context)
    assert res.is_blocked is False
    assert res.summary_override == json.dumps({"status": "ok"}, ensure_ascii=False)
    assert res.follow_up_event is None
    assert res.error_code is None
    assert res.error_message is None


async def test_resolve_generic_tool_other_type_result(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    res: ToolResolution = await resolver.resolve("other_tool", 12345, default_context)
    assert res.is_blocked is False
    assert res.summary_override in ("Tool completed safely.", "12345")
    assert res.follow_up_event is None
    assert res.error_code is None
    assert res.error_message is None


# ============================================================================
# 2. search_flights Tool
# ============================================================================


async def test_resolve_search_flights_with_active_snapshot(
    resolver: ToolResultResolver,
) -> None:
    flight_data: dict[str, object] = {
        "airline": "Skyways",
        "flightNumber": "SW101",
        "price": "299.00",
    }
    lifecycle = FakeSnapshotLifecycle(flights=[flight_data])
    context = FakeTurnContext(snapshot_lifecycle=lifecycle)

    res: ToolResolution = await resolver.resolve("search_flights", "results found", context)
    assert res.is_blocked is False
    assert res.summary_override == "results found"
    assert isinstance(res.follow_up_event, FlightResultsEvent)
    assert res.follow_up_event.data.results == [flight_data]
    assert res.error_code is None
    assert res.error_message is None


async def test_resolve_search_flights_with_no_snapshot(
    resolver: ToolResultResolver,
) -> None:
    lifecycle = FakeSnapshotLifecycle(flights=[])
    context = FakeTurnContext(snapshot_lifecycle=lifecycle)

    res: ToolResolution = await resolver.resolve("search_flights", "no results", context)
    assert res.is_blocked is False
    assert res.summary_override == "no results"
    assert res.follow_up_event is None
    assert res.error_code is None
    assert res.error_message is None


async def test_resolve_search_flights_with_no_lifecycle(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    res: ToolResolution = await resolver.resolve("search_flights", "results found", default_context)
    assert res.is_blocked is False
    assert res.summary_override == "results found"
    assert res.follow_up_event is None
    assert res.error_code is None
    assert res.error_message is None


# ============================================================================
# 3. check_booking_readiness Tool
# ============================================================================


async def test_resolve_check_booking_readiness_valid_ready_true(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    payload: dict[str, object] = {
        "ready": True,
        "nextAction": "CONTINUE_CHECKOUT",
        "scope": "DOMESTIC",
        "passengers": [],
    }
    res: ToolResolution = await resolver.resolve(
        "check_booking_readiness", payload, default_context
    )
    assert res.is_blocked is False
    assert res.summary_override == "Successfully checked booking readiness."
    assert res.follow_up_event is None
    assert res.error_code is None
    assert res.error_message is None


async def test_resolve_check_booking_readiness_valid_ready_true_json_string(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    payload: dict[str, object] = {
        "ready": True,
        "nextAction": "CONTINUE_CHECKOUT",
        "scope": "DOMESTIC",
        "passengers": [],
    }
    res: ToolResolution = await resolver.resolve(
        "check_booking_readiness",
        json.dumps(payload, ensure_ascii=False),
        default_context,
    )
    assert res.is_blocked is False
    assert res.summary_override == "Successfully checked booking readiness."
    assert res.follow_up_event is None


async def test_resolve_check_booking_readiness_valid_ready_false_complete_profile(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    payload: dict[str, object] = {
        "scope": "DOMESTIC",
        "ready": False,
        "nextAction": "COMPLETE_PROFILE",
        "passengers": [
            {
                "passengerType": "ADULT",
                "passengerOrdinal": 1,
                "sections": [
                    {
                        "name": "identity",
                        "fields": [
                            {
                                "name": "passportNumber",
                                "status": "missing",
                                "reason": "REQUIRED",
                            }
                        ],
                    }
                ],
            }
        ],
    }
    res: ToolResolution = await resolver.resolve(
        "check_booking_readiness", payload, default_context
    )
    assert res.is_blocked is False
    assert res.summary_override == "Successfully checked booking readiness."
    assert isinstance(res.follow_up_event, ActionRequiredEvent)
    assert res.follow_up_event.data.action == "COMPLETE_PROFILE"
    assert res.follow_up_event.data.target == "/profile"
    assert res.follow_up_event.data.passengers is not None
    assert len(res.follow_up_event.data.passengers) == 1

    passenger: dict[str, object] = res.follow_up_event.data.passengers[0]
    assert passenger["passengerType"] == "ADULT"
    assert passenger["passengerOrdinal"] == 1
    assert "sections" in passenger

    sections = passenger["sections"]
    assert isinstance(sections, list)
    assert len(sections) == 1
    first_section = sections[0]
    assert isinstance(first_section, dict)
    assert first_section["name"] == "identity"
    fields = first_section["fields"]
    assert isinstance(fields, list)
    assert len(fields) == 1
    first_field = fields[0]
    assert isinstance(first_field, dict)
    assert first_field["name"] == "passportNumber"
    assert first_field["status"] == "missing"
    assert first_field["reason"] == "REQUIRED"


async def test_resolve_check_booking_readiness_valid_ready_false_other_action(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    payload: dict[str, object] = {
        "scope": "INTERNATIONAL",
        "ready": False,
        "nextAction": "CONTINUE_CHECKOUT",
        "passengers": [],
    }
    res: ToolResolution = await resolver.resolve(
        "check_booking_readiness", payload, default_context
    )
    assert res.is_blocked is False
    assert res.summary_override == "Successfully checked booking readiness."
    assert isinstance(res.follow_up_event, ActionRequiredEvent)
    assert res.follow_up_event.data.action == "CONTINUE_CHECKOUT"
    assert res.follow_up_event.data.target == "/checkout/passengers"


async def test_resolve_check_booking_readiness_upstream_error(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    payload: dict[str, object] = {"error": "API Down"}
    res: ToolResolution = await resolver.resolve(
        "check_booking_readiness", payload, default_context
    )
    assert res.is_blocked is True
    assert res.error_code == "READINESS_RESPONSE_INVALID"
    assert res.error_message == "Booking readiness could not be verified safely."
    assert res.follow_up_event is None


async def test_resolve_check_booking_readiness_invalid_schema(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    payload: dict[str, object] = {"unexpected": "schema_data"}
    res: ToolResolution = await resolver.resolve(
        "check_booking_readiness", payload, default_context
    )
    assert res.is_blocked is True
    assert res.error_code == "READINESS_RESPONSE_INVALID"
    assert res.error_message == "Booking readiness could not be verified safely."
    assert res.follow_up_event is None


async def test_resolve_check_booking_readiness_unknown_scope(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    payload: dict[str, object] = {
        "scope": "UNKNOWN_CUSTOM_SCOPE",
        "ready": True,
        "nextAction": "CONTINUE_CHECKOUT",
        "passengers": [],
    }
    res: ToolResolution = await resolver.resolve(
        "check_booking_readiness", payload, default_context
    )
    assert res.is_blocked is True
    assert res.error_code == "READINESS_RESPONSE_INVALID"
    assert res.error_message == "Booking readiness could not be verified safely."
    assert res.follow_up_event is None


async def test_resolve_check_booking_readiness_invalid_string(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    res: ToolResolution = await resolver.resolve(
        "check_booking_readiness", "invalid-not-json", default_context
    )
    assert res.is_blocked is True
    assert res.error_code == "READINESS_RESPONSE_INVALID"
    assert res.error_message == "Booking readiness could not be verified safely."
    assert res.follow_up_event is None


# ============================================================================
# 4. Handoff Node Completions
# ============================================================================


def test_resolve_handoff_node_valid_token(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    output: dict[str, object] = {
        "action": {
            "handoffToken": "tok_123",
            "action": "begin_checkout",
            "expiresAt": "2026-10-01T00:00:00Z",
            "display": {"title": "Checkout"},
        }
    }
    res: HandoffResolution = resolver.resolve_handoff_node(
        "create_handoff_token", output, default_context
    )
    assert res.is_blocked is False
    assert isinstance(res.handoff_event, ActionHandoffEvent)
    assert res.handoff_event.data.handoffToken == "tok_123"
    assert res.handoff_event.data.action == "begin_checkout"
    assert res.handoff_event.data.expiresAt == "2026-10-01T00:00:00Z"
    assert res.handoff_event.data.display == {"title": "Checkout"}
    assert res.force_persistence is True
    assert res.error_code is None
    assert res.error_message is None


@pytest.mark.parametrize(
    "node_name",
    ["create_handoff_token_node", "validate_handoff"],
)
def test_resolve_handoff_node_node_aliases(
    resolver: ToolResultResolver, default_context: FakeTurnContext, node_name: str
) -> None:
    output: dict[str, object] = {
        "action": {
            "handoffToken": f"tok_{node_name}",
            "action": "begin_checkout",
            "expiresAt": "2026-10-01T00:00:00Z",
            "display": {"title": "Checkout"},
        }
    }
    res: HandoffResolution = resolver.resolve_handoff_node(node_name, output, default_context)
    assert res.is_blocked is False
    assert isinstance(res.handoff_event, ActionHandoffEvent)
    assert res.handoff_event.data.handoffToken == f"tok_{node_name}"
    assert res.force_persistence is True


def test_resolve_handoff_node_token_alias(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    output: dict[str, object] = {
        "action": {
            "token": "tok_alias_456",
            "action": "begin_checkout",
            "expiresAt": "2026-10-01T00:00:00Z",
            "display": {"title": "Checkout"},
        }
    }
    res: HandoffResolution = resolver.resolve_handoff_node(
        "create_handoff_token", output, default_context
    )
    assert res.is_blocked is False
    assert isinstance(res.handoff_event, ActionHandoffEvent)
    assert res.handoff_event.data.handoffToken == "tok_alias_456"
    assert res.force_persistence is True


def test_resolve_handoff_node_action_error(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    output: dict[str, object] = {"action": {"error": "Quota exceeded"}}
    res: HandoffResolution = resolver.resolve_handoff_node(
        "create_handoff_token", output, default_context
    )
    assert res.is_blocked is True
    assert res.error_code == "HANDOFF_FAILED"
    assert res.error_message == "Checkout handoff could not be created."
    assert res.error_detail == "Quota exceeded"
    assert res.handoff_event is None
    assert res.force_persistence is False


def test_resolve_handoff_node_action_error_empty_string(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    output: dict[str, object] = {"action": {"error": ""}}
    res: HandoffResolution = resolver.resolve_handoff_node(
        "create_handoff_token", output, default_context
    )
    assert res.is_blocked is True
    assert res.error_code == "HANDOFF_FAILED"
    assert res.error_message == "Checkout handoff could not be created."
    assert res.error_detail == "Checkout handoff could not be created."
    assert res.handoff_event is None
    assert res.force_persistence is False


def test_resolve_handoff_node_unrecognized_node(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    output: dict[str, object] = {
        "action": {
            "handoffToken": "tok_123",
            "action": "begin_checkout",
        }
    }
    res: HandoffResolution = resolver.resolve_handoff_node("other_node", output, default_context)
    assert res.is_blocked is False
    assert res.handoff_event is None
    assert res.force_persistence is False


def test_resolve_handoff_node_missing_action(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    output: dict[str, object] = {"not_action": {"foo": "bar"}}
    res: HandoffResolution = resolver.resolve_handoff_node(
        "create_handoff_token", output, default_context
    )
    assert res.is_blocked is False
    assert res.handoff_event is None
    assert res.force_persistence is False


def test_resolve_handoff_node_non_dict_output(
    resolver: ToolResultResolver, default_context: FakeTurnContext
) -> None:
    res: HandoffResolution = resolver.resolve_handoff_node(
        "create_handoff_token", "not-a-dict", default_context
    )
    assert res.is_blocked is False
    assert res.handoff_event is None
    assert res.force_persistence is False
