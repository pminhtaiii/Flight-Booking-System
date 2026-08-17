import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
import json
import httpx
import time
import jwt

from agent.config import get_settings
from agent.graph.graph import graph, router_node
from agent.graph.nodes import create_handoff_token
from agent.graph.state import AgentState
from agent.models.requests import RouteDecision
from agent.tools.nestjs_client import NestJSClient
from agent.main import app


JWT_SECRET = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"


def get_auth_headers():
    payload = {
        "sub": "12345",
        "iss": "booking-systems-api",
        "aud": "booking-systems-clients",
        "jti": "jti-test-rollback-uuid",
        "email": "test@example.com",
        "exp": int(time.time()) + 100,
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


def parse_sse(lines):
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
                try:
                    current_event["data"] = json.loads(val)
                except Exception:
                    current_event["data"] = val
    if current_event:
        events.append(current_event)
    return events


@pytest.fixture
def mock_nestjs_client():
    client = MagicMock(spec=NestJSClient)
    client.check_user_access = AsyncMock(return_value={"allowed": True})
    client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    client.create_message_batch = AsyncMock(
        return_value={
            "messages": [
                {"id": "msg-user-123", "sender": "USER"},
                {"id": "msg-agent-456", "sender": "AGENT"},
            ]
        }
    )
    client.get_gateway_flights_search = AsyncMock()
    client.post_gateway_flights_search_v2 = AsyncMock()
    client.get_gateway_user_preferences = AsyncMock()
    client.get_gateway_user_booking_summaries = AsyncMock()
    client.get_gateway_booking_detail = AsyncMock()
    client.create_handoff_token = AsyncMock()
    return client


@pytest.fixture
def mock_llm():
    mock_model = MagicMock()
    mock_model.ainvoke = AsyncMock()

    mock_model_with_tools = MagicMock()
    mock_model_with_tools.ainvoke = AsyncMock()

    mock_model.bind_tools.return_value = mock_model_with_tools
    return mock_model, mock_model_with_tools


@pytest.fixture(autouse=True)
def mock_guardrails(monkeypatch):
    mock_gr = MagicMock()
    mock_gr.is_healthy.return_value = True
    mock_gr.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)
    return mock_gr


# ============================================================================
# Step 1 Rollback Tests:
# FEATURE_FLAG_CHAT_HANDOFF_ISSUE=False, FEATURE_FLAG_CHAT_HANDOFF_ACCEPT=True
# ============================================================================


@pytest.mark.asyncio
async def test_step1_rollback_create_handoff_token_node_returns_disabled_error(
    mock_nestjs_client,
):
    """
    Step 1 Rollback: When FEATURE_FLAG_CHAT_HANDOFF_ISSUE=False and ACCEPT=True,
    deterministic node create_handoff_token returns error 'Chat handoff issuance is disabled.'
    and does not call upstream NestJS handoff endpoint.
    """
    state: AgentState = {
        "messages": [HumanMessage(content="Book flight 1")],
        "signal": {"intent": "checkout", "offer_index": 1},
        "trusted_snapshot": {
            "version": 1,
            "attestation": "test_attestation_token",
            "fingerprint": "fp_test_123",
            "results": [
                {
                    "airline": "Vietnam Airlines",
                    "origin": "HAN",
                    "destination": "NRT",
                    "departureAt": "2026-08-15T08:30:00Z",
                    "arrivalAt": "2026-08-15T15:00:00Z",
                    "price": "452.00",
                    "currency": "USD",
                }
            ],
        },
        "iteration_count": 0,
    }

    config = RunnableConfig(
        configurable={
            "nestjs_client": mock_nestjs_client,
            "thread_id": "test_thread_rollback_1",
            "user_id": "user_rollback_1",
        }
    )

    with patch("agent.graph.nodes.get_settings") as mock_settings:
        mock_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = False
        mock_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = True

        result = await create_handoff_token(state, config)

    assert result == {
        "action": {"error": "Chat handoff issuance is disabled."}
    }
    mock_nestjs_client.create_handoff_token.assert_not_called()


@pytest.mark.asyncio
async def test_step1_rollback_sse_stream_emits_no_action_handoff_on_disabled_flag(
    mock_nestjs_client,
):
    """
    Step 1 Rollback: In full SSE chat stream, verify that when FEATURE_FLAG_CHAT_HANDOFF_ISSUE=False,
    no ACTION_HANDOFF event is emitted, an error event with 'Chat handoff issuance is disabled.'
    is returned, and zero token creation calls reach NestJS client.
    """
    headers = get_auth_headers()

    trusted_snapshot = {
        "version": 1,
        "attestation": "test_attestation_token",
        "fingerprint": "test_fingerprint",
        "results": [
            {
                "flightOfferId": "offer-123",
                "airline": "Vietnam Airlines",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T08:30:00Z",
                "arrivalTime": "2026-07-15T15:00:00Z",
                "price": "452.00",
                "currency": "USD",
            }
        ],
    }

    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.outputs import ChatResult, ChatGeneration, ChatGenerationChunk
    from langchain_core.messages import AIMessageChunk, BaseMessage
    from typing import List, Optional, Any, AsyncIterator
    from pydantic import Field

    class MockStreamingLLM(BaseChatModel):
        responses: List[Any] = Field(default_factory=list)

        def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
            return self

        def _generate(self, messages: List[BaseMessage], **kwargs: Any) -> ChatResult:
            resp = self.responses.pop(0) if self.responses else AIMessage(content="Hello")
            return ChatResult(generations=[ChatGeneration(message=resp)])

        async def _astream(self, messages: List[BaseMessage], **kwargs: Any) -> AsyncIterator[ChatGenerationChunk]:
            resp = self.responses.pop(0) if self.responses else AIMessage(content="Hello")
            if resp.tool_calls:
                yield ChatGenerationChunk(
                    message=AIMessageChunk(
                        content=resp.content,
                        tool_calls=resp.tool_calls,
                        id=resp.id,
                    )
                )
            else:
                yield ChatGenerationChunk(message=AIMessageChunk(content=resp.content or ""))

        @property
        def _llm_type(self) -> str:
            return "mock-streaming-llm"

    llm = MockStreamingLLM(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "signal_checkout_intent",
                        "args": {"offer_index": 1},
                        "id": "call_signal_step1_rollback",
                    }
                ],
            )
        ]
    )

    mock_snapshot_obj = MagicMock()
    mock_snapshot_obj.model_dump.return_value = trusted_snapshot

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(intent="CHECKOUT", confidence=1.0, isCommitment=True),
        ),
        patch("agent.graph.nodes.get_settings") as mock_settings,
        patch(
            "agent.streaming.sse.TrustedSnapshotRepository.get_snapshot",
            new_callable=AsyncMock,
            return_value=mock_snapshot_obj,
        ),
    ):
        mock_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = False
        mock_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = True
        mock_settings.return_value.AGENT_MAX_ITERATIONS = 5

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={
                    "message": "book flight 1",
                    "sessionId": "session-step1-rollback",
                },
                headers=headers,
            )
            assert response.status_code == 200

            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)

            action_events = [e for e in events if e.get("event") == "ACTION_HANDOFF"]
            error_events = [e for e in events if e.get("event") == "error"]

            # Verify no ACTION_HANDOFF event is emitted
            assert len(action_events) == 0

            # Verify error event is emitted indicating handoff issuance disabled
            assert len(error_events) >= 1
            error_payload = error_events[0]["data"]
            assert error_payload.get("code") == "HANDOFF_FAILED"
            assert "Chat handoff issuance is disabled." in (
                error_payload.get("message", "") + error_payload.get("error", "")
            )

            # Ensure upstream create_handoff_token was never called
            mock_nestjs_client.create_handoff_token.assert_not_called()


# ============================================================================
# Step 2 Rollback Tests:
# FEATURE_FLAG_CHAT_MULTI_AGENT=False
# ============================================================================


@pytest.mark.asyncio
async def test_step2_rollback_router_node_bypasses_router_llm():
    """
    Step 2 Rollback: When FEATURE_FLAG_CHAT_MULTI_AGENT=False,
    router_node immediately falls back to safe single-agent execution ('travel')
    without calling invoke_router or invoking any router LLM.
    """
    state: AgentState = {
        "messages": [HumanMessage(content="Find flights from Hanoi to Tokyo")],
        "iteration_count": 0,
    }
    config = RunnableConfig(configurable={"thread_id": "test_thread_rollback_3"})

    with (
        patch("agent.graph.graph.get_settings") as mock_settings,
        patch("agent.graph.graph.invoke_router") as mock_invoke_router,
    ):
        mock_settings.return_value.FEATURE_FLAG_CHAT_MULTI_AGENT = False

        decision = await router_node(state, config)

        assert decision == {"route": "travel", "disambiguation": None}
        mock_invoke_router.assert_not_called()


@pytest.mark.asyncio
async def test_step2_rollback_single_agent_flight_search_succeeds(
    mock_nestjs_client, mock_llm
):
    """
    Step 2 Rollback: When FEATURE_FLAG_CHAT_MULTI_AGENT=False,
    flight search queries execute safely through single-agent (travel assistant)
    path without calling router LLM or throwing unhandled exceptions.
    """
    mock_model, mock_model_with_tools = mock_llm

    mock_nestjs_client.post_gateway_flights_search_v2.return_value = {
        "snapshotVersion": 1,
        "snapshotExpiresAt": "2026-08-15T10:00:00Z",
        "selectionAttestation": "sel_attestation_mock",
        "results": [
            {
                "flightOfferId": "off_mock_456",
                "duffelOfferId": "duffel_mock_456",
                "airline": "Vietnam Airlines",
                "flightNumber": "VN310",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T08:30:00Z",
                "arrivalTime": "2026-07-15T15:00:00Z",
                "duration": 330,
                "stops": 0,
                "price": 452.00,
                "currency": "USD",
                "fareClass": "economy",
                "baggageAllowance": "23kg checked",
            }
        ],
    }

    mock_model_with_tools.ainvoke.side_effect = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "search_flights",
                    "args": {
                        "origin": "HAN",
                        "destination": "NRT",
                        "date": "2026-07-15",
                        "passengers": 1,
                    },
                    "id": "call_search_rollback",
                }
            ],
        ),
        AIMessage(
            content="I found Vietnam Airlines flight VN310 from HAN to NRT for $452.00 USD."
        ),
    ]

    config = RunnableConfig(
        configurable={
            "nestjs_client": mock_nestjs_client,
            "thread_id": "test_thread_single_agent_search",
            "user_id": "user_single_agent_1",
        }
    )

    with (
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=mock_model),
        patch("agent.graph.graph.get_settings") as mock_graph_settings,
        patch("agent.graph.graph.invoke_router") as mock_invoke_router,
    ):
        mock_graph_settings.return_value.FEATURE_FLAG_CHAT_MULTI_AGENT = False
        mock_graph_settings.return_value.AGENT_MAX_ITERATIONS = 5

        initial_state: AgentState = {
            "messages": [
                HumanMessage(content="find me flights from Hanoi to Tokyo on July 15")
            ],
            "iteration_count": 0,
        }

        final_state = await graph.ainvoke(initial_state, config=config)

    # Router must NOT have been called
    mock_invoke_router.assert_not_called()

    # Search flights tool must have been invoked via NestJS client
    mock_nestjs_client.post_gateway_flights_search_v2.assert_called_once_with(
        chat_session_id="test_thread_single_agent_search",
        proposed_snapshot_version=1,
        origin="HAN",
        destination="NRT",
        date="2026-07-15",
        passengers=1,
    )

    # Final response delivered cleanly
    assert len(final_state["messages"]) >= 3
    assert (
        "Vietnam Airlines flight VN310"
        in final_state["messages"][-1].content
    )
    assert final_state["iteration_count"] == 1


@pytest.mark.asyncio
async def test_step2_rollback_single_agent_preference_query_succeeds(
    mock_nestjs_client, mock_llm
):
    """
    Step 2 Rollback: When FEATURE_FLAG_CHAT_MULTI_AGENT=False,
    user preference queries execute safely through single-agent (travel assistant)
    path without calling router LLM or throwing unhandled exceptions.
    """
    mock_model, mock_model_with_tools = mock_llm

    mock_nestjs_client.get_gateway_user_preferences.return_value = {
        "seatPreference": "window",
        "classPreference": "business",
        "preferredAirlines": ["VN"],
        "blacklistedAirlines": [],
        "dietaryNeeds": "vegetarian",
    }

    mock_model_with_tools.ainvoke.side_effect = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "get_user_preferences",
                    "args": {},
                    "id": "call_prefs_rollback",
                }
            ],
        ),
        AIMessage(
            content="Your travel preferences: Window seat, Business class, Vegetarian meals."
        ),
    ]

    config = RunnableConfig(
        configurable={
            "nestjs_client": mock_nestjs_client,
            "thread_id": "test_thread_single_agent_prefs",
            "user_id": "user_single_agent_2",
        }
    )

    with (
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=mock_model),
        patch("agent.graph.graph.get_settings") as mock_graph_settings,
        patch("agent.graph.graph.invoke_router") as mock_invoke_router,
    ):
        mock_graph_settings.return_value.FEATURE_FLAG_CHAT_MULTI_AGENT = False
        mock_graph_settings.return_value.AGENT_MAX_ITERATIONS = 5

        initial_state: AgentState = {
            "messages": [HumanMessage(content="what are my travel preferences?")],
            "iteration_count": 0,
        }

        final_state = await graph.ainvoke(initial_state, config=config)

    # Router must NOT have been called
    mock_invoke_router.assert_not_called()

    # Preference tool must have been called
    mock_nestjs_client.get_gateway_user_preferences.assert_called_once()

    # Final response delivered cleanly
    assert (
        "Window seat" in final_state["messages"][-1].content
        or "Business class" in final_state["messages"][-1].content
    )
    assert final_state["iteration_count"] == 1


@pytest.mark.asyncio
async def test_step2_rollback_out_of_bounds_query_no_unhandled_exception(
    mock_nestjs_client, mock_llm
):
    """
    Step 2 Rollback: When FEATURE_FLAG_CHAT_MULTI_AGENT=False,
    out-of-bounds / ambiguous queries are handled gracefully by travel assistant
    without unhandled exceptions.
    """
    mock_model, mock_model_with_tools = mock_llm

    mock_model_with_tools.ainvoke.return_value = AIMessage(
        content="I am sorry, but I do not have access to cancellation policy documents."
    )

    config = RunnableConfig(
        configurable={
            "nestjs_client": mock_nestjs_client,
            "thread_id": "test_thread_single_agent_oob",
            "user_id": "user_single_agent_3",
        }
    )

    with (
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=mock_model),
        patch("agent.graph.graph.get_settings") as mock_graph_settings,
        patch("agent.graph.graph.invoke_router") as mock_invoke_router,
    ):
        mock_graph_settings.return_value.FEATURE_FLAG_CHAT_MULTI_AGENT = False
        mock_graph_settings.return_value.AGENT_MAX_ITERATIONS = 5

        initial_state: AgentState = {
            "messages": [HumanMessage(content="Can you explain the detailed refund policy?")],
            "iteration_count": 0,
        }

        final_state = await graph.ainvoke(initial_state, config=config)

    mock_invoke_router.assert_not_called()
    assert "not have access" in final_state["messages"][-1].content.lower()
