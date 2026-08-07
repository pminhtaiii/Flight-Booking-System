import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from agent.models.requests import RouteDecision
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig

from agent.graph import graph
from agent.tools.nestjs_client import NestJSClient


@pytest.fixture
def mock_nestjs_client():
    client = MagicMock(spec=NestJSClient)
    client.check_user_access = AsyncMock(return_value={"allowed": True})
    client.get_gateway_flights_search = AsyncMock()
    client.get_gateway_user_preferences = AsyncMock()
    client.get_gateway_user_booking_summaries = AsyncMock()
    client.get_gateway_booking_detail = AsyncMock()
    return client


@pytest.fixture
def mock_llm():
    mock_model = MagicMock()
    mock_model.ainvoke = AsyncMock()
    
    mock_model_with_tools = MagicMock()
    mock_model_with_tools.ainvoke = AsyncMock()
    
    mock_model.bind_tools.return_value = mock_model_with_tools
    return mock_model, mock_model_with_tools


@pytest.mark.asyncio
async def test_graph_search_flights_integration(mock_nestjs_client, mock_llm):
    mock_model, mock_model_with_tools = mock_llm

    # Setup NestJS client mock response
    mock_nestjs_client.post_gateway_flights_search_v2.return_value = {
        "snapshotVersion": 1,
        "snapshotExpiresAt": "2026-08-15T10:00:00Z",
        "selectionAttestation": "mock_attestation",
        "results": [
            {
                "flightOfferId": "offer-123",
                "duffelOfferId": "duffel-123",
                "airline": "VN",
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
                "baggageAllowance": "23kg checked"
            }
        ]
    }

    # Setup LLM trace
    # 1. First invoke: return tool call
    # 2. Second invoke: return final answer incorporating results
    mock_model_with_tools.ainvoke.side_effect = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "search_flights",
                    "args": {"origin": "HAN", "destination": "NRT", "date": "2026-07-15", "passengers": 1},
                    "id": "call_search"
                }
            ]
        ),
        AIMessage(content="I found a Vietnam Airlines flight VN310 departing at 08:30 for $452.00 USD.")
    ]

    config = RunnableConfig(
        configurable={"nestjs_client": mock_nestjs_client, "thread_id": "test_thread_1", "user_id": "user1"},
        configurable_keys=["nestjs_client", "thread_id", "user_id"]
    )

    with patch("agent.agents.chat_agent.ChatOpenAI", return_value=mock_model), \
         patch("agent.graph.graph.invoke_router", return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False)):
        initial_state = {
            "messages": [HumanMessage(content="find me flights from Hanoi to Tokyo on July 15")],
            "iteration_count": 0
        }
        final_state = await graph.ainvoke(initial_state, config=config)

        # Assertions
        assert len(final_state["messages"]) >= 3
        # Check tool called
        mock_nestjs_client.post_gateway_flights_search_v2.assert_called_once_with(
            chat_session_id="test_thread_1",
            proposed_snapshot_version=1,
            origin="HAN", destination="NRT", date="2026-07-15", passengers=1
        )
        # Check final message content
        assert "Vietnam Airlines flight VN310" in final_state["messages"][-1].content
        assert final_state["iteration_count"] == 1


@pytest.mark.asyncio
async def test_graph_get_user_preferences_integration(mock_nestjs_client, mock_llm):
    mock_model, mock_model_with_tools = mock_llm

    mock_nestjs_client.get_gateway_user_preferences.return_value = {
        "seatPreference": "window",
        "classPreference": "business",
        "preferredAirlines": ["VN"],
        "blacklistedAirlines": [],
        "dietaryNeeds": "vegetarian"
    }

    mock_model_with_tools.ainvoke.side_effect = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "get_user_preferences",
                    "args": {},
                    "id": "call_prefs"
                }
            ]
        ),
        AIMessage(content="Your travel preferences: seat is Window, class is Business.")
    ]

    config = RunnableConfig(
        configurable={"nestjs_client": mock_nestjs_client, "thread_id": "test_thread_2"},
        configurable_keys=["nestjs_client", "thread_id"]
    )

    with patch("agent.agents.chat_agent.ChatOpenAI", return_value=mock_model), \
         patch("agent.graph.graph.invoke_router", return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False)):
        initial_state = {
            "messages": [HumanMessage(content="what are my travel preferences?")],
            "iteration_count": 0
        }
        final_state = await graph.ainvoke(initial_state, config=config)

        mock_nestjs_client.get_gateway_user_preferences.assert_called_once()
        assert "seat is Window" in final_state["messages"][-1].content
        assert final_state["iteration_count"] == 1


@pytest.mark.asyncio
async def test_graph_list_user_booking_summaries_integration(mock_nestjs_client, mock_llm):
    mock_model, mock_model_with_tools = mock_llm

    mock_nestjs_client.get_gateway_user_booking_summaries.return_value = {
        "summaries": [
            {
                "airline": "VN",
                "status": "CONFIRMED",
                "origin": "HAN",
                "destination": "NRT",
                "departureAt": "2026-08-15T08:30:00Z",
                "arrivalAt": "2026-08-15T15:00:00Z",
                "durationMinutes": 330,
                "stopCount": 0,
                "agentReference": "ref-123"
            }
        ]
    }

    mock_model_with_tools.ainvoke.side_effect = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "list_user_booking_summaries",
                    "args": {},
                    "id": "call_bookings"
                }
            ]
        ),
        AIMessage(content="You have 1 active booking: Vietnam Airlines VN310.")
    ]

    config = RunnableConfig(
        configurable={"nestjs_client": mock_nestjs_client, "thread_id": "test_thread_3"},
        configurable_keys=["nestjs_client", "thread_id"]
    )

    with patch("agent.agents.chat_agent.ChatOpenAI", return_value=mock_model), \
         patch("agent.graph.graph.invoke_router", return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False)):
        initial_state = {
            "messages": [HumanMessage(content="show me my bookings")],
            "iteration_count": 0
        }
        final_state = await graph.ainvoke(initial_state, config=config)

        mock_nestjs_client.get_gateway_user_booking_summaries.assert_called_once()
        assert "Vietnam Airlines VN310" in final_state["messages"][-1].content
        assert final_state["iteration_count"] == 1


@pytest.mark.asyncio
async def test_graph_out_of_bounds_query(mock_nestjs_client, mock_llm):
    mock_model, mock_model_with_tools = mock_llm

    # Model refuses to answer or call tools
    mock_model_with_tools.ainvoke.return_value = AIMessage(
        content="I'm sorry, but that information (refund/cancellation policy) is not available."
    )

    config = RunnableConfig(
        configurable={"nestjs_client": mock_nestjs_client, "thread_id": "test_thread_4"},
        configurable_keys=["nestjs_client", "thread_id"]
    )

    with patch("agent.agents.chat_agent.ChatOpenAI", return_value=mock_model), \
         patch("agent.graph.graph.invoke_router", return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False)):
        initial_state = {
            "messages": [HumanMessage(content="What is the cancellation policy?")],
            "iteration_count": 0
        }
        final_state = await graph.ainvoke(initial_state, config=config)

        # Ensure no gateway tools were invoked
        mock_nestjs_client.get_gateway_flights_search.assert_not_called()
        mock_nestjs_client.get_gateway_user_preferences.assert_not_called()
        mock_nestjs_client.get_gateway_user_booking_summaries.assert_not_called()

        assert "not available" in final_state["messages"][-1].content.lower()


@pytest.mark.asyncio
async def test_graph_iteration_limit_capping(mock_nestjs_client, mock_llm):
    mock_model, mock_model_with_tools = mock_llm

    # 6 loop invocations, returning distinct AIMessage instances with unique IDs to prevent in-place overwriting in add_messages
    mock_model_with_tools.ainvoke.side_effect = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "get_user_preferences",
                    "args": {},
                    "id": f"loop_call_{i}"
                }
            ],
            id=f"ai_call_{i}"
        )
        for i in range(6)
    ]
    
    # Final answer node invocation
    mock_model.ainvoke.return_value = AIMessage(
        content="Iteration limit reached. I am unable to proceed further."
    )

    # Mock gateway preferences response for the loops
    mock_nestjs_client.get_gateway_user_preferences.return_value = {
        "seatPreference": "window",
        "classPreference": "business",
        "preferredAirlines": ["VN"],
        "blacklistedAirlines": [],
        "dietaryNeeds": "vegetarian"
    }

    config = RunnableConfig(
        configurable={"nestjs_client": mock_nestjs_client, "thread_id": "test_thread_5"},
        configurable_keys=["nestjs_client", "thread_id"]
    )

    with patch("agent.agents.chat_agent.ChatOpenAI", return_value=mock_model), \
         patch("agent.graph.graph.invoke_router", return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False)):
        initial_state = {
            "messages": [HumanMessage(content="run loop")],
            "iteration_count": 0
        }
        final_state = await graph.ainvoke(initial_state, config=config)
        assert final_state["iteration_count"] == 5
        assert "limit reached" in final_state["messages"][-1].content.lower()


@pytest.mark.asyncio
async def test_graph_topology():
    from agent.graph.graph import graph, workflow
    from agent.tools.registry import get_travel_tools

    nodes = set(workflow.nodes.keys())
    assert "confirm" not in nodes, "Confirm node should be removed"
    
    # Verify the checkpointer is absent
    assert graph.checkpointer is None, "MemorySaver should be removed"

    # Check book_flight is absent
    tools = {t.name for t in get_travel_tools()}
    assert "book_flight" not in tools, "book_flight tool should be removed"
