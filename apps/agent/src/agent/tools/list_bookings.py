from datetime import datetime
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig
from agent.tools.base import get_nestjs_client

AIRLINE_MAP = {
    "VN": "Vietnam Airlines",
    "NH": "ANA",
    "JL": "Japan Airlines",
    "SQ": "Singapore Airlines",
}

@tool("list_user_bookings")
async def list_user_bookings(config: RunnableConfig) -> str:
    """Retrieve the current user's active flight bookings including flight details, dates, status, and pricing. Use this when the user asks about their bookings, upcoming flights, or trip details."""
    try:
        client = get_nestjs_client(config)
    except Exception:
        return "I couldn't retrieve your bookings right now. Please try again in a moment."

    try:
        data = await client.get_gateway_user_bookings()
    except Exception:
        return "I couldn't retrieve your bookings right now. Please try again in a moment."

    bookings = data.get("bookings", [])
    if not bookings:
        return "You don't have any active bookings at the moment."

    booking_blocks = []
    for idx, b in enumerate(bookings, 1):
        airline = b.get("airline") or ""
        airline_name = AIRLINE_MAP.get(airline, airline)
        flight_number = b.get("flightNumber") or ""
        status = b.get("status") or "UNKNOWN"
        origin = b.get("origin") or ""
        destination = b.get("destination") or ""

        # Parse departure time
        dep_time_str = ""
        date_str = ""
        dep_time = b.get("departureTime")
        if dep_time:
            try:
                # Replace 'Z' with +00:00 to support Python's isoformat parser
                dep_dt = datetime.fromisoformat(dep_time.replace("Z", "+00:00"))
                day = dep_dt.day
                month = dep_dt.strftime("%b")
                year = dep_dt.year
                date_str = f"{month} {day}, {year}"
                dep_time_str = dep_dt.strftime("%H:%M")
            except Exception:
                date_str = "Unknown Date"
                dep_time_str = "Unknown"

        # Parse arrival time
        arr_time_str = ""
        arr_time = b.get("arrivalTime")
        if arr_time:
            try:
                arr_dt = datetime.fromisoformat(arr_time.replace("Z", "+00:00"))
                arr_time_str = arr_dt.strftime("%H:%M")
            except Exception:
                arr_time_str = "Unknown"

        duration = b.get("duration") or 0
        hours = duration // 60
        mins = duration % 60
        duration_str = f"{hours}h {mins}m"

        stops = b.get("stops") or 0
        if stops == 0:
            stops_str = "Direct"
        elif stops == 1:
            stops_str = "1 stop"
        else:
            stops_str = f"{stops} stops"

        fare_class = b.get("fareClass") or "Economy"
        fare_class = fare_class.title()

        price = b.get("price") or 0.0
        currency = b.get("currency") or "USD"
        price_formatted = f"${price:,.2f}"

        passengers = b.get("passengers") or 1

        baggage = b.get("baggageAllowance") or "No checked baggage"
        if "checked" in baggage.lower() and "carry-on" not in baggage.lower():
            baggage = f"{baggage} + 7kg carry-on"

        block = (
            f"{idx}. {airline_name} {flight_number} \u2014 {status}\n"
            f"   {origin} \u2192 {destination} on {date_str}\n"
            f"   Departs: {dep_time_str} \u2192 Arrives: {arr_time_str}\n"
            f"   Duration: {duration_str} | {stops_str}\n"
            f"   Class: {fare_class} | Price: {price_formatted} {currency}\n"
            f"   Passengers: {passengers} | Baggage: {baggage}"
        )
        booking_blocks.append(block)

    header = f"You have {len(bookings)} active bookings:"
    return f"{header}\n\n" + "\n\n".join(booking_blocks)
