from langchain_core.messages import SystemMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from agent.agents.chat_agent import get_chat_model
from agent.tools.registry import get_checkout_tools
from agent.graph.state import AgentState

CHECKOUT_PROMPT = (
    "You are the Checkout Orchestrator for the Flight Booking System. "
    "Your ONLY job is to help the user complete the checkout process for a selected flight offer. "
    "Use the signal_checkout_intent tool to indicate which flight the user wants to book, using the index from their search results (1-indexed). "
    "Do not attempt to search for new flights or perform other actions. "
    "If you need more information to identify the flight, ask the user clearly. "
    "Be concise and confirm when the checkout process is starting."
)

async def checkout_orchestrator_node(state: AgentState, config: RunnableConfig) -> dict:
    """Call the LLM with Checkout Orchestrator tools bound."""
    model = get_chat_model()
    tools = get_checkout_tools()
    model_with_tools = model.bind_tools(tools)

    messages = list(state.get("messages", []))
    has_system = any(isinstance(m, SystemMessage) for m in messages)
    if not has_system:
        messages.insert(0, SystemMessage(content=CHECKOUT_PROMPT))


    response = await model_with_tools.ainvoke(messages, config=config)
    return {"messages": [response]}
