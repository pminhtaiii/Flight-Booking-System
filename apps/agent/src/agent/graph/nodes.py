import json
from langchain_core.messages import SystemMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.prebuilt import ToolNode

from agent.agents.chat_agent import get_chat_model
from agent.tools.registry import get_tools
from agent.tools.nestjs_client import validate_booking_readiness_response
from agent.graph.state import AgentState
from agent.agents.travel_assistant import TRAVEL_PROMPT

async def final_answer_node(state: AgentState, config: RunnableConfig) -> dict:
    """Call the LLM without tools bound to provide a final summary answer when iteration limit is reached."""
    model = get_chat_model()

    messages = list(state.get("messages", []))
    has_system = any(isinstance(m, SystemMessage) for m in messages)
    if not has_system:
        messages.insert(0, SystemMessage(content=TRAVEL_PROMPT))

    instruction = (
        "\n[System Note: The tool calling limit has been reached. Please provide a final response summarizing "
        "what you have found so far, or politely state that you cannot complete the operation or retrieve "
        "further information at this time.]"
    )
    messages.append(HumanMessage(content=instruction))

    response = await model.ainvoke(messages, config=config)
    return {"messages": [response]}

# Create the prebuilt ToolNode
prebuilt_tool_node = ToolNode(get_tools())

async def custom_tool_node(state: AgentState, config: RunnableConfig) -> dict:
    """Execute prebuilt ToolNode and increment iteration count by 1."""
    result = await prebuilt_tool_node.ainvoke(state, config=config)
    current_iter = state.get("iteration_count") or 0
    result["iteration_count"] = current_iter + 1
    return result
