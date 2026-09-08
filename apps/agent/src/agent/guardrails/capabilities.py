"""Pure, fail-closed sealing of per-turn tool authority."""

from typing import Any, Mapping

from agent.guardrails.base import TurnCapabilities
from agent.models.requests import RouteDecision

TRAVEL_TOOL_NAMES = (
    "search_flights",
    "get_user_preferences",
    "list_user_booking_summaries",
    "get_booking_detail",
    "check_booking_readiness",
)
CHECKOUT_TOOL_NAMES = ("signal_checkout_intent",)


def seal_turn_capabilities(
    decision: RouteDecision | None,
    *,
    gate_result: Mapping[str, Any] | None = None,
    multi_agent: bool = True,
    provenance: str = "trusted_router",
) -> TurnCapabilities:
    """Derive immutable authority only from a trusted router result and deterministic gate."""
    if provenance != "trusted_router":
        return TurnCapabilities(
            intent="UNKNOWN", provenance="untrusted_provenance", sealed_tools=()
        )
    if not multi_agent:
        return TurnCapabilities(
            intent="SEARCH",
            provenance="trusted_router_single_agent",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
    if not isinstance(decision, RouteDecision):
        return TurnCapabilities(intent="UNKNOWN", provenance="router_failure", sealed_tools=())

    route = gate_result.get("route") if isinstance(gate_result, Mapping) else None
    if decision.intent == "GENERAL" and route == "general":
        return TurnCapabilities(intent="GENERAL", provenance=provenance, sealed_tools=())
    if decision.intent in {"SEARCH", "BOOKING_INQUIRY"} and route == "travel":
        suffix = "_low_confidence" if decision.confidence < 0.6 else ""
        return TurnCapabilities(
            intent=decision.intent,
            provenance=f"{provenance}{suffix}",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
    if decision.intent == "CHECKOUT" and route == "checkout":
        return TurnCapabilities(
            intent="CHECKOUT", provenance=provenance, sealed_tools=CHECKOUT_TOOL_NAMES
        )
    if decision.intent == "CHECKOUT" and route == "travel":
        return TurnCapabilities(
            intent="SEARCH",
            provenance=f"{provenance}_checkout_downgrade",
            sealed_tools=TRAVEL_TOOL_NAMES,
        )
    return TurnCapabilities(intent="UNKNOWN", provenance="router_failure", sealed_tools=())


seal_capabilities = seal_turn_capabilities
