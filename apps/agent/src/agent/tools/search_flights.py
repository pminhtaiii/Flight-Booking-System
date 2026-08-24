import inspect
import logging
from datetime import datetime, timezone
from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from agent.infrastructure.redis import get_redis_client
from agent.tools.base import get_nestjs_client
from agent.trusted_search_snapshot import (
    AttestedSearchEnvelope,
    SnapshotOwner,
    TrustedSearchResult,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
)

logger = logging.getLogger(__name__)

AIRLINE_MAP = {
    "VN": "Vietnam Airlines",
    "NH": "ANA",
    "JL": "Japan Airlines",
    "SQ": "Singapore Airlines",
}


def _get_snapshot_lifecycle() -> TrustedSearchSnapshotLifecycle:
    redis_client = get_redis_client()
    repo = TrustedSnapshotRepository(redis_client)
    return TrustedSearchSnapshotLifecycle(repo)


def _to_utc_datetime(val: Any) -> datetime:
    if isinstance(val, datetime):
        if val.tzinfo is None:
            return val.replace(tzinfo=timezone.utc)
        return val.astimezone(timezone.utc)
    if not val or not isinstance(val, str):
        raise ValueError(f"Invalid datetime value: {val}")
    dt = datetime.fromisoformat(val.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


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

    owner = SnapshotOwner(user_id=user_id, chat_session_id=thread_id)
    try:
        lifecycle = _get_snapshot_lifecycle()
    except Exception as e:
        logger.error("Could not initialize snapshot lifecycle: %s", str(e))
        return "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."

    proposed_version = 1
    try:
        res = lifecycle.next_version(owner)
        allocated = await res if inspect.isawaitable(res) else res
        if isinstance(allocated, int) and not isinstance(allocated, bool) and allocated > 0:
            proposed_version = allocated
    except Exception as e:
        logger.warning("Could not allocate snapshot version: %s", str(e))
        proposed_version = 1

    try:
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
    if not results or not isinstance(results, list):
        return f"Found 0 flights from {origin} to {destination} on {date}."

    try:
        snapshot_results = []
        for idx, flight in enumerate(results[:5], 1):
            flight_offer_id = flight.get("flightOfferId")
            duffel_offer_id = flight.get("duffelOfferId") or flight_offer_id
            if not flight_offer_id or not duffel_offer_id:
                logger.error("Flight result missing required offer ID")
                return "I encountered an error preparing your search results. Please try again."

            dep_time_val = flight.get("departureTime") or flight.get("departureAt")
            arr_time_val = flight.get("arrivalTime") or flight.get("arrivalAt")
            if not dep_time_val or not arr_time_val:
                logger.error("Flight result missing departure or arrival time")
                return "I encountered an error preparing your search results. Please try again."

            snapshot_results.append(
                TrustedSearchResult(
                    offerIndex=idx,
                    flightOfferId=str(flight_offer_id),
                    duffelOfferId=str(duffel_offer_id),
                    airline=str(flight.get("airline") or ""),
                    origin=str(flight.get("departureAirport") or flight.get("origin") or origin),
                    destination=str(
                        flight.get("arrivalAirport") or flight.get("destination") or destination
                    ),
                    departureAt=_to_utc_datetime(dep_time_val),
                    arrivalAt=_to_utc_datetime(arr_time_val),
                    price=str(flight.get("price", "0.0")),
                    currency=str(flight.get("currency", "USD")),
                )
            )

        now_dt = datetime.now(timezone.utc)
        expires_at_raw = data.get("snapshotExpiresAt") or data.get("expiresAt")
        if not expires_at_raw:
            logger.error("Gateway flight search response missing snapshot expiry")
            return "I encountered an error preparing your search results. Please try again."

        exp_dt = _to_utc_datetime(expires_at_raw)
        if exp_dt <= now_dt:
            logger.error(
                "Gateway flight search response has expired snapshot: %s <= %s", exp_dt, now_dt
            )
            return "The flight search results have expired. Please search again."

        selection_attestation = data.get("selectionAttestation") or data.get("attestation")
        if (
            not selection_attestation
            or not isinstance(selection_attestation, str)
            or not selection_attestation.strip()
        ):
            logger.error("Gateway flight search response missing selectionAttestation")
            return "I encountered an error preparing your search results. Please try again."

        fingerprint = data.get("fingerprint")
        if not fingerprint or not isinstance(fingerprint, str) or not fingerprint.strip():
            fingerprint = selection_attestation

        snapshot_version = data.get("snapshotVersion") or proposed_version
        if (
            isinstance(snapshot_version, bool)
            or not isinstance(snapshot_version, int)
            or snapshot_version < 1
        ):
            logger.error(
                "Gateway flight search response invalid snapshotVersion: %s", snapshot_version
            )
            return "I encountered an error preparing your search results. Please try again."

        envelope = AttestedSearchEnvelope(
            schemaVersion=1,
            snapshotVersion=snapshot_version,
            expiresAt=exp_dt,
            fingerprint=fingerprint,
            selectionAttestation=selection_attestation,
            results=snapshot_results,
        )

        create_res = lifecycle.create_or_replace(owner, envelope)
        snapshot = await create_res if inspect.isawaitable(create_res) else create_res
    except Exception as e:
        logger.error("Failed to save trusted snapshot: %s", str(e), exc_info=True)
        return "I encountered an error preparing your search results. Please try again."

    safe_results = lifecycle.project_for_llm(snapshot)

    flight_blocks = []
    for flight in safe_results:
        airline_name = AIRLINE_MAP.get(flight.airline, flight.airline)
        dep_time_str = flight.departure_at.strftime("%H:%M")
        arr_time_str = flight.arrival_at.strftime("%H:%M")

        try:
            price = float(flight.price)
        except (ValueError, TypeError):
            price = 0.0
        price_formatted = f"${price:,.2f}"

        block = (
            f"{flight.index}. {airline_name}\n"
            f"   Departs: {dep_time_str} {flight.origin} \u2192 Arrives: {arr_time_str} {flight.destination}\n"
            f"   Price: {price_formatted} {flight.currency}"
        )
        flight_blocks.append(block)

    header = f"Found {len(safe_results)} flights from {origin} to {destination} on {date}:"
    return f"{header}\n\n" + "\n\n".join(flight_blocks)
