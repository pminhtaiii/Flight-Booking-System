from langchain_core.messages import SystemMessage
from langchain_core.runnables import RunnableConfig
from agent.agents.chat_agent import get_chat_model
from agent.graph.state import AgentState

GENERAL_PROMPT = (
    "You are a helpful travel assistant for the Flight Booking System. "
    "Help the user with general inquiries and guide them on how to search for flights, "
    "check bookings, or update preferences. You do not have access to real-time tools here, "
    "so politely explain that you can help with those tasks if they ask directly."
)

async def general_agent_node(state: AgentState, config: RunnableConfig) -> dict:
    """Call the LLM without tools bound."""
    model = get_chat_model()
    
    messages = list(state.get("messages", []))
    has_system = any(isinstance(m, SystemMessage) for m in messages)
    if not has_system:
        messages.insert(0, SystemMessage(content=GENERAL_PROMPT))
        
    response = await model.ainvoke(messages, config=config)
    return {"messages": [response]}
