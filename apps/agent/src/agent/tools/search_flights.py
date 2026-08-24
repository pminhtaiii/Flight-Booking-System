import inspect
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from agent.infrastructure.redis import get_redis_client
from agent.models.snapshot import TrustedSearchSnapshot
from agent.repositories.trusted_snapshot_repository import TrustedSnapshotRepository
from agent.tools.base import get_nestjs_client

logger = logging.getLogger(__name__)

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
    origin: str, destination: str, date: str, passengers: int = 1, config: RunnableConfig = None
) -> str:
    """Search for available flights between two airports on a specific date. Returns the top 5 matching flights with airline, times, price, and baggage information. Use this when the user asks to find, search, or look up flights."""
    try:
        client = get_nestjs_client(config)
    except Exception:
        return "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."

    configurable = (
        config.get("configurable", {})
        if isinstance(config, dict)
        else getattr(config, "configurable", {})
        if config
        else {}
    )
    thread_id = configurable.get("thread_id") or "default_thread"
    user_id = configurable.get("user_id") or "default_user"

    try:
        proposed_version = 1
        try:
            redis_client = get_redis_client()
            repo = TrustedSnapshotRepository(redis_client)
            res = repo.get_snapshot(user_id, thread_id)
            existing = await res if inspect.isawaitable(res) else res
            if existing:
                proposed_version = existing.snapshotVersion + 1
        except Exception as e:
            logger.warning("Could not check existing snapshot: %s", str(e))
            repo = None

        search_call = getattr(client, "post_gateway_flights_search_v2", None) or getattr(
            client, "search_flights_v2", None
        )
        if not search_call:
            search_call = getattr(client, "get_gateway_flights_search", None)

        if not search_call:
            return "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."

        call_res = search_call(
            chat_session_id=thread_id,
            proposed_snapshot_version=proposed_version,
            origin=origin,
            destination=destination,
            date=date,
            passengers=passengers,
        )
        data = await call_res if inspect.isawaitable(call_res) else call_res
    except Exception as e:
        logger.warning("Error calling flight search v2: %s", str(e))
        return "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."

    if not isinstance(data, dict):
        return "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."

    if "error" in data:
        return str(data["error"])

    results = data.get("results", [])
    if not results:
        return f"Found 0 flights from {origin} to {destination} on {date}."

    def _to_utc_iso(val: Any) -> str:
        if not val:
            return datetime.now(timezone.utc).isoformat()
        if isinstance(val, datetime):
            if val.tzinfo is None:
                val = val.replace(tzinfo=timezone.utc)
            return val.astimezone(timezone.utc).isoformat()
        val_str = str(val).strip()
        try:
            dt = datetime.fromisoformat(val_str.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat()
        except Exception:
            if not val_str.endswith("Z") and "+" not in val_str and "-" not in val_str[10:]:
                return val_str + "Z"
            return val_str

    # Strip identifiers before sending to LLM and create trusted snapshot
    safe_results = []
    snapshot_results = []
    for idx, flight in enumerate(results, 1):
        dep_time_val = flight.get("departureTime") or flight.get("departureAt")
        arr_time_val = flight.get("arrivalTime") or flight.get("arrivalAt")
        snapshot_results.append(
            {
                "offerIndex": idx,
                "flightOfferId": flight.get("flightOfferId") or f"mock-offer-{idx}",
                "duffelOfferId": flight.get("duffelOfferId")
                or flight.get("flightOfferId")
                or f"mock-duffel-{idx}",
                "airline": flight.get("airline", ""),
                "origin": flight.get("departureAirport", origin),
                "destination": flight.get("arrivalAirport", destination),
                "departureAt": _to_utc_iso(dep_time_val),
                "arrivalAt": _to_utc_iso(arr_time_val),
                "price": str(flight.get("price", "0.0")),
                "currency": flight.get("currency", "USD"),
            }
        )

        safe_flight = {key: flight[key] for key in _SAFE_LLM_FIELDS if key in flight}
        safe_results.append(safe_flight)

    # Store Trusted Search Snapshot in Redis
    try:
        if repo is None:
            redis_client = get_redis_client()
            repo = TrustedSnapshotRepository(redis_client)

        now_dt = datetime.now(timezone.utc)
        expires_at_raw = data.get("snapshotExpiresAt")
        if expires_at_raw:
            try:
                exp_dt = datetime.fromisoformat(str(expires_at_raw).replace("Z", "+00:00"))
                if exp_dt.tzinfo is None:
                    exp_dt = exp_dt.replace(tzinfo=timezone.utc)
                if exp_dt <= now_dt:
                    exp_dt = now_dt + timedelta(minutes=15)
                expires_at = exp_dt.astimezone(timezone.utc).isoformat()
            except Exception:
                expires_at = (now_dt + timedelta(minutes=15)).isoformat()
        else:
            expires_at = (now_dt + timedelta(minutes=15)).isoformat()

        snapshot = TrustedSearchSnapshot.model_validate(
            {
                "schemaVersion": 1,
                "snapshotVersion": data.get("snapshotVersion") or proposed_version,
                "userId": user_id,
                "sessionId": thread_id,
                "createdAt": (now_dt - timedelta(seconds=1)).isoformat(),
                "expiresAt": expires_at,
                "selectionAttestation": data.get("selectionAttestation") or "sel_v1_mock",
                "fingerprint": data.get("fingerprint") or "mock_hmac_fingerprint",
                "results": snapshot_results,
            }
        )
        save_res = repo.save_snapshot(snapshot)
        if inspect.isawaitable(save_res):
            await save_res
    except Exception as e:
        logger.warning("Failed to save trusted snapshot: %s", str(e))
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
