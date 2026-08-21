from typing import TYPE_CHECKING

from agent.graph.state import AgentState

if TYPE_CHECKING:
    from agent.graph.graph import graph


def __getattr__(name: str):
    if name == "graph":
        from agent.graph.graph import graph

        return graph
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")


__all__ = ["graph", "AgentState"]
