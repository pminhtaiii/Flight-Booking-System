from langgraph.graph import StateGraph, START, END

from agent.graph.state import AgentState
from agent.graph.router import invoke_router
from agent.graph.checkout_gate import evaluate_checkout_gate
from agent.agents.general_agent import general_agent_node
from agent.agents.travel_assistant import travel_assistant_node
from agent.agents.checkout_orchestrator import checkout_orchestrator_node
from agent.graph.nodes import custom_tool_node, final_answer_node
from agent.config import get_settings

async def router_node(state: AgentState, config) -> dict:
    decision = await invoke_router(state)
    gate_result = evaluate_checkout_gate(state, decision)
    return gate_result # Updates 'route' and 'disambiguation' in AgentState

def route_after_router(state: AgentState) -> str:
    route = state.get("route", "general")
    if route == "travel":
        return "travel"
    elif route == "checkout":
        return "checkout"
    return "general"

def should_continue(state: AgentState) -> str:
    messages = state.get("messages", [])
    if not messages:
        return END

    last_message = messages[-1]
    if not getattr(last_message, "tool_calls", None):
        return END

    settings = get_settings()
    max_iterations = getattr(settings, "AGENT_MAX_ITERATIONS", 5)
    current_iterations = state.get("iteration_count", 0)

    if current_iterations >= max_iterations:
        return "final_answer"
    return "tools"

def route_after_tools(state: AgentState) -> str:
    signal = state.get("signal")
    if signal and signal.get("intent") == "checkout":
        return "validate_handoff"
    # After tools, always return to the travel assistant (the only one with tools)
    return "travel"

from agent.graph.nodes import validate_handoff, create_handoff_token

workflow = StateGraph(AgentState)

workflow.add_node("router", router_node)
workflow.add_node("general", general_agent_node)
workflow.add_node("travel", travel_assistant_node)
workflow.add_node("checkout", checkout_orchestrator_node)
workflow.add_node("tools", custom_tool_node)
workflow.add_node("final_answer", final_answer_node)
workflow.add_node("validate_handoff", validate_handoff)
workflow.add_node("create_handoff_token", create_handoff_token)

workflow.add_edge(START, "router")
workflow.add_conditional_edges("router", route_after_router)

workflow.add_edge("general", END)

workflow.add_conditional_edges(
    "checkout",
    should_continue,
    {
        "tools": "tools",
        "final_answer": "final_answer",
        END: END,
    }
)

workflow.add_conditional_edges(
    "travel",
    should_continue,
    {
        "tools": "tools",
        "final_answer": "final_answer",
        END: END,
    }
)

workflow.add_conditional_edges(
    "tools",
    route_after_tools,
    {
        "travel": "travel",
        "validate_handoff": "validate_handoff",
        END: END,
    },
)

workflow.add_edge("validate_handoff", "create_handoff_token")
workflow.add_edge("create_handoff_token", END)
workflow.add_edge("final_answer", END)

graph = workflow.compile()
