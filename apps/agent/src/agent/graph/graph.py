from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver

from agent.graph.state import AgentState
from agent.graph.nodes import agent_node, final_answer_node, custom_tool_node
from agent.graph.router import should_continue

# 1. Define the workflow graph
workflow = StateGraph(AgentState)

# 2. Add nodes
workflow.add_node("agent", agent_node)
workflow.add_node("tools", custom_tool_node)
workflow.add_node("final_answer", final_answer_node)

# 3. Add edges
workflow.add_edge(START, "agent")

workflow.add_conditional_edges(
    "agent",
    should_continue,
    {
        "tools": "tools",
        "final_answer": "final_answer",
        END: END,
    }
)

workflow.add_edge("tools", "agent")
workflow.add_edge("final_answer", END)

# 4. Initialize checkpointer
memory = MemorySaver()

# 5. Compile the graph
graph = workflow.compile(checkpointer=memory)
