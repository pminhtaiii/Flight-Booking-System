from typing import Annotated, List, Literal, Optional, TypedDict

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages

from agent.guardrails.base import TurnCapabilities


class AgentState(TypedDict, total=False):
    messages: Annotated[List[BaseMessage], add_messages]
    iteration_count: int
    route: Literal["general", "travel", "checkout"]
    disambiguation: Literal["none", "possible_checkout"]
    snapshot: Optional[dict]
    trusted_snapshot: Optional[dict]
    signal: Optional[dict]
    action: Optional[dict]
    pending_confirmation: Optional[dict]
    handoff_required: bool
    turn_capabilities: TurnCapabilities
    safe_clarification: str
    tool_blocked: bool
    tool_block_response_key: str
