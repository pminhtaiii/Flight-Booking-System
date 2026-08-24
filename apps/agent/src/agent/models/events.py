from typing import Literal

from pydantic import BaseModel, ConfigDict

from agent.chat_turn.events import (
    ActionHandoffEvent,
    ActionHandoffPayload,
    ActionRequiredEvent,
    ActionRequiredPayload,
    ChatTurnEvent,
    DoneEvent,
    DonePayload,
    ErrorEvent,
    ErrorPayload,
    FlightResultsEvent,
    FlightResultsPayload,
    TokenEvent,
    TokenPayload,
    ToolCallEvent,
    ToolCallPayload,
    ToolResultEvent,
    ToolResultPayload,
    format_sse,
)


class BaseSSEEvent(BaseModel):
    version: Literal[1]
    action: str

    model_config = ConfigDict(extra="forbid")


class DisplayInfo(BaseModel):
    airline: str
    origin: str
    destination: str
    departureAt: str
    arrivalAt: str
    price: str
    currency: str

    model_config = ConfigDict(extra="forbid")


class HandoffEvent(BaseSSEEvent):
    action: Literal["begin_checkout"]
    handoffToken: str
    expiresAt: str
    display: DisplayInfo

    model_config = ConfigDict(extra="forbid")


class LegacyActionRequiredEvent(BaseSSEEvent):
    action: Literal["action_required"]
    message: str

    model_config = ConfigDict(extra="forbid")


class ChatMessageEvent(BaseSSEEvent):
    action: Literal["chat_message"]
    content: str
    role: Literal["assistant", "system", "user"]

    model_config = ConfigDict(extra="forbid")


__all__ = [
    "ActionHandoffEvent",
    "ActionHandoffPayload",
    "ActionRequiredEvent",
    "ActionRequiredPayload",
    "BaseSSEEvent",
    "ChatMessageEvent",
    "ChatTurnEvent",
    "DisplayInfo",
    "DoneEvent",
    "DonePayload",
    "ErrorEvent",
    "ErrorPayload",
    "FlightResultsEvent",
    "FlightResultsPayload",
    "HandoffEvent",
    "LegacyActionRequiredEvent",
    "TokenEvent",
    "TokenPayload",
    "ToolCallEvent",
    "ToolCallPayload",
    "ToolResultEvent",
    "ToolResultPayload",
    "format_sse",
]
