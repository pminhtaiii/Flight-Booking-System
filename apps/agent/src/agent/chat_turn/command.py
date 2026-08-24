from typing import Any, Dict, Optional

from pydantic import BaseModel, ConfigDict


class ChatTurnCommand(BaseModel):
    """
    Immutable parameters encapsulating a single user chat turn.
    Decouples execution parameters from transport concerns.
    """

    model_config = ConfigDict(extra="forbid")

    user_id: str
    session_id: Optional[str] = None
    message: Optional[str] = None
    action_required: bool = False
    action_type: Optional[str] = None
    action_payload: Optional[Dict[str, Any]] = None
    token: str
    trace_id: Optional[str] = None
    correlation_id: Optional[str] = None
