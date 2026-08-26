from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


class TokenPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str


class ToolCallPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    inputs: Dict[str, Any]


class ToolResultPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    result: str


class FlightResultsPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: List[Dict[str, Any]]


class ActionHandoffPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = 1
    action: str = "begin_checkout"
    handoffToken: str
    expiresAt: str
    display: Dict[str, Any]


class ActionRequiredPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: str
    target: str
    scope: Optional[str] = None
    passengers: Optional[List[Dict[str, Any]]] = None


class DonePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messageId: Optional[str] = None
    sessionId: Optional[str] = None


class ErrorPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    message: str
    partialMessageId: Optional[str] = None
    error: Optional[str] = None


class TokenEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: Literal["token"] = "token"
    data: TokenPayload


class ToolCallEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: Literal["tool_call"] = "tool_call"
    data: ToolCallPayload


class ToolResultEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: Literal["tool_result"] = "tool_result"
    data: ToolResultPayload


class FlightResultsEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: Literal["flight_results"] = "flight_results"
    data: FlightResultsPayload


class ActionHandoffEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: Literal["ACTION_HANDOFF"] = "ACTION_HANDOFF"
    data: ActionHandoffPayload


class ActionRequiredEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: Literal["ACTION_REQUIRED"] = "ACTION_REQUIRED"
    data: ActionRequiredPayload


class DoneEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: Literal["done"] = "done"
    data: DonePayload


class ErrorEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: Literal["error"] = "error"
    data: ErrorPayload


ChatTurnEvent = Annotated[
    Union[
        TokenEvent,
        ToolCallEvent,
        ToolResultEvent,
        FlightResultsEvent,
        ActionHandoffEvent,
        ActionRequiredEvent,
        DoneEvent,
        ErrorEvent,
    ],
    Field(discriminator="event"),
]


def format_sse(event: ChatTurnEvent) -> str:
    return f"event: {event.event}\ndata: {event.data.model_dump_json()}\n\n"


__all__ = [
    "ActionHandoffEvent",
    "ActionHandoffPayload",
    "ActionRequiredEvent",
    "ActionRequiredPayload",
    "ChatTurnEvent",
    "DoneEvent",
    "DonePayload",
    "ErrorEvent",
    "ErrorPayload",
    "FlightResultsEvent",
    "FlightResultsPayload",
    "TokenEvent",
    "TokenPayload",
    "ToolCallEvent",
    "ToolCallPayload",
    "ToolResultEvent",
    "ToolResultPayload",
    "format_sse",
]
