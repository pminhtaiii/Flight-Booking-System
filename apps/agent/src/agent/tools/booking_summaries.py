import logging

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from agent.guardrails.schemas.tools import (
    BookingSummariesToolInput,
    BookingSummariesToolResult,
    BookingSummariesUpstreamProjection,
    project_upstream,
)
from agent.tools.base import get_nestjs_client

logger = logging.getLogger(__name__)


def _narration(value: str) -> str:
    return BookingSummariesToolResult(narration=value).narration


AIRLINE_MAP = {
    "VN": "Vietnam Airlines",
    "NH": "ANA",
    "JL": "Japan Airlines",
    "SQ": "Singapore Airlines",
}


@tool("list_user_booking_summaries", args_schema=BookingSummariesToolInput)
async def list_user_booking_summaries(config: RunnableConfig) -> str:
    """Retrieve summaries of the current user's flight bookings.
    Returns opaque booking references, airlines, routes, flight times, and status.
    Does not expose detailed flight numbers, baggage, passenger PII, or financial data.
    """
    try:
        client = get_nestjs_client(config)
    except Exception:
        logger.error("list_user_booking_summaries_client_init_failed")
        return _narration(
            "I couldn't retrieve your booking summaries right now. Please try again in a moment."
        )

    try:
        response = await client.get_gateway_user_booking_summaries()
        projected = project_upstream(BookingSummariesUpstreamProjection, response)
        bookings = projected.bookings if projected.bookings is not None else projected.summaries
        if not bookings:
            return _narration("You don't have any bookings at the moment.")

        result = [
            "Your booking summaries:",
            "To view details like flight number or baggage allowance for a specific booking, ask for that booking reference.",
            "",
        ]

        for b in bookings:
            ref = b.bookingReference or b.agentReference or "Unknown"
            status = b.status or "Unknown"
            airline_code = b.airline or "Unknown"
            airline_name = AIRLINE_MAP.get(airline_code, airline_code)
            airline_display = (
                f"{airline_name} ({airline_code})" if airline_code in AIRLINE_MAP else airline_code
            )
            origin = b.origin or "Unknown"
            dest = b.destination or "Unknown"
            dept = b.departureTime or b.departureAt or "Unknown"
            arr = b.arrivalTime or b.arrivalAt or "Unknown"
            duration = b.durationMinutes
            stops = (
                b.stops if b.stops is not None else b.stopCount if b.stopCount is not None else 0
            )
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

        return _narration("\n".join(result))
    except Exception:
        logger.error("list_user_booking_summaries_failed")
        return _narration(
            "I couldn't retrieve your booking summaries right now. Please try again in a moment."
        )
