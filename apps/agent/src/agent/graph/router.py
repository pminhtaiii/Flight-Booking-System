import logging

from langgraph.graph import END

from agent.agents.chat_agent import get_chat_model
from agent.config import get_settings
from agent.graph.state import AgentState
from agent.guardrails.output_pipeline import payload_free_config
from agent.models.requests import RouteDecision
from agent.observability.chat_observability import ChatTelemetry

logger = logging.getLogger(__name__)
chat_telemetry = ChatTelemetry(logger)


async def invoke_router(state: AgentState) -> RouteDecision:
    """
    Invoke the Intent Router model to classify the user's latest message.
    Returns a strict RouteDecision. Missing input and malformed output are surfaced
    so the graph can fail closed; low-confidence non-checkout input is routed to
    Travel Assistant while retaining its low-confidence provenance.
    """
    messages = state.get("messages", [])
    if not messages:
        chat_telemetry.emit_safely(
            "router_decision",
            status="fallback",
            fields={
                "intent": "UNKNOWN",
                "confidence_bucket": "unknown",
                "outcome": "empty_state",
            },
        )
        raise RuntimeError("Router input rejected")

    last_message = messages[-1]

    # We only route HumanMessages.
    if last_message.type != "human":
        chat_telemetry.emit_safely(
            "router_decision",
            status="fallback",
            fields={
                "intent": "UNKNOWN",
                "confidence_bucket": "unknown",
                "outcome": "non_human_message",
            },
        )
        raise RuntimeError("Router input rejected")

    model = get_chat_model()
    router_model = model.with_structured_output(RouteDecision)

    try:
        decision = await router_model.ainvoke(
            [
                {
                    "role": "system",
                    "content": "You are an intent classifier. Classify the user's intent into GENERAL, SEARCH, BOOKING_INQUIRY, or CHECKOUT.",
                },
                {"role": "user", "content": last_message.content},
            ],
            config=payload_free_config(),
        )
    except Exception:
        logger.warning("router_output_rejected")
        chat_telemetry.emit_safely(
            "router_decision",
            status="fallback",
            fields={
                "intent": "UNKNOWN",
                "confidence_bucket": "unknown",
                "outcome": "malformed_output",
            },
        )
        raise RuntimeError("Router output rejected") from None

    # Check for low confidence fallback
    # The requirement says: "Given low confidence for a non-checkout message... fallback to Travel Assistant"
    # We will use confidence < 0.6 as low confidence threshold, since not specified.
    if decision.intent != "CHECKOUT" and decision.confidence < 0.6:
        logger.info(
            "Low confidence router decision for non-checkout message, falling back to SEARCH"
        )
        fallback = RouteDecision(
            intent="SEARCH",
            confidence=decision.confidence,
            isCommitment=False,
        )
        chat_telemetry.emit_safely(
            "router_decision",
            status="fallback",
            fields={
                "intent": fallback.intent,
                "confidence_bucket": "low",
                "outcome": "low_confidence",
            },
        )
        return fallback

    chat_telemetry.emit_safely(
        "router_decision",
        status="classified",
        fields={
            "intent": decision.intent,
            "confidence_bucket": "high" if decision.confidence >= 0.8 else "medium",
            "outcome": "classified",
        },
    )
    return decision


def should_continue(state: AgentState) -> str:
    """Conditional router to determine next step in the graph."""
    messages = state.get("messages", [])
    if not messages:
        return END

    last_message = messages[-1]
    # Check if the last message contains tool calls
    tool_calls = getattr(last_message, "tool_calls", None)
    if not tool_calls:
        return END

    settings = get_settings()
    max_iterations = getattr(settings, "AGENT_MAX_ITERATIONS", 5)
    current_iterations = state.get("iteration_count") or 0

    if current_iterations >= max_iterations:
        return "final_answer"

    return "tools"


def route_after_tools(state: AgentState) -> str:
    """Determine the next step after tools are executed."""
    return "agent"
