import logging
import httpx
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig
from agent.tools.base import get_nestjs_client

logger = logging.getLogger(__name__)

AIRLINE_MAP = {
    "VN": "Vietnam Airlines",
    "NH": "ANA",
    "JL": "Japan Airlines",
    "SQ": "Singapore Airlines",
}


@tool("get_booking_detail")
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
        return "Invalid booking reference format. Booking references start with 'bkref_'."

    try:
        client = get_nestjs_client(config)
    except Exception as e:
        logger.error(f"Failed to get nestjs client: {e}")
        return "I couldn't retrieve the booking details right now. Please try again in a moment."

    try:
        response = await client.get_gateway_booking_detail(booking_reference)

        if (
            response.get("error") == "BOOKING_REFERENCE_NOT_FOUND"
            or response.get("statusCode") == 404
            or "not found" in str(response.get("error", "")).lower()
        ):
            return f"Booking not found: I couldn't find a booking with reference '{booking_reference}'. Please verify the reference and try again."

        status = response.get("status", "Unknown")
        airline_code = response.get("airline", "Unknown")
        airline_name = AIRLINE_MAP.get(airline_code, airline_code)
        airline_display = f"{airline_name} ({airline_code})" if airline_code in AIRLINE_MAP else airline_code

        origin = response.get("origin", "Unknown")
        dest = response.get("destination", "Unknown")
        dept = response.get("departureTime") or response.get("departureAt") or "Unknown"
        arr = response.get("arrivalTime") or response.get("arrivalAt") or "Unknown"
        flight_num = response.get("flightNumber") or "Not specified"
        duration = response.get("durationMinutes", 0)
        stops = response.get("stops", response.get("stopCount", 0))
        stops_str = "Direct (0 stops)" if stops == 0 else f"{stops} stop" if stops == 1 else f"{stops} stops"

        baggage = response.get("baggageAllowance") or response.get("baggageSummary") or "Not specified"

        refundable_val = response.get("refundable")
        if refundable_val is True:
            refundable_str = "Yes (Refundable: True)"
        elif refundable_val is False:
            refundable_str = "No (Refundable: False)"
        else:
            refundable_str = "Not specified"

        changeable_val = response.get("changeable")
        if changeable_val is True:
            changeable_str = "Yes (Changeable: True)"
        elif changeable_val is False:
            changeable_str = "No (Changeable: False)"
        else:
            changeable_str = "Not specified"

        ref = response.get("bookingReference") or booking_reference

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
        return result

    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return f"Booking not found: I couldn't find a booking with reference '{booking_reference}'. Please verify the reference and try again."
        logger.error(f"HTTP error fetching booking detail for {booking_reference}: {exc}")
        return "I couldn't retrieve the booking details right now. Please try again in a moment."
    except Exception as e:
        logger.error(f"Failed to fetch booking detail for {booking_reference}: {e}")
        return "I couldn't retrieve the booking details right now. Please try again in a moment."
