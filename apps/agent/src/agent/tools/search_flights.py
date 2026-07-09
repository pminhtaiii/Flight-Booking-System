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

FLIGHTS_CACHE = {}

@tool("search_flights")
async def search_flights(
    origin: str,
    destination: str,
    date: str,
    passengers: int = 1,
    config: RunnableConfig = None
) -> str:
    """Search for available flights between two airports on a specific date. Returns the top 5 matching flights with airline, times, price, and baggage information. Use this when the user asks to find, search, or look up flights."""
    try:
        client = get_nestjs_client(config)
    except Exception:
        return "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."

    try:
        data = await client.get_gateway_flights_search(
            origin=origin,
            destination=destination,
            date=date,
            passengers=passengers
        )
    except Exception:
        return "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."

    results = data.get("results", [])
    # Limit results to top 5
    results = results[:5]

    if config:
        thread_id = config.get("configurable", {}).get("thread_id")
        if thread_id:
            import time
            now = time.time()
            # 1. Clean up stale entries (> 1 hour old)
            stale_keys = [k for k, v in FLIGHTS_CACHE.items() if now - v.get("timestamp", 0) > 3600]
            for k in stale_keys:
                FLIGHTS_CACHE.pop(k, None)
            # 2. Bounded size (limit to 100 sessions)
            if len(FLIGHTS_CACHE) > 100:
                oldest_key = min(FLIGHTS_CACHE.keys(), key=lambda k: FLIGHTS_CACHE[k].get("timestamp", 0))
                FLIGHTS_CACHE.pop(oldest_key, None)
            # 3. Cache results
            FLIGHTS_CACHE[thread_id] = {
                "results": results,
                "timestamp": now
            }

    if not results:
        return f"Found 0 flights from {origin} to {destination} on {date}."

    flight_blocks = []
    for idx, flight in enumerate(results, 1):
        airline = flight.get("airline") or ""
        airline_name = AIRLINE_MAP.get(airline, airline)
        flight_number = flight.get("flightNumber") or ""
        dep_airport = flight.get("departureAirport") or ""
        arr_airport = flight.get("arrivalAirport") or ""

        # Parse departure time
        dep_time_str = "Unknown"
        dep_time = flight.get("departureTime")
        if dep_time:
            try:
                dep_dt = datetime.fromisoformat(dep_time.replace("Z", "+00:00"))
                dep_time_str = dep_dt.strftime("%H:%M")
            except Exception:
                dep_time_str = "Unknown"

        # Parse arrival time
        arr_time_str = "Unknown"
        arr_time = flight.get("arrivalTime")
        if arr_time:
            try:
                arr_dt = datetime.fromisoformat(arr_time.replace("Z", "+00:00"))
                arr_time_str = arr_dt.strftime("%H:%M")
            except Exception:
                arr_time_str = "Unknown"

        duration = flight.get("duration") or 0
        hours = duration // 60
        mins = duration % 60
        duration_str = f"{hours}h {mins}m"

        stops = flight.get("stops") or 0
        if stops == 0:
            stops_str = "Direct"
        elif stops == 1:
            stops_str = "1 stop"
        else:
            stops_str = f"{stops} stops"

        price = flight.get("price") or 0.0
        currency = flight.get("currency") or "USD"
        price_formatted = f"${price:,.2f}"

        fare_class = flight.get("fareClass") or "Economy"
        fare_class = fare_class.title()

        baggage = flight.get("baggageAllowance") or "No checked baggage"
        if "checked" in baggage.lower() and "carry-on" not in baggage.lower():
            baggage = f"{baggage} + 7kg carry-on"

        block = (
            f"{idx}. {airline_name} {flight_number}\n"
            f"   Departs: {dep_time_str} {dep_airport} \u2192 Arrives: {arr_time_str} {arr_airport}\n"
            f"   Duration: {duration_str} | {stops_str}\n"
            f"   Price: {price_formatted} {currency} ({fare_class})\n"
            f"   Baggage: {baggage}"
        )
        flight_blocks.append(block)

    header = f"Found {len(results)} flights from {origin} to {destination} on {date}:"
    return f"{header}\n\n" + "\n\n".join(flight_blocks)
