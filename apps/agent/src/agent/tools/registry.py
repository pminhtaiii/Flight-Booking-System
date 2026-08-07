from typing import List
from langchain_core.tools import BaseTool

from agent.tools.search_flights import search_flights
from agent.tools.get_preferences import get_user_preferences
from agent.tools.list_bookings import list_user_bookings
from agent.tools.check_booking_readiness import check_booking_readiness
from agent.tools.signal_checkout_intent import signal_checkout_intent

_GENERAL_TOOLS: tuple[BaseTool, ...] = ()

_TRAVEL_TOOLS: tuple[BaseTool, ...] = (
    search_flights,
    get_user_preferences,
    list_user_bookings,
    check_booking_readiness,
)

_CHECKOUT_TOOLS: tuple[BaseTool, ...] = (
    signal_checkout_intent,
)


def get_general_tools() -> tuple[BaseTool, ...]:
    return _GENERAL_TOOLS

def get_travel_tools() -> tuple[BaseTool, ...]:
    return _TRAVEL_TOOLS

def get_checkout_tools() -> tuple[BaseTool, ...]:
    return _CHECKOUT_TOOLS

def get_tools() -> List[BaseTool]:
    """Get a list of all registered tool instances."""
    all_tools = _GENERAL_TOOLS + _TRAVEL_TOOLS + _CHECKOUT_TOOLS
    seen = set()
    unique_tools = []
    for tool in all_tools:
        if tool.name not in seen:
            seen.add(tool.name)
            unique_tools.append(tool)
    return unique_tools

def get_tool_by_name(name: str) -> BaseTool:
    """Retrieve a registered tool instance by its name."""
    for tool in get_tools():
        if tool.name == name:
            return tool
    raise ValueError(f"Tool '{name}' is not registered.")

def requires_confirmation(name: str) -> bool:
    """Check if a tool requires confirmation before execution.
    In the new topology, no tools require confirmation via graph interruption.
    """
    return False
