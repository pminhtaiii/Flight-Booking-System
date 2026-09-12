from langchain_core.messages import AIMessage, SystemMessage
from langchain_core.runnables import RunnableConfig

from agent.agents.chat_agent import get_chat_model
from agent.graph.state import AgentState
from agent.guardrails.output_pipeline import approved_model_content, payload_free_config

GENERAL_PROMPT = (
    "You are a helpful travel assistant for the Flight Booking System. "
    "Help the user with general inquiries and guide them on how to search for flights, "
    "check bookings, or update preferences. You do not have access to real-time tools here, "
    "so politely explain that you can help with those tasks if they ask directly."
)

SAFE_ROUTER_CLARIFICATION = (
    "I couldn't safely determine what you need. Please ask me to search flights, "
    "review a booking, or explain a travel question."
)


async def general_agent_node(state: AgentState, config: RunnableConfig) -> dict:
    """Call the LLM without tools bound."""
    if state.get("safe_clarification") == SAFE_ROUTER_CLARIFICATION:
        return {"messages": [AIMessage(content=SAFE_ROUTER_CLARIFICATION)]}

    model = get_chat_model()

    messages = list(state.get("messages", []))
    has_system = any(isinstance(m, SystemMessage) for m in messages)
    if not has_system:
        messages.insert(0, SystemMessage(content=GENERAL_PROMPT))

    response = await model.ainvoke(messages, config=payload_free_config(config))
    return (
        {"messages": [response]}
        if await approved_model_content(response.content, config)
        else {"messages": []}
    )
