import logging

import httpx
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from agent.guardrails.schemas.tools import (
    BookingDetailToolInput,
    BookingDetailToolResult,
    BookingDetailUpstreamProjection,
    project_upstream,
)
from agent.tools.base import get_nestjs_client

logger = logging.getLogger(__name__)


def _narration(value: str) -> str:
    return BookingDetailToolResult(narration=value).narration


AIRLINE_MAP = {
    "VN": "Vietnam Airlines",
    "NH": "ANA",
    "JL": "Japan Airlines",
    "SQ": "Singapore Airlines",
}


@tool("get_booking_detail", args_schema=BookingDetailToolInput)
async def get_booking_detail(booking_reference: str, config: RunnableConfig) -> str:
    """Get explicitly requested details for a specific flight booking.
    Requires the opaque booking_reference (starting with 'bkref_') obtained from list_user_booking_summaries.
    Returns flight number, baggage allowance, and change/cancellation policies.
    Does not expose financial data, passenger names, or PNRs.
    """
    if (
        not booking_reference
        or not isinstance(booking_reference, str)
        or not booking_reference.startswith("bkref_")
    ):
        return _narration(
            "Invalid booking reference format. Booking references start with 'bkref_'."
        )

    try:
        client = get_nestjs_client(config)
    except Exception:
        logger.error("get_booking_detail_client_init_failed")
        return _narration(
            "I couldn't retrieve the booking details right now. Please try again in a moment."
        )

    try:
        response = await client.get_gateway_booking_detail(booking_reference)

        if (
            response.get("error") == "BOOKING_REFERENCE_NOT_FOUND"
            or response.get("statusCode") == 404
            or "not found" in str(response.get("error", "")).lower()
        ):
            return _narration(
                f"Booking not found: I couldn't find a booking with reference '{booking_reference}'. Please verify the reference and try again."
            )

        response = project_upstream(BookingDetailUpstreamProjection, response)
        status = response.status or "Unknown"
        airline_code = response.airline or "Unknown"
        airline_name = AIRLINE_MAP.get(airline_code, airline_code)
        airline_display = (
            f"{airline_name} ({airline_code})" if airline_code in AIRLINE_MAP else airline_code
        )

        origin = response.origin or "Unknown"
        dest = response.destination or "Unknown"
        dept = response.departureTime or response.departureAt or "Unknown"
        arr = response.arrivalTime or response.arrivalAt or "Unknown"
        flight_num = response.flightNumber or "Not specified"
        duration = response.durationMinutes
        stops = (
            response.stops
            if response.stops is not None
            else response.stopCount
            if response.stopCount is not None
            else 0
        )
        stops_str = (
            "Direct (0 stops)"
            if stops == 0
            else f"{stops} stop"
            if stops == 1
            else f"{stops} stops"
        )

        baggage = response.baggageAllowance or response.baggageSummary or "Not specified"

        refundable_val = response.refundable
        if refundable_val is True:
            refundable_str = "Yes (Refundable: True)"
        elif refundable_val is False:
            refundable_str = "No (Refundable: False)"
        else:
            refundable_str = "Not specified"

        changeable_val = response.changeable
        if changeable_val is True:
            changeable_str = "Yes (Changeable: True)"
        elif changeable_val is False:
            changeable_str = "No (Changeable: False)"
        else:
            changeable_str = "Not specified"

        ref = response.bookingReference or booking_reference

        result = (
            f"Booking Details for {ref}:\n"
            f"- Status: {status}\n"
            f"- Airline: {airline_display}\n"
            f"- Flight Number: {flight_num}\n"
            f"- Route: {origin} -> {dest}\n"
            f"- Departure: {dept}\n"
            f"- Arrival: {arr}\n"
            f"- Duration: {duration} mins\n"
            f"- Stops: {stops_str}\n"
            f"- Baggage Allowance: {baggage}\n"
            f"- Refundable: {refundable_str}\n"
            f"- Changeable: {changeable_str}"
        )
        return _narration(result)

    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return _narration(
                f"Booking not found: I couldn't find a booking with reference '{booking_reference}'. Please verify the reference and try again."
            )
        logger.error("get_booking_detail_http_error")
        return _narration(
            "I couldn't retrieve the booking details right now. Please try again in a moment."
        )
    except Exception:
        logger.error("get_booking_detail_failed")
        return _narration(
            "I couldn't retrieve the booking details right now. Please try again in a moment."
        )
