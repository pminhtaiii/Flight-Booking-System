from langgraph.types import Command
from langchain_core.tools import tool
from agent.graph.state import AgentState

@tool
def signal_checkout_intent(selection_index: int) -> Command:
    """Signal that the user wants to checkout a specific flight offer from the latest search results.
    Provide the index of the flight (1-indexed)."""
    return Command(
        update={"action": {"action": "CHECKOUT", "selectionIndex": selection_index}},
        goto="__end__"
    )
