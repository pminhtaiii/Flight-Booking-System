import pytest
import httpx
from unittest.mock import AsyncMock, MagicMock
from langchain_core.runnables import RunnableConfig

from agent.tools.base import get_nestjs_client
from agent.tools.search_flights import search_flights
from agent.tools.get_preferences import get_user_preferences
from agent.tools.list_bookings import list_user_bookings
from agent.tools.registry import get_tools, get_tool_by_name, requires_confirmation


@pytest.fixture
def mock_client():
    client = MagicMock()
    client.get_gateway_flights_search = AsyncMock()
    client.get_gateway_user_preferences = AsyncMock()
    client.get_gateway_user_bookings = AsyncMock()
    return client


@pytest.fixture
def run_config(mock_client):
    return RunnableConfig(configurable={"nestjs_client": mock_client})


def test_base_get_nestjs_client(mock_client, run_config):
    client = get_nestjs_client(run_config)
    assert client == mock_client

    with pytest.raises(ValueError, match="RunnableConfig is missing or None."):
        get_nestjs_client(None)

    with pytest.raises(ValueError, match="RunnableConfig is missing 'configurable' key."):
        get_nestjs_client(RunnableConfig())

    with pytest.raises(ValueError, match="NestJSClient not found in RunnableConfig's 'configurable' key."):
        get_nestjs_client(RunnableConfig(configurable={}))


@pytest.mark.asyncio
async def test_search_flights_success(mock_client, run_config):
    mock_client.get_gateway_flights_search.return_value = {
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
                "price": 452.00,
                "currency": "USD",
                "fareClass": "economy",
                "baggageAllowance": "23kg checked"
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
    mock_client.get_gateway_flights_search.return_value = {"results": []}

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"},
        config=run_config
    )

    assert result == "Found 0 flights from HAN to NRT on 2026-07-15."


@pytest.mark.asyncio
async def test_search_flights_error(mock_client, run_config):
    mock_client.get_gateway_flights_search.side_effect = Exception("Amadeus service error")

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"},
        config=run_config
    )

    assert result == "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."


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
async def test_list_user_bookings_success(mock_client, run_config):
    mock_client.get_gateway_user_bookings.return_value = {
        "bookings": [
            {
                "airline": "VN",
                "flightNumber": "VN310",
                "status": "CONFIRMED",
                "origin": "HAN",
                "destination": "NRT",
                "departureTime": "2026-08-15T08:30:00Z",
                "arrivalTime": "2026-08-15T15:00:00Z",
                "duration": 330,
                "stops": 0,
                "fareClass": "Business",
                "price": 1250.00,
                "currency": "USD",
                "passengers": 1,
                "baggageAllowance": "32kg checked + 7kg carry-on"
            }
        ]
    }

    result = await list_user_bookings.ainvoke({}, config=run_config)

    expected = (
        "You have 1 active bookings:\n\n"
        "1. Vietnam Airlines VN310 \u2014 CONFIRMED\n"
        "   HAN \u2192 NRT on Aug 15, 2026\n"
        "   Departs: 08:30 \u2192 Arrives: 15:00\n"
        "   Duration: 5h 30m | Direct\n"
        "   Class: Business | Price: $1,250.00 USD\n"
        "   Passengers: 1 | Baggage: 32kg checked + 7kg carry-on"
    )
    assert result.strip() == expected.strip()


@pytest.mark.asyncio
async def test_list_user_bookings_empty(mock_client, run_config):
    mock_client.get_gateway_user_bookings.return_value = {"bookings": []}

    result = await list_user_bookings.ainvoke({}, config=run_config)
    assert result == "You don't have any active bookings at the moment."


@pytest.mark.asyncio
async def test_list_user_bookings_error(mock_client, run_config):
    mock_client.get_gateway_user_bookings.side_effect = Exception("Auth failed")

    result = await list_user_bookings.ainvoke({}, config=run_config)
    assert result == "I couldn't retrieve your bookings right now. Please try again in a moment."


def test_registry():
    tools = get_tools()
    assert len(tools) == 3

    t1 = get_tool_by_name("search_flights")
    assert t1 == search_flights
    assert not requires_confirmation("search_flights")

    t2 = get_tool_by_name("get_user_preferences")
    assert t2 == get_user_preferences
    assert not requires_confirmation("get_user_preferences")

    t3 = get_tool_by_name("list_user_bookings")
    assert t3 == list_user_bookings
    assert not requires_confirmation("list_user_bookings")

    with pytest.raises(ValueError, match="Tool 'non_existent' is not registered."):
        get_tool_by_name("non_existent")

    assert not requires_confirmation("non_existent")
