from datetime import datetime, timezone
from typing import Any, Dict

from agent.config import get_settings
from agent.graph.state import AgentState
from agent.models.requests import RouteDecision
from agent.trusted_search_snapshot import (
    TrustedSearchSnapshot,
    TrustedSearchSnapshotLifecycle,
)


def _is_snapshot_active(snapshot: Any) -> bool:
    """Check if snapshot is present and unexpired."""
    if snapshot is None:
        return False

    expires_at_raw = None
    if isinstance(snapshot, TrustedSearchSnapshot):
        expires_at_raw = snapshot.expiresAt
    elif isinstance(snapshot, dict):
        expires_at_raw = snapshot.get("expiresAt") or snapshot.get("snapshotExpiresAt")
    else:
        return False

    if expires_at_raw:
        try:
            if isinstance(expires_at_raw, datetime):
                exp_dt = expires_at_raw
            elif isinstance(expires_at_raw, str):
                exp_dt = datetime.fromisoformat(expires_at_raw.replace("Z", "+00:00"))
            else:
                return False

            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)

            if exp_dt <= datetime.now(timezone.utc):
                return False
        except (ValueError, TypeError):
            return False

    return True


def evaluate_checkout_gate(state: AgentState, decision: RouteDecision) -> Dict[str, str]:
    """
    Evaluates the checkout gate criteria.
    Requires: intent=CHECKOUT, confidence >= ROUTER_CONFIDENCE_THRESHOLD,
    isCommitment=True, snapshot exists and is unexpired, and selectionIndex is resolvable against snapshot.
    Returns the target route and disambiguation flag.
    """
    settings = get_settings()

    if decision.intent == "GENERAL":
        return {"route": "general", "disambiguation": "none"}
    elif decision.intent in ("SEARCH", "BOOKING_INQUIRY"):
        return {"route": "travel", "disambiguation": "none"}

    if decision.intent == "CHECKOUT":
        norm_state = TrustedSearchSnapshotLifecycle.normalize_graph_state(
            dict(state) if state else {}
        )
        confidence_ok = decision.confidence >= settings.ROUTER_CONFIDENCE_THRESHOLD
        commitment_ok = decision.isCommitment

        snapshot = norm_state.get("trusted_snapshot")
        snapshot_ok = _is_snapshot_active(snapshot)

        results = []
        if snapshot_ok:
            if isinstance(snapshot, TrustedSearchSnapshot):
                results = snapshot.results
            elif isinstance(snapshot, dict):
                results = snapshot.get("results") or snapshot.get("offers") or []

        index_ok = False
        if (
            snapshot_ok
            and isinstance(decision.selectionIndex, int)
            and not isinstance(decision.selectionIndex, bool)
            and isinstance(results, list)
            and 1 <= decision.selectionIndex <= len(results)
        ):
            index_ok = True

        if confidence_ok and commitment_ok and snapshot_ok and index_ok:
            return {"route": "checkout", "disambiguation": "none"}
        else:
            return {"route": "travel", "disambiguation": "possible_checkout"}

    # Default fallback
    return {"route": "travel", "disambiguation": "none"}
