import json

import pytest
from pydantic import TypeAdapter, ValidationError

from agent.chat_turn import (
    ActionHandoffEvent,
    ActionHandoffPayload,
    ActionRequiredEvent,
    ActionRequiredPayload,
    ChatTurnEvent,
    DoneEvent,
    DonePayload,
    ErrorEvent,
    ErrorPayload,
    FlightResultsEvent,
    FlightResultsPayload,
    TokenEvent,
    TokenPayload,
    ToolCallEvent,
    ToolCallPayload,
    ToolResultEvent,
    ToolResultPayload,
    format_sse,
)


def test_all_eight_wire_event_payloads_valid() -> None:
    p_token = TokenPayload(content="Hello world")
    p_tool_call = ToolCallPayload(
        name="search_flights",
        inputs={"origin": "SFO", "destination": "JFK"},
    )
    p_tool_result = ToolResultPayload(
        name="search_flights",
        result="Found 3 flights",
    )
    p_flight_results = FlightResultsPayload(
        results=[{"flightNumber": "AA100", "price": 350}],
    )
    p_action_handoff = ActionHandoffPayload(
        version=1,
        action="begin_checkout",
        handoffToken="chk_tok_123",
        expiresAt="2026-08-30T12:00:00Z",
        display={"airline": "Delta", "price": "450"},
    )
    p_action_required = ActionRequiredPayload(
        action="COMPLETE_PROFILE",
        target="/profile",
        scope="PASSENGER_DETAILS",
        passengers=[{"passengerType": "adult"}],
    )
    p_done = DonePayload(messageId="msg_123", sessionId="ses_456")
    p_error = ErrorPayload(
        code="PERSISTENCE_ERROR",
        message="Failed to save",
        partialMessageId="msg_partial",
        error="details",
    )

    payloads = [
        p_token,
        p_tool_call,
        p_tool_result,
        p_flight_results,
        p_action_handoff,
        p_action_required,
        p_done,
        p_error,
    ]

    for p in payloads:
        dumped = p.model_dump()
        assert isinstance(dumped, dict)
        json_str = p.model_dump_json()
        assert isinstance(json_str, str)
        assert json.loads(json_str) == dumped


def test_extra_fields_forbidden_on_all_payloads() -> None:
    payload_test_cases = [
        (TokenPayload, {"content": "Hello", "unexpected_field": "bad"}),
        (TokenPayload, {"content": "Hello", "offerId": "duffel_123"}),
        (ToolCallPayload, {"name": "search", "inputs": {}, "unexpected_field": "bad"}),
        (ToolCallPayload, {"name": "search", "inputs": {}, "offerId": "duffel_123"}),
        (ToolResultPayload, {"name": "search", "result": "ok", "unexpected_field": "bad"}),
        (ToolResultPayload, {"name": "search", "result": "ok", "offerId": "duffel_123"}),
        (FlightResultsPayload, {"results": [], "unexpected_field": "bad"}),
        (FlightResultsPayload, {"results": [], "offerId": "duffel_123"}),
        (
            ActionHandoffPayload,
            {
                "handoffToken": "tok",
                "expiresAt": "2026-08-30T12:00:00Z",
                "display": {},
                "unexpected_field": "bad",
            },
        ),
        (
            ActionHandoffPayload,
            {
                "handoffToken": "tok",
                "expiresAt": "2026-08-30T12:00:00Z",
                "display": {},
                "offerId": "duffel_123",
            },
        ),
        (ActionRequiredPayload, {"action": "ACT", "target": "/t", "unexpected_field": "bad"}),
        (ActionRequiredPayload, {"action": "ACT", "target": "/t", "offerId": "duffel_123"}),
        (DonePayload, {"messageId": "msg", "unexpected_field": "bad"}),
        (DonePayload, {"messageId": "msg", "offerId": "duffel_123"}),
        (ErrorPayload, {"code": "ERR", "message": "msg", "unexpected_field": "bad"}),
        (ErrorPayload, {"code": "ERR", "message": "msg", "offerId": "duffel_123"}),
    ]

    for model_cls, invalid_data in payload_test_cases:
        with pytest.raises(ValidationError):
            model_cls(**invalid_data)


def test_extra_fields_forbidden_on_all_event_wrappers() -> None:
    event_test_cases = [
        (TokenEvent, {"data": TokenPayload(content="hi"), "extra_prop": True}),
        (ToolCallEvent, {"data": ToolCallPayload(name="fn", inputs={}), "extra_prop": True}),
        (ToolResultEvent, {"data": ToolResultPayload(name="fn", result="ok"), "extra_prop": True}),
        (FlightResultsEvent, {"data": FlightResultsPayload(results=[]), "extra_prop": True}),
        (
            ActionHandoffEvent,
            {
                "data": ActionHandoffPayload(
                    handoffToken="t",
                    expiresAt="2026-08-30T12:00:00Z",
                    display={},
                ),
                "extra_prop": True,
            },
        ),
        (
            ActionRequiredEvent,
            {"data": ActionRequiredPayload(action="a", target="t"), "extra_prop": True},
        ),
        (DoneEvent, {"data": DonePayload(), "extra_prop": True}),
        (ErrorEvent, {"data": ErrorPayload(code="c", message="m"), "extra_prop": True}),
    ]

    for event_cls, invalid_data in event_test_cases:
        with pytest.raises(ValidationError):
            event_cls(**invalid_data)


def test_handoff_token_only_permitted_in_action_handoff() -> None:
    valid_handoff = ActionHandoffPayload(
        version=1,
        action="begin_checkout",
        handoffToken="chk_tok_123",
        expiresAt="2026-08-30T12:00:00Z",
        display={"airline": "Delta", "price": "450"},
    )
    assert valid_handoff.handoffToken == "chk_tok_123"

    forbidden_payloads = [
        (TokenPayload, {"content": "hi", "handoffToken": "chk_tok_123"}),
        (
            ToolCallPayload,
            {"name": "search", "inputs": {}, "handoffToken": "chk_tok_123"},
        ),
        (
            ToolResultPayload,
            {"name": "search", "result": "ok", "handoffToken": "chk_tok_123"},
        ),
        (FlightResultsPayload, {"results": [], "handoffToken": "chk_tok_123"}),
        (
            ActionRequiredPayload,
            {"action": "ACT", "target": "/profile", "handoffToken": "chk_tok_123"},
        ),
        (
            DonePayload,
            {"messageId": "msg", "sessionId": "ses", "handoffToken": "chk_tok_123"},
        ),
        (
            ErrorPayload,
            {"code": "ERR", "message": "msg", "handoffToken": "chk_tok_123"},
        ),
    ]

    for model_cls, invalid_data in forbidden_payloads:
        with pytest.raises(ValidationError):
            model_cls(**invalid_data)


def test_format_sse_produces_exact_wire_format() -> None:
    events = [
        TokenEvent(data=TokenPayload(content="chunk")),
        ToolCallEvent(
            data=ToolCallPayload(
                name="search_flights",
                inputs={"origin": "SFO", "destination": "JFK"},
            )
        ),
        ToolResultEvent(data=ToolResultPayload(name="search_flights", result="Found 3 flights")),
        FlightResultsEvent(
            data=FlightResultsPayload(results=[{"flightNumber": "AA100", "price": 350}])
        ),
        ActionHandoffEvent(
            data=ActionHandoffPayload(
                version=1,
                action="begin_checkout",
                handoffToken="chk_tok_123",
                expiresAt="2026-08-30T12:00:00Z",
                display={"airline": "Delta", "price": "450"},
            )
        ),
        ActionRequiredEvent(
            data=ActionRequiredPayload(
                action="COMPLETE_PROFILE",
                target="/profile",
                scope="PASSENGER_DETAILS",
                passengers=[{"passengerType": "adult"}],
            )
        ),
        DoneEvent(data=DonePayload(messageId="msg_123", sessionId="ses_456")),
        ErrorEvent(
            data=ErrorPayload(
                code="PERSISTENCE_ERROR",
                message="Failed to save",
                partialMessageId="msg_partial",
                error="details",
            )
        ),
    ]

    for event in events:
        sse_str = format_sse(event)
        expected_event_line = f"event: {event.event}\n"
        expected_data_line = f"data: {event.data.model_dump_json()}\n\n"
        assert sse_str.startswith(expected_event_line)
        assert expected_data_line in sse_str
        assert sse_str == f"{expected_event_line}{expected_data_line}"

        lines = sse_str.strip().split("\n")
        assert len(lines) == 2
        assert lines[0] == f"event: {event.event}"
        data_json = lines[1].removeprefix("data: ")
        parsed_data = json.loads(data_json)
        assert parsed_data == event.data.model_dump()


def test_discriminated_union_parsing() -> None:
    adapter = TypeAdapter(ChatTurnEvent)

    token_evt = adapter.validate_python({"event": "token", "data": {"content": "abc"}})
    assert isinstance(token_evt, TokenEvent)
    assert token_evt.data.content == "abc"

    handoff_evt = adapter.validate_python(
        {
            "event": "ACTION_HANDOFF",
            "data": {
                "version": 1,
                "action": "begin_checkout",
                "handoffToken": "chk_tok_123",
                "expiresAt": "2026-08-30T12:00:00Z",
                "display": {"airline": "Delta"},
            },
        }
    )
    assert isinstance(handoff_evt, ActionHandoffEvent)
    assert handoff_evt.data.handoffToken == "chk_tok_123"

    with pytest.raises(ValidationError):
        adapter.validate_python({"event": "unknown_event", "data": {}})

    all_eight_wire_payloads = [
        (
            {"event": "token", "data": {"content": "hello"}},
            TokenEvent,
        ),
        (
            {"event": "tool_call", "data": {"name": "search", "inputs": {"q": "flight"}}},
            ToolCallEvent,
        ),
        (
            {"event": "tool_result", "data": {"name": "search", "result": "done"}},
            ToolResultEvent,
        ),
        (
            {"event": "flight_results", "data": {"results": [{"id": 1}]}},
            FlightResultsEvent,
        ),
        (
            {
                "event": "ACTION_HANDOFF",
                "data": {
                    "version": 1,
                    "action": "begin_checkout",
                    "handoffToken": "tok_xyz",
                    "expiresAt": "2026-08-30T12:00:00Z",
                    "display": {"price": 100},
                },
            },
            ActionHandoffEvent,
        ),
        (
            {
                "event": "ACTION_REQUIRED",
                "data": {
                    "action": "COMPLETE_PROFILE",
                    "target": "/profile",
                },
            },
            ActionRequiredEvent,
        ),
        (
            {"event": "done", "data": {"messageId": "m1", "sessionId": "s1"}},
            DoneEvent,
        ),
        (
            {
                "event": "error",
                "data": {"code": "ERR_FAIL", "message": "Failed operation"},
            },
            ErrorEvent,
        ),
    ]

    for wire_dict, expected_type in all_eight_wire_payloads:
        parsed = adapter.validate_python(wire_dict)
        assert isinstance(parsed, expected_type)
        assert parsed.event == wire_dict["event"]


def test_privacy_and_pii_isolation() -> None:
    # DonePayload only allows messageId and sessionId
    assert set(DonePayload.model_fields.keys()) == {"messageId", "sessionId"}
    with pytest.raises(ValidationError):
        DonePayload(messageId="m1", handoffToken="chk_tok_leak")
    with pytest.raises(ValidationError):
        DonePayload(messageId="m1", offerId="duffel_leak")
    with pytest.raises(ValidationError):
        DonePayload(messageId="m1", rawOffer={"id": "duffel_123"})

    # ErrorPayload only allows code, message, partialMessageId, error
    assert set(ErrorPayload.model_fields.keys()) == {
        "code",
        "message",
        "partialMessageId",
        "error",
    }
    with pytest.raises(ValidationError):
        ErrorPayload(code="E", message="m", handoffToken="chk_tok_leak")
    with pytest.raises(ValidationError):
        ErrorPayload(code="E", message="m", offerId="duffel_leak")
    with pytest.raises(ValidationError):
        ErrorPayload(code="E", message="m", rawOffer={"id": "duffel_123"})
