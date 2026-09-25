from .command import ChatTurnCommand
from .events import (
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
)
from .resolver import (
    HandoffResolution,
    ToolResolution,
    ToolResultResolver,
)
from .runner import ChatTurnRunner

__all__ = [
    "ActionHandoffEvent",
    "ActionHandoffPayload",
    "ActionRequiredEvent",
    "ActionRequiredPayload",
    "ChatTurnCommand",
    "ChatTurnEvent",
    "ChatTurnRunner",
    "DoneEvent",
    "DonePayload",
    "ErrorEvent",
    "ErrorPayload",
    "FlightResultsEvent",
    "FlightResultsPayload",
    "HandoffResolution",
    "TokenEvent",
    "TokenPayload",
    "ToolCallEvent",
    "ToolCallPayload",
    "ToolResolution",
    "ToolResultEvent",
    "ToolResultPayload",
    "ToolResultResolver",
    "format_sse",
]


def __getattr__(name: str):
    if name == "format_sse":
        from agent.streaming.sse import format_sse

        return format_sse
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
