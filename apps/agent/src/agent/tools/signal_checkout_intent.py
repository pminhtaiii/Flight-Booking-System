import json
from typing import Annotated, Optional

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState

from agent.trusted_search_snapshot import TrustedSearchSnapshotLifecycle


@tool
def signal_checkout_intent(
    offer_index: Optional[int] = None,
    selected_index: Optional[int] = None,
    state: Annotated[dict, InjectedState] = None,
) -> str:
    """Signal that the user wants to checkout a specific flight offer from the latest search results.
    Provide the index of the flight (1-indexed)."""
    idx = selected_index if selected_index is not None else offer_index

    # Strictly validate that idx is an integer and NOT a boolean
    if idx is None or isinstance(idx, bool) or not isinstance(idx, int) or idx < 1:
        return "Invalid offer index. Must be a positive integer (1..N)."

    if not state or not isinstance(state, dict):
        return "No search results available. Please perform a search first."

    normalized_state = TrustedSearchSnapshotLifecycle.normalize_graph_state(state)
    snapshot = normalized_state.get("trusted_snapshot")
    if not snapshot or not isinstance(snapshot, dict):
        return "No search results available. Please perform a search first."

    results = snapshot.get("results", [])
    if not isinstance(results, list) or len(results) == 0:
        return "No search results available. Please perform a search first."

    if idx > len(results):
        return f"Invalid offer index. Must be between 1 and {len(results)}."

    return json.dumps(
        {
            "signal": {
                "intent": "checkout",
                "offer_index": idx,
                "selected_index": idx,
            }
        }
    )
