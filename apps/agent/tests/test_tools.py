import pytest
import httpx
from unittest.mock import AsyncMock, MagicMock
from langchain_core.runnables import RunnableConfig

from agent.tools.base import get_nestjs_client
from agent.tools.search_flights import search_flights
from agent.tools.get_preferences import get_user_preferences
from agent.tools.booking_summaries import list_user_booking_summaries
from agent.tools.booking_detail import get_booking_detail
from agent.tools.registry import (
    get_tools, get_tool_by_name, requires_confirmation,
    get_general_tools, get_travel_tools, get_checkout_tools
)


@pytest.fixture
def mock_client():
    client = MagicMock()
    client.post_gateway_flights_search_v2 = AsyncMock()
    client.get_gateway_flights_search = AsyncMock()
    client.get_gateway_user_preferences = AsyncMock()
    client.get_gateway_user_booking_summaries = AsyncMock()
    client.get_gateway_booking_detail = AsyncMock()
    return client


@pytest.fixture
def run_config(mock_client):
    return RunnableConfig(configurable={
        "nestjs_client": mock_client,
        "thread_id": "test-session",
        "user_id": "test-user",
        "chat_budget_repository": MagicMock(),
        "session_lock_repository": MagicMock(),
        "trusted_snapshot_repository": AsyncMock()
    })


def test_base_get_nestjs_client(mock_client, run_config):
    client = get_nestjs_client(run_config)
    assert client == mock_client

    with pytest.raises(ValueError, match="RunnableConfig is missing or None."):
        get_nestjs_client(None)

    with pytest.raises(ValueError, match="RunnableConfig is missing 'configurable' key."):
        get_nestjs_client(RunnableConfig())

    with pytest.raises(ValueError, match="NestJSClient not found in RunnableConfig's 'configurable' key."):
        get_nestjs_client(RunnableConfig(configurable={}))


@pytest.fixture(autouse=True)
def mock_repo(monkeypatch):
    mock = AsyncMock()
    mock.get_snapshot.return_value = None
    monkeypatch.setattr("agent.tools.search_flights.TrustedSnapshotRepository", lambda *args, **kwargs: mock)
    monkeypatch.setattr("agent.tools.search_flights.get_redis_client", lambda *args, **kwargs: MagicMock())

@pytest.mark.asyncio
async def test_search_flights_success(mock_client, run_config):
    mock_client.post_gateway_flights_search_v2.return_value = {
        "snapshotVersion": 1,
        "snapshotExpiresAt": "2026-07-15T09:30:00Z",
        "selectionAttestation": "mock_attestation",
        "results": [
            {
                "airline": "VN",
                "flightNumber": "VN310",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T08:30:00",
                "arrivalTime": "2026-07-15T15:00:00",
                "duration": 330,
                "stops": 0,
                "price": "452.00",
                "currency": "USD",
                "fareClass": "economy",
                "baggageAllowance": "23kg checked",
                "flightOfferId": "offer_123",
                "duffelOfferId": "duffel_456"
            }
        ]
    }

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15", "passengers": 1},
        config=run_config
    )

    expected = (
        "Found 1 flights from HAN to NRT on 2026-07-15:\n\n"
        "1. Vietnam Airlines VN310\n"
        "   Departs: 08:30 HAN \u2192 Arrives: 15:00 NRT\n"
        "   Duration: 5h 30m | Direct\n"
        "   Price: $452.00 USD (Economy)\n"
        "   Baggage: 23kg checked + 7kg carry-on"
    )
    assert result.strip() == expected.strip()


@pytest.mark.asyncio
async def test_search_flights_empty(mock_client, run_config):
    mock_client.post_gateway_flights_search_v2.return_value = {"results": []}

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"},
        config=run_config
    )

    assert result == "Found 0 flights from HAN to NRT on 2026-07-15."


@pytest.mark.asyncio
async def test_search_flights_error(mock_client, run_config):
    mock_client.post_gateway_flights_search_v2.side_effect = Exception("Amadeus service error")

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"},
        config=run_config
    )

    assert result == "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."


@pytest.mark.asyncio
async def test_search_flights_honest_degradation_error(mock_client, run_config):
    mock_client.post_gateway_flights_search_v2.return_value = {
        "error": "I can currently only search economy class for adult passengers. For other cabin classes or passenger types, please use the search page."
    }

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"},
        config=run_config
    )

    assert result == "I can currently only search economy class for adult passengers. For other cabin classes or passenger types, please use the search page."



@pytest.mark.asyncio
async def test_get_user_preferences_success(mock_client, run_config):
    mock_client.get_gateway_user_preferences.return_value = {
        "seatPreference": "window",
        "classPreference": "business",
        "preferredAirlines": ["VN", "NH"],
        "blacklistedAirlines": [],
        "dietaryNeeds": "vegetarian"
    }

    result = await get_user_preferences.ainvoke({}, config=run_config)

    expected = (
        "Your travel preferences:\n"
        "- Seat: Window\n"
        "- Class: Business\n"
        "- Preferred airlines: Vietnam Airlines, ANA\n"
        "- Blacklisted airlines: None\n"
        "- Dietary needs: Vegetarian"
    )
    assert result.strip() == expected.strip()


@pytest.mark.asyncio
async def test_get_user_preferences_profile_not_found(mock_client, run_config):
    req = httpx.Request("GET", "http://localhost:3001/api/agent-gateway/users/preferences")
    resp = httpx.Response(404, json={"message": "No profile", "code": "PROFILE_NOT_FOUND"}, request=req)
    mock_client.get_gateway_user_preferences.side_effect = httpx.HTTPStatusError("Not Found", request=req, response=resp)

    result = await get_user_preferences.ainvoke({}, config=run_config)
    assert result == "You don't have any travel preferences saved yet. You can set them up in your profile settings."


@pytest.mark.asyncio
async def test_get_user_preferences_error(mock_client, run_config):
    mock_client.get_gateway_user_preferences.side_effect = Exception("DB connection failed")

    result = await get_user_preferences.ainvoke({}, config=run_config)
    assert result == "I couldn't retrieve your preferences right now. Please try again in a moment."


@pytest.mark.asyncio
async def test_list_user_booking_summaries_success(mock_client, run_config):
    mock_client.get_gateway_user_booking_summaries.return_value = {
        "summaries": [
            {
                "airline": "VN",
                "origin": "HAN",
                "destination": "NRT",
                "departureAt": "2026-08-15T08:30:00Z",
                "arrivalAt": "2026-08-15T15:00:00Z",
                "durationMinutes": 330,
                "stopCount": 0,
                "status": "CONFIRMED",
                "agentReference": "ref-123"
            }
        ]
    }

    result = await list_user_booking_summaries.ainvoke({}, config=run_config)

    expected = (
        "- [CONFIRMED] VN from HAN to NRT. Departs 2026-08-15T08:30:00Z, Arrives 2026-08-15T15:00:00Z. Duration: 330 mins, Stops: 0. (Ref: ref-123)"
    )
    assert result.strip() == expected.strip()


@pytest.mark.asyncio
async def test_list_user_booking_summaries_empty(mock_client, run_config):
    mock_client.get_gateway_user_booking_summaries.return_value = {"summaries": []}

    result = await list_user_booking_summaries.ainvoke({}, config=run_config)
    assert result == "No bookings found."


@pytest.mark.asyncio
async def test_list_user_booking_summaries_error(mock_client, run_config):
    mock_client.get_gateway_user_booking_summaries.side_effect = Exception("Auth failed")

    result = await list_user_booking_summaries.ainvoke({}, config=run_config)
    assert result == "Failed to fetch booking summaries."

@pytest.mark.asyncio
async def test_get_booking_detail_success(mock_client, run_config):
    mock_client.get_gateway_booking_detail.return_value = {
        "status": "CONFIRMED",
        "airline": "VN",
        "origin": "HAN",
        "destination": "NRT",
        "departureAt": "2026-08-15T08:30:00Z",
        "arrivalAt": "2026-08-15T15:00:00Z",
        "flightNumber": "VN310",
        "baggageSummary": "23kg checked",
        "refundable": False,
        "changeable": False
    }

    result = await get_booking_detail.ainvoke({"agent_reference": "ref-123"}, config=run_config)

    assert "Booking ref-123 Detail:" in result
    assert "VN310 from HAN to NRT" in result
    assert "Baggage: 23kg checked" in result


def test_registry_inventories():
    general = get_general_tools()
    assert len(general) == 0

    travel = get_travel_tools()
    # Phase 5 splits list_user_bookings into summaries and detail
    assert len(travel) == 5
    tool_names = [t.name for t in travel]
    assert "search_flights" in tool_names
    assert "get_user_preferences" in tool_names
    assert "list_user_booking_summaries" in tool_names
    assert "get_booking_detail" in tool_names
    assert "check_booking_readiness" in tool_names

    checkout = get_checkout_tools()
    # T046 will add signal_checkout_intent
    assert len(checkout) == 1
    tool_names = [t.name for t in checkout]
    assert "signal_checkout_intent" in tool_names

def test_tool_by_name():
    t1 = get_tool_by_name("search_flights")
    assert t1 == search_flights
    assert not requires_confirmation("search_flights")

    with pytest.raises(ValueError, match="Tool 'non_existent' is not registered."):
        get_tool_by_name("non_existent")

    assert not requires_confirmation("non_existent")

from agent.tools.check_booking_readiness import check_booking_readiness

@pytest.fixture
def mock_client_with_readiness(mock_client):
    mock_client.check_booking_readiness = AsyncMock()
    return mock_client

@pytest.fixture
def run_config_with_readiness(mock_client_with_readiness):
    return RunnableConfig(configurable={"nestjs_client": mock_client_with_readiness})

@pytest.mark.asyncio
async def test_check_booking_readiness_tool_success(mock_client_with_readiness, run_config_with_readiness):
    mock_client_with_readiness.check_booking_readiness.return_value = {
        "ready": False,
        "scope": "INTERNATIONAL",
        "nextAction": "COMPLETE_PROFILE",
        "passengers": []
    }

    result = await check_booking_readiness.ainvoke(
        {"flight_offer_id": "offer-123", "passengers": [{"passengerType": "ADULT", "passengerOrdinal": 1, "sourceType": "traveler_profile"}]},
        config=run_config_with_readiness
    )

    assert result.get("ready") is False
    assert result.get("nextAction") == "COMPLETE_PROFILE"
    mock_client_with_readiness.check_booking_readiness.assert_called_once_with(
        "offer-123",
        [{"passengerType": "ADULT", "passengerOrdinal": 1, "sourceType": "traveler_profile"}]
    )

@pytest.mark.asyncio
async def test_check_booking_readiness_tool_error(mock_client_with_readiness, run_config_with_readiness):
    mock_client_with_readiness.check_booking_readiness.side_effect = Exception("DB failed")

    result = await check_booking_readiness.ainvoke(
        {"flight_offer_id": "offer-123", "passengers": []},
        config=run_config_with_readiness
    )

    assert "error" in result
    assert "Failed to check booking readiness safely" in result["error"]
