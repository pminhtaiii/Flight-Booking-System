from typing import Optional
from langchain_core.tools import tool
from agent.graph.state import AgentState

@tool
def signal_checkout_intent(selection_index: int) -> str:
    """Signal that the user wants to checkout a specific flight offer from the latest search results.
    Provide the index of the flight (1-indexed)."""
    # This tool does not return anything to the LLM that it needs to process.
    # It purely signals state for the graph to transition.
    return "Checkout intent signaled."
