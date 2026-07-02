from langchain_core.messages import SystemMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.prebuilt import ToolNode

from agent.agents.chat_agent import get_chat_model
from agent.tools.registry import get_tools
from agent.graph.state import AgentState

CLOSED_WORLD_SYSTEM_PROMPT = (
    "You are a helpful travel assistant for the Flight Booking System. "
    "Help the user plan their travel, search for flights, and answer questions. "
    "Be concise, professional, and friendly.\n\n"
    "CRITICAL RULES:\n"
    "1. You have access to tools: 'search_flights', 'get_user_preferences', and 'list_user_bookings'.\n"
    "2. You MUST use only the information returned by these tools. DO NOT guess, fabricate, or assume any details "
    "not explicitly provided by a tool (e.g. cancellation/refund policies, change policies, airline rules, etc.).\n"
    "3. If the user asks about details or actions outside of the tools' data, or if you cannot find the information, "
    "you must clearly and politely state that the information is unavailable or that you cannot help with that request."
)

async def agent_node(state: AgentState, config: RunnableConfig) -> dict:
    """Call the LLM with registered tools bound and closed-world prompt."""
    model = get_chat_model()
    tools = get_tools()
    model_with_tools = model.bind_tools(tools)

    messages = list(state.get("messages", []))
    has_system = any(isinstance(m, SystemMessage) for m in messages)
    if not has_system:
        messages.insert(0, SystemMessage(content=CLOSED_WORLD_SYSTEM_PROMPT))

    response = await model_with_tools.ainvoke(messages, config=config)
    
    pending = None
    tool_calls = getattr(response, "tool_calls", None)
    if tool_calls:
        from agent.tools.registry import requires_confirmation
        for tc in tool_calls:
            if requires_confirmation(tc["name"]):
                pending = {
                    "name": tc["name"],
                    "args": tc["args"],
                    "id": tc["id"],
                    "confirmed": None
                }
                break

    ret = {"messages": [response]}
    if pending:
        ret["pending_confirmation"] = pending
    return ret

async def final_answer_node(state: AgentState, config: RunnableConfig) -> dict:
    """Call the LLM without tools bound to provide a final summary answer when iteration limit is reached."""
    model = get_chat_model()

    messages = list(state.get("messages", []))
    has_system = any(isinstance(m, SystemMessage) for m in messages)
    if not has_system:
        messages.insert(0, SystemMessage(content=CLOSED_WORLD_SYSTEM_PROMPT))

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
    result["pending_confirmation"] = None
    return result


async def confirm_node(state: AgentState, config: RunnableConfig) -> dict:
    """Handle confirmation gate. If aborted, append a cancellation ToolMessage."""
    pending = state.get("pending_confirmation")
    if not pending:
        return {}

    confirmed = pending.get("confirmed")
    if confirmed is False:
        tool_call_id = pending.get("id")
        tool_name = pending.get("name")
        cancellation_msg = ToolMessage(
            content=f"Booking for tool '{tool_name}' was aborted/cancelled by the user.",
            tool_call_id=tool_call_id,
            name=tool_name
        )
        return {
            "messages": [cancellation_msg],
            "pending_confirmation": None
        }

    return {}
