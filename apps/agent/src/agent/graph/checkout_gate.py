from typing import Dict

from agent.config import get_settings
from agent.graph.state import AgentState
from agent.models.requests import RouteDecision


def evaluate_checkout_gate(state: AgentState, decision: RouteDecision) -> Dict[str, str]:
    """
    Evaluates the checkout gate criteria.
    Requires: intent=CHECKOUT, confidence >= ROUTER_CONFIDENCE_THRESHOLD,
    isCommitment=True, snapshot exists, and selectionIndex is resolvable against snapshot.
    Returns the target route and disambiguation flag.
    """
    settings = get_settings()

    if decision.intent == "GENERAL":
        return {"route": "general", "disambiguation": "none"}
    elif decision.intent == "SEARCH" or decision.intent == "BOOKING_INQUIRY":
        return {"route": "travel", "disambiguation": "none"}

    if decision.intent == "CHECKOUT":
        # Check criteria
        confidence_ok = decision.confidence >= settings.ROUTER_CONFIDENCE_THRESHOLD
        commitment_ok = decision.isCommitment
        snapshot_ok = state.get("trusted_snapshot") is not None

        index_ok = False
        if snapshot_ok and decision.selectionIndex is not None:
            results = state["trusted_snapshot"].get("results", [])
            if 1 <= decision.selectionIndex <= len(results):
                index_ok = True

        if confidence_ok and commitment_ok and snapshot_ok and index_ok:
            return {"route": "checkout", "disambiguation": "none"}
        else:
            return {"route": "travel", "disambiguation": "possible_checkout"}

    # Default fallback
    return {"route": "travel", "disambiguation": "none"}
