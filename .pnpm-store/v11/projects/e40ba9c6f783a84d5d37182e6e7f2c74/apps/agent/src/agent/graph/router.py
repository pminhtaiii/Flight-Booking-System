from langgraph.graph import END
from agent.config import get_settings
from agent.graph.state import AgentState

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

    # Handle confirmation gate check
    pending = state.get("pending_confirmation")
    if pending and pending.get("confirmed") is not True:
        return "confirm"

    settings = get_settings()
    max_iterations = getattr(settings, "AGENT_MAX_ITERATIONS", 5)
    current_iterations = state.get("iteration_count") or 0

    if current_iterations >= max_iterations:
        return "final_answer"

    return "tools"


def route_confirm(state: AgentState) -> str:
    """Route from confirm node based on confirmation status."""
    pending = state.get("pending_confirmation")
    if pending and pending.get("confirmed") is True:
        return "tools"
    return "agent"
