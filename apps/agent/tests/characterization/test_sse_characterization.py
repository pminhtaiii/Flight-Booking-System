import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import jwt
import pytest
from langchain_core.messages import AIMessageChunk, HumanMessage
from pydantic import BaseModel, ConfigDict

from agent.main import app
from agent.models.events import HandoffEvent
from agent.models.snapshot import TrustedSearchSnapshot
from agent.repositories.trusted_snapshot_repository import TrustedSnapshotRepository

from .test_snapshot_characterization import FakeAsyncRedis

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
    model_config = ConfigDict(extra="forbid")


class ErrorPayload(BaseModel):
    code: str
    message: str
    partialMessageId: Optional[str] = None
    error: Optional[str] = None
    model_config = ConfigDict(extra="forbid")


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


def parse_sse_stream_lines(lines: List[str]) -> List[Dict[str, Any]]:
    """Parse multi-event SSE response stream lines into event objects."""
    events = []
    current_event = {}
    for line in lines:
        if isinstance(line, bytes):
            line = line.decode("utf-8")
        line = line.strip()
        if not line:
            if current_event:
                events.append(current_event)
                current_event = {}
            continue
        if ":" in line:
            key, val = line.split(":", 1)
            key = key.strip()
            val = val.strip()
            if key == "event":
                current_event["event"] = val
            elif key == "data":
                current_event["data"] = json.loads(val)
    if current_event:
        events.append(current_event)
    return events


def format_sse_wire_event(event_name: str, payload: Dict[str, Any]) -> str:
    """Format an event and payload dict to standard SSE wire format."""
    return f"event: {event_name}\ndata: {json.dumps(payload)}\n\n"


JWT_SECRET = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"


def get_auth_headers(sub: str = "user_seq_123", session_id: str = "ses_seq_456") -> Dict[str, str]:
    payload = {
        "sub": sub,
        "email": "test@example.com",
        "iss": "booking-systems-api",
        "aud": "booking-systems-clients",
        "jti": f"test-jti-{sub}",
        "exp": int(time.time()) + 3600,
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


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
            "scope": "INTERNATIONAL",
            "display": {"title": "Action Required"},
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
        }
        model = DonePayload.model_validate(raw)
        assert model.messageId == "msg_char_789"
        assert model.sessionId == "ses_char_456"

        sse_wire = format_sse_wire_event("done", raw)
        parsed = parse_sse_wire_chunk(sse_wire)
        assert parsed["event"] == "done"
        assert parsed["data"]["messageId"] == "msg_char_789"
        assert parsed["data"]["sessionId"] == "ses_char_456"

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
# 2. Event Sequence Ordering Characterization Tests (Production Stream Emitter)
# =========================================================================


class TestSSESequenceOrdering:
    """Validates the canonical ordering lifecycle of SSE event streams through the production emitter."""

    @pytest.mark.asyncio
    async def test_canonical_flight_search_and_handoff_sequence(self, monkeypatch):
        """
        Tests the standard event lifecycle executed through the production emitter:
        token -> tool_call -> tool_result -> flight_results -> ACTION_HANDOFF -> done
        """
        headers = get_auth_headers(sub="user_seq_123", session_id="ses_seq_456")

        mock_guardrail = MagicMock()
        mock_guardrail.is_healthy.return_value = True
        mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
        monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

        fake_redis = FakeAsyncRedis()
        monkeypatch.setattr("agent.middleware.rate_limit.get_redis_client", lambda: fake_redis)
        monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: fake_redis)
        monkeypatch.setattr(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            AsyncMock(),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.check_user_access",
            AsyncMock(return_value={"allowed": True}),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.get_memory",
            AsyncMock(return_value={"recentMessages": [], "summary": ""}),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.create_message_batch",
            AsyncMock(
                return_value={
                    "messages": [
                        {"id": "msg_user_1", "sender": "USER"},
                        {"id": "msg_agent_1", "sender": "AGENT"},
                    ]
                }
            ),
        )
        monkeypatch.setattr("agent.memory.manager.MemoryManager.check_and_summarize", AsyncMock())

        # Pre-seed a trusted snapshot in repository so search_flights produces flight_results event
        now = datetime.now(timezone.utc)
        snapshot = TrustedSearchSnapshot.model_validate(
            {
                "schemaVersion": 1,
                "snapshotVersion": 1,
                "userId": "user_seq_123",
                "sessionId": "ses_seq_456",
                "createdAt": now,
                "expiresAt": now + timedelta(minutes=15),
                "fingerprint": "fp_123",
                "selectionAttestation": "attest_123",
                "results": [
                    {
                        "offerIndex": 1,
                        "flightOfferId": "flight_offer_1",
                        "duffelOfferId": "duffel_offer_1",
                        "airline": "Japan Airlines",
                        "origin": "SGN",
                        "destination": "NRT",
                        "departureAt": now,
                        "arrivalAt": now + timedelta(hours=6),
                        "price": "450.00",
                        "currency": "USD",
                    }
                ],
            }
        )
        await TrustedSnapshotRepository(fake_redis).save_snapshot(snapshot)

        mock_graph = MagicMock()

        async def mock_astream_events(*args, **kwargs):
            # 1. token events
            yield {
                "event": "on_chat_model_stream",
                "data": {"chunk": AIMessageChunk(content="Searching for ")},
            }
            yield {
                "event": "on_chat_model_stream",
                "data": {"chunk": AIMessageChunk(content="flights to Tokyo...")},
            }
            # 2. tool_call event
            yield {
                "event": "on_tool_start",
                "name": "search_flights",
                "data": {"input": {"origin": "SGN", "destination": "NRT", "date": "2026-09-10"}},
            }
            # 3. tool_result and flight_results events
            yield {
                "event": "on_tool_end",
                "name": "search_flights",
                "data": {"output": "Found 1 flight from SGN to NRT"},
            }
            # 4. ACTION_HANDOFF event
            yield {
                "event": "on_chain_end",
                "name": "create_handoff_token",
                "data": {
                    "output": {
                        "action": {
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
                        }
                    }
                },
            }

        mock_graph.astream_events = mock_astream_events
        mock_state = MagicMock()
        mock_state.next = ()
        mock_state.values = {"messages": [HumanMessage(content="find flights")]}
        mock_graph.aget_state = AsyncMock(return_value=mock_state)

        with patch("agent.streaming.sse.graph", mock_graph):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
                async with ac.stream(
                    "POST",
                    "/chat/stream",
                    json={"message": "find flights", "sessionId": "ses_seq_456"},
                    headers=headers,
                ) as response:
                    assert response.status_code == 200
                    lines = [line async for line in response.aiter_lines()]

        stream_events = parse_sse_stream_lines(lines)

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

    @pytest.mark.asyncio
    async def test_canonical_action_required_sequence(self, monkeypatch):
        """
        Tests the readiness check sequence executed through the production emitter:
        token -> tool_call -> tool_result -> ACTION_REQUIRED
        """
        headers = get_auth_headers(sub="user_act_123", session_id="ses_act_456")

        mock_guardrail = MagicMock()
        mock_guardrail.is_healthy.return_value = True
        mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
        monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

        fake_redis = FakeAsyncRedis()
        monkeypatch.setattr("agent.middleware.rate_limit.get_redis_client", lambda: fake_redis)
        monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: fake_redis)
        monkeypatch.setattr(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            AsyncMock(),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.check_user_access",
            AsyncMock(return_value={"allowed": True}),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.get_memory",
            AsyncMock(return_value={"recentMessages": [], "summary": ""}),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.create_message_batch",
            AsyncMock(
                return_value={
                    "messages": [
                        {"id": "msg_user_1", "sender": "USER"},
                    ]
                }
            ),
        )

        mock_graph = MagicMock()

        async def mock_astream_events(*args, **kwargs):
            yield {
                "event": "on_chat_model_stream",
                "data": {"chunk": AIMessageChunk(content="Checking readiness...")},
            }
            yield {
                "event": "on_tool_start",
                "name": "check_booking_readiness",
                "data": {"input": {"message": "Checking booking readiness..."}},
            }
            yield {
                "event": "on_tool_end",
                "name": "check_booking_readiness",
                "data": {
                    "output": json.dumps(
                        {
                            "ready": False,
                            "nextAction": "COMPLETE_PROFILE",
                            "scope": "INTERNATIONAL",
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
                    )
                },
            }

        mock_graph.astream_events = mock_astream_events
        mock_state = MagicMock()
        mock_state.next = ()
        mock_state.values = {"messages": [HumanMessage(content="check readiness")]}
        mock_graph.aget_state = AsyncMock(return_value=mock_state)

        with patch("agent.streaming.sse.graph", mock_graph):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
                async with ac.stream(
                    "POST",
                    "/chat/stream",
                    json={"message": "check readiness", "sessionId": "ses_act_456"},
                    headers=headers,
                ) as response:
                    assert response.status_code == 200
                    lines = [line async for line in response.aiter_lines()]

        stream_events = parse_sse_stream_lines(lines)
        observed_order = [e["event"] for e in stream_events]
        assert observed_order == ["token", "tool_call", "tool_result", "ACTION_REQUIRED"]

        for raw_event in stream_events:
            ev_name = raw_event["event"]
            payload_cls = AUTHORITATIVE_EVENT_PAYLOAD_MAP[ev_name]
            assert payload_cls.model_validate(raw_event["data"]) is not None


# =========================================================================
# 3. Failure Finalization Ordering Characterization Tests (Production Stream Emitter)
# =========================================================================


class TestSSEFailureFinalization:
    """Validates that failures finalize with error event and terminate stream via production emitter."""

    @pytest.mark.parametrize(
        "failure_mode,expected_code",
        [
            ("GUARDRAIL_BLOCKED", "GUARDRAIL_BLOCKED"),
            ("READINESS_RESPONSE_INVALID", "READINESS_RESPONSE_INVALID"),
            ("HANDOFF_FAILED", "HANDOFF_FAILED"),
            ("LLM_ERROR", "LLM_ERROR"),
        ],
    )
    @pytest.mark.asyncio
    async def test_error_finalization_payload_structure(
        self, failure_mode, expected_code, monkeypatch
    ):
        headers = get_auth_headers(sub="user_err_123", session_id="ses_err_456")

        mock_guardrail = MagicMock()
        mock_guardrail.is_healthy.return_value = True
        if failure_mode == "GUARDRAIL_BLOCKED":
            mock_guardrail.validate_message = AsyncMock(return_value=(False, "Safety violation"))
        else:
            mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
        monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

        fake_redis = FakeAsyncRedis()
        monkeypatch.setattr("agent.middleware.rate_limit.get_redis_client", lambda: fake_redis)
        monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: fake_redis)
        monkeypatch.setattr(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            AsyncMock(),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.check_user_access",
            AsyncMock(return_value={"allowed": True}),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.get_memory",
            AsyncMock(return_value={"recentMessages": [], "summary": ""}),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.create_message_batch",
            AsyncMock(return_value={"messages": []}),
        )

        mock_graph = MagicMock()

        async def mock_astream_events(*args, **kwargs):
            if failure_mode == "READINESS_RESPONSE_INVALID":
                yield {
                    "event": "on_tool_end",
                    "name": "check_booking_readiness",
                    "data": {"output": json.dumps({"error": "invalid response"})},
                }
            elif failure_mode == "HANDOFF_FAILED":
                yield {
                    "event": "on_chain_end",
                    "name": "create_handoff_token",
                    "data": {"output": {"action": {"error": "Quote expired"}}},
                }
            elif failure_mode == "LLM_ERROR":
                raise RuntimeError("LLM backend disconnected")

        mock_graph.astream_events = mock_astream_events
        mock_state = MagicMock()
        mock_state.next = ()
        mock_state.values = {"messages": [HumanMessage(content="hello")]}
        mock_graph.aget_state = AsyncMock(return_value=mock_state)

        with patch("agent.streaming.sse.graph", mock_graph):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
                async with ac.stream(
                    "POST",
                    "/chat/stream",
                    json={"message": "hello", "sessionId": "ses_err_456"},
                    headers=headers,
                ) as response:
                    assert response.status_code == 200
                    lines = [line async for line in response.aiter_lines()]

        events = parse_sse_stream_lines(lines)
        error_events = [e for e in events if e["event"] == "error"]
        assert len(error_events) == 1
        err = error_events[0]
        parsed = ErrorPayload.model_validate(err["data"])
        assert parsed.code == expected_code
        assert parsed.message is not None

    @pytest.mark.asyncio
    async def test_error_is_terminal_in_stream_sequence(self, monkeypatch):
        """
        Verify stream termination behavior: once an error event is yielded,
        the stream finishes and no 'done' or subsequent token events are emitted.
        """
        headers = get_auth_headers(sub="user_term_123", session_id="ses_term_456")

        mock_guardrail = MagicMock()
        mock_guardrail.is_healthy.return_value = True
        mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
        monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

        fake_redis = FakeAsyncRedis()
        monkeypatch.setattr("agent.middleware.rate_limit.get_redis_client", lambda: fake_redis)
        monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: fake_redis)
        monkeypatch.setattr(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            AsyncMock(),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.check_user_access",
            AsyncMock(return_value={"allowed": True}),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.get_memory",
            AsyncMock(return_value={"recentMessages": [], "summary": ""}),
        )
        monkeypatch.setattr(
            "agent.tools.nestjs_client.NestJSClient.create_message_batch",
            AsyncMock(return_value={"messages": []}),
        )

        mock_graph = MagicMock()

        async def mock_astream_events(*args, **kwargs):
            yield {
                "event": "on_chat_model_stream",
                "data": {"chunk": AIMessageChunk(content="Starting search...")},
            }
            raise RuntimeError("LLM exploded")

        mock_graph.astream_events = mock_astream_events
        mock_state = MagicMock()
        mock_state.next = ()
        mock_state.values = {"messages": [HumanMessage(content="start search")]}
        mock_graph.aget_state = AsyncMock(return_value=mock_state)

        with patch("agent.streaming.sse.graph", mock_graph):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
                async with ac.stream(
                    "POST",
                    "/chat/stream",
                    json={"message": "start search", "sessionId": "ses_term_456"},
                    headers=headers,
                ) as response:
                    assert response.status_code == 200
                    lines = [line async for line in response.aiter_lines()]

        consumed_events = parse_sse_stream_lines(lines)
        assert len(consumed_events) >= 2
        assert consumed_events[-1]["event"] == "error"
        assert "done" not in [e["event"] for e in consumed_events]
