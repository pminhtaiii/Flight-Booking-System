from typing import Dict, Any, List
from langchain_core.tools import BaseTool, tool
from agent.tools.search_flights import search_flights
from agent.tools.get_preferences import get_user_preferences
from agent.tools.list_bookings import list_user_bookings
from agent.tools.check_booking_readiness import check_booking_readiness

@tool("book_flight")
async def book_flight(flight_number: str, date: str) -> str:
    """Book a flight with a flight number and date. This action requires confirmation."""
    return f"Flight {flight_number} on {date} has been successfully booked."

TOOL_REGISTRY: Dict[str, Dict[str, Any]] = {
    "search_flights": {
        "tool": search_flights,
        "requires_confirmation": False,
    },
    "get_user_preferences": {
        "tool": get_user_preferences,
        "requires_confirmation": False,
    },
    "list_user_bookings": {
        "tool": list_user_bookings,
        "requires_confirmation": False,
    },
    "check_booking_readiness": {
        "tool": check_booking_readiness,
        "requires_confirmation": False,
    },
    "book_flight": {
        "tool": book_flight,
        "requires_confirmation": True,
    },
}

def get_tools() -> List[BaseTool]:
    """Get a list of all registered tool instances."""
    return [info["tool"] for info in TOOL_REGISTRY.values()]

def get_tool_by_name(name: str) -> BaseTool:
    """Retrieve a registered tool instance by its name."""
    if name not in TOOL_REGISTRY:
        raise ValueError(f"Tool '{name}' is not registered.")
    return TOOL_REGISTRY[name]["tool"]

def requires_confirmation(name: str) -> bool:
    """Check if a tool requires confirmation before execution."""
    if name not in TOOL_REGISTRY:
        return False
    return TOOL_REGISTRY[name]["requires_confirmation"]
