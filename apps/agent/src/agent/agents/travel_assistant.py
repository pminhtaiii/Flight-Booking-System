from langchain_core.messages import SystemMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from agent.agents.chat_agent import get_chat_model
from agent.tools.registry import get_travel_tools
from agent.graph.state import AgentState

TRAVEL_PROMPT = (
    "You are a helpful travel assistant for the Flight Booking System. "
    "Help the user plan their travel, search for flights, and answer questions. "
    "Be concise, professional, and friendly.\n\n"
    "CRITICAL RULES:\n"
    "1. You have access to travel tools.\n"
    "2. You MUST use only the information returned by these tools. DO NOT guess, fabricate, or assume any details "
    "not explicitly provided by a tool.\n"
    "3. Two-Tier Booking Information Disclosure:\n"
    "   - For general booking questions or listing user bookings, call `list_user_booking_summaries`.\n"
    "   - For specific booking details (flight numbers, baggage allowance, cancellation/change policies), "
    "call `get_booking_detail` with the specific opaque reference (`bkref_...`).\n"
    "   - Never fabricate PNRs, internal database IDs, or financial amounts.\n"
    "4. Readiness is determined by the server. Passenger PII must never be collected or requested in chat.\n"
    "5. If the user asks about details or actions outside of the tools' data, or if you cannot find the information, "
    "you must clearly and politely state that the information is unavailable or that you cannot help with that request."
)

async def travel_assistant_node(state: AgentState, config: RunnableConfig) -> dict:
    """Call the LLM with Travel Assistant tools bound."""
    model = get_chat_model()
    tools = get_travel_tools()
    model_with_tools = model.bind_tools(tools)

    messages = list(state.get("messages", []))
    has_system = any(isinstance(m, SystemMessage) for m in messages)
    if not has_system:
        messages.insert(0, SystemMessage(content=TRAVEL_PROMPT))

    disambiguation = state.get("disambiguation", "none")
    if disambiguation == "possible_checkout":
        messages.append(HumanMessage(
            content="[System Note: The user's message looks like they might want to checkout or book, "
                    "but some information is missing or unclear (e.g. they didn't specify which option, "
                    "or we lack a recent search). Please ask them to clarify which flight they want to book.]"
        ))

    response = await model_with_tools.ainvoke(messages, config=config)
    return {"messages": [response]}
