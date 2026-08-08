import json
from langchain_core.tools import tool
from typing import Annotated
from langgraph.prebuilt import InjectedState

@tool
def signal_checkout_intent(
    offer_index: int,
    state: Annotated[dict, InjectedState]
) -> str:
    """Signal that the user wants to checkout a specific flight offer from the latest search results.
    Provide the index of the flight (1-indexed)."""
    
    snapshot = state.get("trusted_snapshot")
    if not snapshot:
        return "No search results available. Please perform a search first."
        
    results = snapshot.get("results", [])
    if offer_index < 1 or offer_index > len(results):
        return f"Invalid offer index. Must be between 1 and {len(results)}."
        
    return json.dumps({
        "signal": {
            "intent": "checkout",
            "offer_index": offer_index
        }
    })
