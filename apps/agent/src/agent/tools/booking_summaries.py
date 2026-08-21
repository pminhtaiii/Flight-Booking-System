import logging

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from agent.tools.base import get_nestjs_client

logger = logging.getLogger(__name__)

AIRLINE_MAP = {
    "VN": "Vietnam Airlines",
    "NH": "ANA",
    "JL": "Japan Airlines",
    "SQ": "Singapore Airlines",
}


@tool("list_user_booking_summaries")
async def list_user_booking_summaries(config: RunnableConfig) -> str:
    """Retrieve summaries of the current user's flight bookings.
    Returns opaque booking references, airlines, routes, flight times, and status.
    Does not expose detailed flight numbers, baggage, passenger PII, or financial data.
    """
    try:
        client = get_nestjs_client(config)
    except Exception as e:
        logger.error(f"Failed to get nestjs client: {e}")
        return "I couldn't retrieve your booking summaries right now. Please try again in a moment."

    try:
        response = await client.get_gateway_user_booking_summaries()
        bookings = response.get("bookings", response.get("summaries", []))
        if not bookings:
            return "You don't have any bookings at the moment."

        result = [
            "Your booking summaries:",
            "To view details like flight number or baggage allowance for a specific booking, ask for that booking reference.",
            "",
        ]

        for b in bookings:
            ref = b.get("bookingReference") or b.get("agentReference") or "Unknown"
            status = b.get("status", "Unknown")
            airline_code = b.get("airline", "Unknown")
            airline_name = AIRLINE_MAP.get(airline_code, airline_code)
            airline_display = (
                f"{airline_name} ({airline_code})" if airline_code in AIRLINE_MAP else airline_code
            )
            origin = b.get("origin", "Unknown")
            dest = b.get("destination", "Unknown")
            dept = b.get("departureTime") or b.get("departureAt") or "Unknown"
            arr = b.get("arrivalTime") or b.get("arrivalAt") or "Unknown"
            duration = b.get("durationMinutes", 0)
            stops = b.get("stops", b.get("stopCount", 0))
            stops_str = (
                "Direct (0 stops)"
                if stops == 0
                else f"{stops} stop"
                if stops == 1
                else f"{stops} stops"
            )

            result.append(
                f"- [{status}] Reference: {ref} | Airline: {airline_display} | Route: {origin} -> {dest} | "
                f"Departure: {dept} | Arrival: {arr} | Duration: {duration} mins | Stops: {stops_str}"
            )

        return "\n".join(result)
    except Exception as e:
        logger.error(f"Failed to fetch booking summaries: {e}")
        return "I couldn't retrieve your booking summaries right now. Please try again in a moment."
