from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import HumanMessage

from agent.graph.router import invoke_router
from agent.graph.state import AgentState
from agent.models.requests import RouteDecision


@pytest.fixture
def base_state() -> AgentState:
    return {
        "messages": [HumanMessage(content="I want to book a flight")],
        "iteration_count": 0,
        "pending_confirmation": None,
        "handoff_required": False,
        "trusted_snapshot": None,
    }


@pytest.mark.asyncio
async def test_strict_router_output(base_state):
    """Test that a valid LLM response is parsed into a RouteDecision."""
    with patch("agent.graph.router.get_chat_model") as mock_get_model:
        mock_llm = MagicMock()
        mock_with_structured = AsyncMock()
        mock_with_structured.ainvoke.return_value = RouteDecision(
            intent="CHECKOUT", confidence=0.9, isCommitment=True, selectionIndex=1
        )
        mock_llm.with_structured_output.return_value = mock_with_structured
        mock_get_model.return_value = mock_llm

        decision = await invoke_router(base_state)

        assert isinstance(decision, RouteDecision)
        assert decision.intent == "CHECKOUT"
        assert decision.confidence == 0.9
        assert decision.isCommitment is True
        assert decision.selectionIndex == 1


@pytest.mark.asyncio
async def test_router_malformed_output(base_state):
    """Test that malformed output falls back to Travel Assistant (SEARCH intent)."""
    with patch("agent.graph.router.get_chat_model") as mock_get_model:
        mock_llm = MagicMock()
        mock_with_structured = AsyncMock()
        # Simulate validation error or malformed output
        mock_with_structured.ainvoke.side_effect = Exception("Malformed output")
        mock_llm.with_structured_output.return_value = mock_with_structured
        mock_get_model.return_value = mock_llm

        decision = await invoke_router(base_state)

        assert isinstance(decision, RouteDecision)
        assert decision.intent in ["SEARCH", "BOOKING_INQUIRY"]  # Travel Assistant intents


@pytest.mark.asyncio
async def test_router_confidence_bound(base_state):
    """Test low confidence for a non-checkout message falls back to Travel Assistant."""
    with patch("agent.graph.router.get_chat_model") as mock_get_model:
        mock_llm = MagicMock()
        mock_with_structured = AsyncMock()
        mock_with_structured.ainvoke.return_value = RouteDecision(
            intent="GENERAL",
            confidence=0.1,  # low confidence
            isCommitment=False,
        )
        mock_llm.with_structured_output.return_value = mock_with_structured
        mock_get_model.return_value = mock_llm

        decision = await invoke_router(base_state)

        assert isinstance(decision, RouteDecision)
        # Should fallback to Travel Assistant (SEARCH/BOOKING_INQUIRY) due to low confidence
        assert decision.intent in ["SEARCH", "BOOKING_INQUIRY"]
