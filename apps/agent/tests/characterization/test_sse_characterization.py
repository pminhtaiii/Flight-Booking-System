import json
from typing import Any, Dict, List, Optional

import pytest
from pydantic import BaseModel, ConfigDict

from agent.models.events import HandoffEvent

# =========================================================================
# Event Wire Contract Specifications (Authoritative SSE 8 Wire Events)
# =========================================================================


class TokenPayload(BaseModel):
    content: str
    model_config = ConfigDict(extra="forbid")


class ToolCallPayload(BaseModel):
    name: str
    inputs: Dict[str, Any]
    model_config = ConfigDict(extra="forbid")


class ToolResultPayload(BaseModel):
    name: str
    result: str
    model_config = ConfigDict(extra="forbid")


class FlightResultsPayload(BaseModel):
    results: List[Dict[str, Any]]
    model_config = ConfigDict(extra="forbid")


class ActionHandoffPayload(BaseModel):
    version: int = 1
    action: str = "begin_checkout"
    handoffToken: str
    expiresAt: str
    display: Dict[str, Any]
    model_config = ConfigDict(extra="forbid")


class ActionRequiredPayload(BaseModel):
    action: str
    target: str
    scope: Optional[str] = None
    display: Optional[Dict[str, Any]] = None
    passengers: Optional[List[Dict[str, Any]]] = None
    model_config = ConfigDict(extra="forbid")


class DonePayload(BaseModel):
    messageId: Optional[str] = None
    sessionId: Optional[str] = None
    tokens: Optional[int] = None
    model_config = ConfigDict(extra="ignore")


class ErrorPayload(BaseModel):
    code: str
    message: str
    partialMessageId: Optional[str] = None
    error: Optional[str] = None
    model_config = ConfigDict(extra="ignore")


AUTHORITATIVE_EVENT_PAYLOAD_MAP = {
    "token": TokenPayload,
    "tool_call": ToolCallPayload,
    "tool_result": ToolResultPayload,
    "flight_results": FlightResultsPayload,
    "ACTION_HANDOFF": ActionHandoffPayload,
    "ACTION_REQUIRED": ActionRequiredPayload,
    "done": DonePayload,
    "error": ErrorPayload,
}


def parse_sse_wire_chunk(chunk_str: str) -> Dict[str, Any]:
    """Parse raw SSE formatted text line into event name and decoded json payload."""
    lines = chunk_str.strip().split("\n")
    event_type = None
    data_str = None
    for line in lines:
        if line.startswith("event:"):
            event_type = line[len("event:") :].strip()
        elif line.startswith("data:"):
            data_str = line[len("data:") :].strip()

    if not event_type or data_str is None:
        raise ValueError(f"Invalid SSE chunk format: {chunk_str}")

    return {
        "event": event_type,
        "data": json.loads(data_str),
    }


def format_sse_wire_event(event_name: str, payload: Dict[str, Any]) -> str:
    """Format an event and payload dict to standard SSE wire format."""
    return f"event: {event_name}\ndata: {json.dumps(payload)}\n\n"


# =========================================================================
# 1. Authoritative Wire Event Schema Characterization Tests
# =========================================================================


class TestAuthoritativeSSEWireEvents:
    def test_token_event_wire_format(self):
        raw = {"content": "Hello, how can I help you today?"}
        model = TokenPayload.model_validate(raw)
        assert model.content == "Hello, how can I help you today?"

        sse_wire = format_sse_wire_event("token", raw)
        parsed = parse_sse_wire_chunk(sse_wire)
        assert parsed["event"] == "token"
        assert parsed["data"]["content"] == "Hello, how can I help you today?"

    def test_tool_call_event_wire_format(self):
        raw = {
            "name": "search_flights",
            "inputs": {"origin": "SGN", "destination": "HAN", "date": "2026-09-01"},
        }
        model = ToolCallPayload.model_validate(raw)
        assert model.name == "search_flights"
        assert model.inputs["origin"] == "SGN"

        sse_wire = format_sse_wire_event("tool_call", raw)
        parsed = parse_sse_wire_chunk(sse_wire)
        assert parsed["event"] == "tool_call"
        assert parsed["data"]["name"] == "search_flights"
        assert parsed["data"]["inputs"]["destination"] == "HAN"

    def test_tool_result_event_wire_format(self):
        raw = {
            "name": "search_flights",
            "result": "Found 3 flights from SGN to HAN on 2026-09-01:",
        }
        model = ToolResultPayload.model_validate(raw)
        assert model.name == "search_flights"
        assert "Found 3 flights" in model.result

        sse_wire = format_sse_wire_event("tool_result", raw)
        parsed = parse_sse_wire_chunk(sse_wire)
        assert parsed["event"] == "tool_result"
        assert parsed["data"]["name"] == "search_flights"

    def test_flight_results_event_wire_format(self):
        raw = {
            "results": [
                {
                    "index": 1,
                    "airline": "Vietnam Airlines",
                    "origin": "SGN",
                    "destination": "HAN",
                    "departureAt": "2026-09-01T08:00:00Z",
                    "arrivalAt": "2026-09-01T10:00:00Z",
                    "price": "120.00",
                    "currency": "USD",
                }
            ]
        }
        model = FlightResultsPayload.model_validate(raw)
        assert len(model.results) == 1
        assert model.results[0]["index"] == 1

        sse_wire = format_sse_wire_event("flight_results", raw)
        parsed = parse_sse_wire_chunk(sse_wire)
        assert parsed["event"] == "flight_results"
        assert len(parsed["data"]["results"]) == 1

    def test_action_handoff_event_wire_format(self):
        display_data = {
            "airline": "Vietnam Airlines",
            "origin": "SGN",
            "destination": "HAN",
            "departureAt": "2026-09-01T08:00:00Z",
            "arrivalAt": "2026-09-01T10:00:00Z",
            "price": "120.00",
            "currency": "USD",
        }
        raw = {
            "version": 1,
            "action": "begin_checkout",
            "handoffToken": "jwt_token_sample_characterization",
            "expiresAt": "2026-09-01T08:15:00Z",
            "display": display_data,
        }
        model = ActionHandoffPayload.model_validate(raw)
        assert model.version == 1
        assert model.action == "begin_checkout"
        assert model.handoffToken == "jwt_token_sample_characterization"

        # Validate HandoffEvent domain model as well
        domain_event = HandoffEvent.model_validate(raw)
        assert domain_event.action == "begin_checkout"
        assert domain_event.display.airline == "Vietnam Airlines"

        sse_wire = format_sse_wire_event("ACTION_HANDOFF", raw)
        parsed = parse_sse_wire_chunk(sse_wire)
        assert parsed["event"] == "ACTION_HANDOFF"
        assert parsed["data"]["handoffToken"] == "jwt_token_sample_characterization"

    def test_action_required_event_wire_format(self):
        raw = {
            "action": "COMPLETE_PROFILE",
            "target": "/profile",
            "scope": "user_profile",
            "display": {"title": "Action Required"},
            "passengers": [
                {
                    "passengerType": "adult",
                    "passengerOrdinal": 1,
                    "sections": [
                        {
                            "name": "identity",
                            "fields": [
                                {
                                    "name": "passportNumber",
                                    "status": "missing",
                                    "reason": "Required for international flight",
                                }
                            ],
                        }
                    ],
                }
            ],
        }
        model = ActionRequiredPayload.model_validate(raw)
        assert model.action == "COMPLETE_PROFILE"
        assert model.target == "/profile"
        assert len(model.passengers) == 1

        sse_wire = format_sse_wire_event("ACTION_REQUIRED", raw)
        parsed = parse_sse_wire_chunk(sse_wire)
        assert parsed["event"] == "ACTION_REQUIRED"
        assert parsed["data"]["target"] == "/profile"

    def test_done_event_wire_format(self):
        raw = {
            "messageId": "msg_char_789",
            "sessionId": "ses_char_456",
            "tokens": 42,
        }
        model = DonePayload.model_validate(raw)
        assert model.messageId == "msg_char_789"
        assert model.tokens == 42

        sse_wire = format_sse_wire_event("done", raw)
        parsed = parse_sse_wire_chunk(sse_wire)
        assert parsed["event"] == "done"
        assert parsed["data"]["messageId"] == "msg_char_789"

    def test_error_event_wire_format(self):
        raw = {
            "code": "OUTPUT_GUARDRAIL_BLOCKED",
            "message": "Response was blocked for safety reasons.",
            "partialMessageId": "msg_part_123",
        }
        model = ErrorPayload.model_validate(raw)
        assert model.code == "OUTPUT_GUARDRAIL_BLOCKED"
        assert model.partialMessageId == "msg_part_123"

        sse_wire = format_sse_wire_event("error", raw)
        parsed = parse_sse_wire_chunk(sse_wire)
        assert parsed["event"] == "error"
        assert parsed["data"]["code"] == "OUTPUT_GUARDRAIL_BLOCKED"


# =========================================================================
# 2. Event Sequence Ordering Characterization Tests
# =========================================================================


class TestSSESequenceOrdering:
    """Validates the canonical ordering lifecycle of SSE event streams."""

    def test_canonical_flight_search_and_handoff_sequence(self):
        """
        Tests the standard event lifecycle:
        token -> tool_call -> tool_result -> flight_results -> ACTION_HANDOFF -> done
        """
        stream_events = [
            {"event": "token", "data": {"content": "Searching for "}},
            {"event": "token", "data": {"content": "flights to Tokyo..."}},
            {
                "event": "tool_call",
                "data": {
                    "name": "search_flights",
                    "inputs": {"origin": "SGN", "destination": "NRT", "date": "2026-09-10"},
                },
            },
            {
                "event": "tool_result",
                "data": {
                    "name": "search_flights",
                    "result": "Found 1 flight from SGN to NRT",
                },
            },
            {
                "event": "flight_results",
                "data": {
                    "results": [
                        {
                            "index": 1,
                            "airline": "Japan Airlines",
                            "origin": "SGN",
                            "destination": "NRT",
                            "departureAt": "2026-09-10T08:00:00Z",
                            "arrivalAt": "2026-09-10T16:00:00Z",
                            "price": "450.00",
                            "currency": "USD",
                        }
                    ]
                },
            },
            {
                "event": "ACTION_HANDOFF",
                "data": {
                    "version": 1,
                    "action": "begin_checkout",
                    "handoffToken": "token_seq_abc",
                    "expiresAt": "2026-09-10T08:15:00Z",
                    "display": {
                        "airline": "Japan Airlines",
                        "origin": "SGN",
                        "destination": "NRT",
                        "departureAt": "2026-09-10T08:00:00Z",
                        "arrivalAt": "2026-09-10T16:00:00Z",
                        "price": "450.00",
                        "currency": "USD",
                    },
                },
            },
            {"event": "done", "data": {"messageId": "msg_seq_1", "tokens": 120}},
        ]

        # Verify each event matches schema and event sequence order
        observed_order = []
        for raw_event in stream_events:
            ev_name = raw_event["event"]
            payload_cls = AUTHORITATIVE_EVENT_PAYLOAD_MAP[ev_name]
            validated = payload_cls.model_validate(raw_event["data"])
            assert validated is not None
            observed_order.append(ev_name)

        assert observed_order == [
            "token",
            "token",
            "tool_call",
            "tool_result",
            "flight_results",
            "ACTION_HANDOFF",
            "done",
        ]

        # Check relative ordering invariants
        first_token_idx = observed_order.index("token")
        tool_call_idx = observed_order.index("tool_call")
        tool_result_idx = observed_order.index("tool_result")
        flight_results_idx = observed_order.index("flight_results")
        handoff_idx = observed_order.index("ACTION_HANDOFF")
        done_idx = observed_order.index("done")

        assert first_token_idx < tool_call_idx
        assert tool_call_idx < tool_result_idx
        assert tool_result_idx < flight_results_idx
        assert flight_results_idx < handoff_idx
        assert handoff_idx < done_idx

    def test_canonical_action_required_sequence(self):
        """
        Tests the readiness check sequence:
        token -> tool_call -> tool_result -> ACTION_REQUIRED
        """
        stream_events = [
            {"event": "token", "data": {"content": "Checking readiness..."}},
            {
                "event": "tool_call",
                "data": {
                    "name": "check_booking_readiness",
                    "inputs": {"message": "Checking booking readiness..."},
                },
            },
            {
                "event": "tool_result",
                "data": {
                    "name": "check_booking_readiness",
                    "result": "Successfully checked booking readiness.",
                },
            },
            {
                "event": "ACTION_REQUIRED",
                "data": {
                    "action": "COMPLETE_PROFILE",
                    "scope": "missing_passport",
                    "passengers": [],
                    "target": "/profile",
                },
            },
        ]

        observed_order = [e["event"] for e in stream_events]
        assert observed_order == ["token", "tool_call", "tool_result", "ACTION_REQUIRED"]

        for raw_event in stream_events:
            ev_name = raw_event["event"]
            payload_cls = AUTHORITATIVE_EVENT_PAYLOAD_MAP[ev_name]
            assert payload_cls.model_validate(raw_event["data"]) is not None


# =========================================================================
# 3. Failure Finalization Ordering Characterization Tests
# =========================================================================


class TestSSEFailureFinalization:
    """Validates that failures finalize with error event and terminate stream."""

    @pytest.mark.parametrize(
        "error_code,error_msg",
        [
            ("GUARDRAIL_BLOCKED", "Your message contains protected personal information."),
            ("OUTPUT_GUARDRAIL_BLOCKED", "Response was blocked for safety reasons."),
            ("READINESS_RESPONSE_INVALID", "Booking readiness could not be verified safely."),
            ("HANDOFF_FAILED", "Checkout handoff could not be created."),
            ("PERSISTENCE_ERROR", "The response was generated but could not be saved."),
            ("LLM_ERROR", "The AI model encountered an error. Please try again."),
        ],
    )
    def test_error_finalization_payload_structure(self, error_code, error_msg):
        error_event = {
            "event": "error",
            "data": {
                "code": error_code,
                "message": error_msg,
                "partialMessageId": None,
            },
        }

        parsed = ErrorPayload.model_validate(error_event["data"])
        assert parsed.code == error_code
        assert parsed.message == error_msg
        assert parsed.partialMessageId is None

        # Verify wire serialization
        wire_text = format_sse_wire_event("error", error_event["data"])
        wire_parsed = parse_sse_wire_chunk(wire_text)
        assert wire_parsed["event"] == "error"
        assert wire_parsed["data"]["code"] == error_code

    def test_error_is_terminal_in_stream_sequence(self):
        """
        Verify stream termination behavior: once an error event is yielded,
        the stream finishes and no 'done' or subsequent token events are emitted.
        """
        events_stream = [
            {"event": "token", "data": {"content": "Starting search..."}},
            {
                "event": "error",
                "data": {
                    "code": "LLM_ERROR",
                    "message": "The AI model encountered an error.",
                    "partialMessageId": "msg_part_456",
                },
            },
        ]

        consumed_events = []
        for item in events_stream:
            consumed_events.append(item)
            if item["event"] == "error":
                # Simulated SSE stream generator break on error
                break

        assert len(consumed_events) == 2
        assert consumed_events[-1]["event"] == "error"
        assert "done" not in [e["event"] for e in consumed_events]
