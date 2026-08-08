import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
from langchain_core.runnables import RunnableConfig

from agent.agents.checkout_orchestrator import checkout_orchestrator_node, CHECKOUT_PROMPT
from agent.graph.state import AgentState

@pytest.fixture
def run_config():
    return RunnableConfig(configurable={"thread_id": "test-session"})

@pytest.mark.asyncio
async def test_checkout_orchestrator_node_adds_system_prompt(run_config):
    state: AgentState = {
        "messages": [HumanMessage(content="I want to book the first flight")],
        "iteration_count": 0,
        "disambiguation": "none"
    }

    mock_model = MagicMock()
    mock_model.bind_tools = MagicMock(return_value=mock_model)
    mock_model.ainvoke = AsyncMock(return_value=AIMessage(content="Starting checkout for flight 1", tool_calls=[{"name": "signal_checkout_intent", "args": {"offer_index": 1}, "id": "call_123"}]))

    with patch("agent.agents.checkout_orchestrator.get_chat_model", return_value=mock_model):
        with patch("agent.agents.checkout_orchestrator.get_checkout_tools", return_value=[MagicMock()]):
            result = await checkout_orchestrator_node(state, run_config)

    assert "messages" in result
    assert len(result["messages"]) == 1
    
    # Assert model was called with SystemMessage
    call_args = mock_model.ainvoke.call_args
    assert call_args is not None
    messages_passed = call_args[0][0]
    assert len(messages_passed) == 2
    assert isinstance(messages_passed[0], SystemMessage)
    assert messages_passed[0].content == CHECKOUT_PROMPT
    assert isinstance(messages_passed[1], HumanMessage)
