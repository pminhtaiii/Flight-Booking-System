from datetime import datetime, timezone
from typing import Any
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig
from agent.tools.base import get_nestjs_client
from agent.repositories.trusted_snapshot_repository import TrustedSnapshotRepository
from agent.infrastructure.redis import get_redis_client
from agent.models.snapshot import TrustedSearchSnapshot

AIRLINE_MAP = {
    "VN": "Vietnam Airlines",
    "NH": "ANA",
    "JL": "Japan Airlines",
    "SQ": "Singapore Airlines",
}

_SAFE_LLM_FIELDS = (
    "offerExpiresAt",
    "airline",
    "flightNumber",
    "departureAirport",
    "arrivalAirport",
    "departureTime",
    "arrivalTime",
    "duration",
    "stops",
    "price",
    "currency",
    "fareClass",
    "baggageAllowance",
)


def project_snapshot_results(snapshot: TrustedSearchSnapshot) -> list[dict[str, Any]]:
    """Project the trusted snapshot into the exact browser-safe result shape."""

    return [
        {
            "index": result.offerIndex,
            "airline": result.airline,
            "origin": result.origin,
            "destination": result.destination,
            "departureAt": result.departureAt.isoformat(),
            "arrivalAt": result.arrivalAt.isoformat(),
            "price": result.price,
            "currency": result.currency,
        }
        for result in snapshot.results
    ]

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

    thread_id = config.get("configurable", {}).get("thread_id") if config else None
    user_id = config.get("configurable", {}).get("user_id") if config else None
    
    if not thread_id or not user_id:
        return "I couldn't verify your active session to search flights. Please try again or start a new session."

    try:
        # For simplicity, using a naive version increment. In a real scenario, this might need more robust concurrency handling.
        proposed_version = 1 
        
        # Import dynamic repository helper or use directly
        redis_client = get_redis_client()
        repo = TrustedSnapshotRepository(redis_client)
        existing = await repo.get_snapshot(user_id, thread_id)
        if existing:
            proposed_version = existing.snapshotVersion + 1

        data = await client.post_gateway_flights_search_v2(
            chat_session_id=thread_id,
            proposed_snapshot_version=proposed_version,
            origin=origin,
            destination=destination,
            date=date,
            passengers=passengers
        )
    except Exception:
        return "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."

    if "error" in data:
        return data["error"]

    results = data.get("results", [])
    if not results:
        return f"Found 0 flights from {origin} to {destination} on {date}."


    # Strip identifiers before sending to LLM and create trusted snapshot
    safe_results = []
    snapshot_results = []
    for idx, flight in enumerate(results, 1):
        # build snapshot result mapping index to flightOfferId and duffelOfferId
        snapshot_results.append({
            "offerIndex": idx,
            "flightOfferId": flight["flightOfferId"],
            "duffelOfferId": flight["duffelOfferId"],
            "airline": flight["airline"],
            "origin": flight["departureAirport"],
            "destination": flight["arrivalAirport"],
            "departureAt": flight["departureTime"],
            "arrivalAt": flight["arrivalTime"],
            "price": str(flight["price"]),
            "currency": flight["currency"]
        })
        
        # Build an explicit safe dictionary for the LLM, excluding provider and
        # service-only fields instead of copying arbitrary gateway metadata.
        safe_flight = {
            key: flight[key]
            for key in _SAFE_LLM_FIELDS
            if key in flight
        }
        safe_results.append(safe_flight)


    # Store Trusted Search Snapshot in Redis
    try:
        snapshot = TrustedSearchSnapshot.model_validate({
            "schemaVersion": 1,
            "snapshotVersion": data.get("snapshotVersion"),
            "userId": user_id,
            "sessionId": thread_id,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "expiresAt": data.get("snapshotExpiresAt"),
            "selectionAttestation": data.get("selectionAttestation"),
            "fingerprint": "mock_hmac_fingerprint",
            "results": snapshot_results
        })
        await repo.save_snapshot(snapshot)
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Failed to save trusted snapshot: %s", str(e))
        # If we can't save snapshot, it's safer to fail the search so we don't present unbookable results
        return "I encountered an error preparing your search results. Please try again."

    flight_blocks = []
    for idx, flight in enumerate(safe_results, 1):
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

        try:
            price = float(flight.get("price") or 0.0)
        except ValueError:
            price = 0.0
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
