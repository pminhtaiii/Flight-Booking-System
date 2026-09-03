from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from langchain_core.runnables import RunnableConfig

from agent.tools.base import get_nestjs_client
from agent.tools.booking_detail import get_booking_detail
from agent.tools.booking_summaries import list_user_booking_summaries
from agent.tools.check_booking_readiness import check_booking_readiness
from agent.tools.flight_match_projection import project_flight_search_for_narration
from agent.tools.get_preferences import get_user_preferences
from agent.tools.registry import (
    get_checkout_tools,
    get_general_tools,
    get_tool_by_name,
    get_tools,
    get_travel_tools,
    requires_confirmation,
)
from agent.tools.search_flights import search_flights


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
    return RunnableConfig(
        configurable={
            "nestjs_client": mock_client,
            "thread_id": "test-session",
            "user_id": "test-user",
            "chat_budget_repository": MagicMock(),
            "session_lock_repository": MagicMock(),
            "trusted_snapshot_repository": AsyncMock(),
        }
    )


def test_base_get_nestjs_client(mock_client, run_config):
    client = get_nestjs_client(run_config)
    assert client == mock_client

    with pytest.raises(ValueError, match="RunnableConfig is missing or None."):
        get_nestjs_client(None)

    with pytest.raises(ValueError, match="RunnableConfig is missing 'configurable' key."):
        get_nestjs_client(RunnableConfig())

    with pytest.raises(
        ValueError, match="NestJSClient not found in RunnableConfig's 'configurable' key."
    ):
        get_nestjs_client(RunnableConfig(configurable={}))


@pytest.fixture(autouse=True)
def mock_repo(monkeypatch):
    mock = AsyncMock()
    mock.get_snapshot.return_value = None
    monkeypatch.setattr(
        "agent.tools.search_flights.TrustedSnapshotRepository", lambda *args, **kwargs: mock
    )
    monkeypatch.setattr(
        "agent.tools.search_flights.get_redis_client", lambda *args, **kwargs: MagicMock()
    )


@pytest.mark.asyncio
async def test_search_flights_success(mock_client, run_config):
    mock_client.post_gateway_flights_search_v2.return_value = {
        "snapshotVersion": 1,
        "snapshotExpiresAt": "2027-07-15T09:30:00Z",
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
                "duffelOfferId": "duffel_456",
            }
        ],
    }

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15", "passengers": 1},
        config=run_config,
    )

    # Integrates project_flight_search_for_narration and outputs RANKED narration
    assert "Standard category ranking by stops, price, duration" in result
    assert "Found 1 flights:" in result
    assert "1. Vietnam Airlines" in result
    assert "HAN → NRT" in result
    assert "Departs: 08:30 | Arrives: 15:00" in result
    assert "Duration: 5h 30m | Stops: Direct" in result
    assert "Price: $452.00 USD" in result
    assert "Baggage: 23kg checked" in result
    assert "offer_123" not in result
    assert "duffel_456" not in result


@pytest.mark.asyncio
async def test_search_flights_matched_mode(mock_client, run_config):
    mock_client.post_gateway_flights_search_v2.return_value = {
        "mode": "MATCHED",
        "snapshotVersion": 1,
        "snapshotExpiresAt": "2027-07-15T09:30:00Z",
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
                "duffelOfferId": "duffel_456",
                "matchResult": {
                    "score": 92,
                    "matchLevel": "STRONG",
                    "breakdown": [
                        {
                            "dimension": "PRICE",
                            "score": 0.9,
                            "explanation": {
                                "key": "match.price.below_median",
                                "params": {"percentDiff": 15},
                            },
                        },
                        {
                            "dimension": "AIRLINE",
                            "score": 1.0,
                            "explanation": {
                                "key": "match.airline.preferred",
                                "params": {"airline": "VN"},
                            },
                        },
                    ],
                },
            }
        ],
    }

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15", "passengers": 1},
        config=run_config,
    )

    assert "Found 1 matching flights:" in result
    assert "1. Vietnam Airlines" in result
    assert "Match Score: 92/100 (Strong Match)" in result
    assert "• 15% below median price" in result
    assert "• Matches preferred airline (VN)" in result


@pytest.mark.asyncio
async def test_search_flights_preserves_gateway_order(mock_client, run_config):
    mock_client.post_gateway_flights_search_v2.return_value = {
        "mode": "MATCHED",
        "snapshotVersion": 1,
        "snapshotExpiresAt": "2027-07-15T09:30:00Z",
        "selectionAttestation": "mock_attestation",
        "results": [
            {
                "airline": "SQ",
                "flightNumber": "SQ1",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T10:00:00",
                "arrivalTime": "2026-07-15T18:00:00",
                "duration": 480,
                "stops": 1,
                "price": "600.00",
                "currency": "USD",
                "flightOfferId": "offer_sq",
                "duffelOfferId": "duffel_sq",
                "matchResult": {"score": 70, "matchLevel": "GOOD"},
            },
            {
                "airline": "VN",
                "flightNumber": "VN2",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T08:00:00",
                "arrivalTime": "2026-07-15T14:00:00",
                "duration": 360,
                "stops": 0,
                "price": "300.00",
                "currency": "USD",
                "flightOfferId": "offer_vn",
                "duffelOfferId": "duffel_vn",
                "matchResult": {"score": 95, "matchLevel": "STRONG"},
            },
        ],
    }

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15", "passengers": 1},
        config=run_config,
    )

    sq_idx = result.find("1. Singapore Airlines")
    vn_idx = result.find("2. Vietnam Airlines")
    assert sq_idx != -1
    assert vn_idx != -1
    assert sq_idx < vn_idx


@pytest.mark.asyncio
async def test_search_flights_unknown_explanation_key_fallback(mock_client, run_config):
    mock_client.post_gateway_flights_search_v2.return_value = {
        "mode": "MATCHED",
        "snapshotVersion": 1,
        "snapshotExpiresAt": "2027-07-15T09:30:00Z",
        "selectionAttestation": "mock_attestation",
        "results": [
            {
                "airline": "JL",
                "flightNumber": "JL752",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T23:00:00",
                "arrivalTime": "2026-07-16T06:00:00",
                "duration": 300,
                "stops": 0,
                "price": "500.00",
                "currency": "USD",
                "flightOfferId": "offer_jl",
                "duffelOfferId": "duffel_jl",
                "matchResult": {
                    "score": 80,
                    "matchLevel": "GOOD",
                    "breakdown": [
                        {
                            "dimension": "FUTURE_DIMENSION",
                            "score": 0.8,
                            "explanation": {
                                "key": "match.future_unknown.attribute",
                                "params": {"custom": 123},
                            },
                        },
                        {
                            "dimension": "UNMAPPED_DIMENSION_NO_EXP",
                            "score": 0.5,
                        },
                    ],
                },
            }
        ],
    }

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15", "passengers": 1},
        config=run_config,
    )

    assert "1. Japan Airlines" in result
    assert "Match Score: 80/100 (Good Match)" in result
    assert "• Matches search criteria" in result or "• Match criterion" in result


@pytest.mark.asyncio
async def test_search_flights_empty(mock_client, run_config):
    mock_client.post_gateway_flights_search_v2.return_value = {"results": []}

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"}, config=run_config
    )

    assert result == "Found 0 flights from HAN to NRT on 2026-07-15."


@pytest.mark.asyncio
async def test_search_flights_error(mock_client, run_config):
    mock_client.post_gateway_flights_search_v2.side_effect = Exception("Amadeus service error")

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"}, config=run_config
    )

    assert (
        result
        == "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."
    )


@pytest.mark.asyncio
async def test_search_flights_honest_degradation_error(mock_client, run_config):
    mock_client.post_gateway_flights_search_v2.return_value = {
        "error": "I can currently only search economy class for adult passengers. For other cabin classes or passenger types, please use the search page."
    }

    result = await search_flights.ainvoke(
        {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"}, config=run_config
    )

    assert (
        result
        == "I can currently only search economy class for adult passengers. For other cabin classes or passenger types, please use the search page."
    )


@pytest.mark.asyncio
async def test_get_user_preferences_success(mock_client, run_config):
    mock_client.get_gateway_user_preferences.return_value = {
        "seatPreference": "window",
        "classPreference": "business",
        "preferredAirlines": ["VN", "NH"],
        "blacklistedAirlines": [],
        "dietaryNeeds": "vegetarian",
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
    resp = httpx.Response(
        404, json={"message": "No profile", "code": "PROFILE_NOT_FOUND"}, request=req
    )
    mock_client.get_gateway_user_preferences.side_effect = httpx.HTTPStatusError(
        "Not Found", request=req, response=resp
    )

    result = await get_user_preferences.ainvoke({}, config=run_config)
    assert (
        result
        == "You don't have any travel preferences saved yet. You can set them up in your profile settings."
    )


@pytest.mark.asyncio
async def test_get_user_preferences_error(mock_client, run_config):
    mock_client.get_gateway_user_preferences.side_effect = Exception("DB connection failed")

    result = await get_user_preferences.ainvoke({}, config=run_config)
    assert result == "I couldn't retrieve your preferences right now. Please try again in a moment."


@pytest.mark.asyncio
async def test_list_user_booking_summaries_success(mock_client, run_config):
    mock_client.get_gateway_user_booking_summaries.return_value = {
        "bookings": [
            {
                "bookingReference": "bkref_123",
                "airline": "VN",
                "origin": "HAN",
                "destination": "NRT",
                "departureTime": "2026-08-15T08:30:00Z",
                "arrivalTime": "2026-08-15T15:00:00Z",
                "durationMinutes": 330,
                "stops": 0,
                "status": "CONFIRMED",
            }
        ]
    }

    result = await list_user_booking_summaries.ainvoke({}, config=run_config)

    assert "bkref_123" in result
    assert "CONFIRMED" in result
    assert "VN" in result
    assert "HAN" in result
    assert "NRT" in result


@pytest.mark.asyncio
async def test_list_user_booking_summaries_empty(mock_client, run_config):
    mock_client.get_gateway_user_booking_summaries.return_value = {"bookings": []}

    result = await list_user_booking_summaries.ainvoke({}, config=run_config)
    assert "No bookings found" in result or "You don't have any bookings" in result


@pytest.mark.asyncio
async def test_list_user_booking_summaries_error(mock_client, run_config):
    mock_client.get_gateway_user_booking_summaries.side_effect = Exception("Auth failed")

    result = await list_user_booking_summaries.ainvoke({}, config=run_config)
    assert "failed" in result.lower() or "error" in result.lower() or "couldn't" in result.lower()


@pytest.mark.asyncio
async def test_get_booking_detail_success(mock_client, run_config):
    mock_client.get_gateway_booking_detail.return_value = {
        "bookingReference": "bkref_123",
        "airline": "VN",
        "origin": "HAN",
        "destination": "NRT",
        "departureTime": "2026-08-15T08:30:00Z",
        "arrivalTime": "2026-08-15T15:00:00Z",
        "durationMinutes": 330,
        "stops": 0,
        "status": "CONFIRMED",
        "flightNumber": "VN310",
        "baggageAllowance": "23kg checked",
        "refundable": False,
        "changeable": False,
    }

    result = await get_booking_detail.ainvoke({"booking_reference": "bkref_123"}, config=run_config)

    assert "bkref_123" in result
    assert "VN310" in result
    assert "HAN" in result
    assert "NRT" in result
    assert "23kg checked" in result


def test_registry_inventories():
    general = get_general_tools()
    assert len(general) == 0

    travel = get_travel_tools()
    assert len(travel) == 5
    tool_names = [t.name for t in travel]
    assert "search_flights" in tool_names
    assert "get_user_preferences" in tool_names
    assert "list_user_booking_summaries" in tool_names
    assert "get_booking_detail" in tool_names
    assert "check_booking_readiness" in tool_names

    all_tool_names = [t.name for t in get_tools()]
    assert "list_user_bookings" not in all_tool_names
    assert "list_user_bookings" not in tool_names

    checkout = get_checkout_tools()
    assert len(checkout) == 1
    tool_names = [t.name for t in checkout]
    assert "signal_checkout_intent" in tool_names


def test_tool_by_name():
    t1 = get_tool_by_name("search_flights")
    assert t1 == search_flights
    assert not requires_confirmation("search_flights")

    t2 = get_tool_by_name("list_user_booking_summaries")
    assert t2 == list_user_booking_summaries

    t3 = get_tool_by_name("get_booking_detail")
    assert t3 == get_booking_detail

    with pytest.raises(ValueError, match="Tool 'list_user_bookings' is not registered."):
        get_tool_by_name("list_user_bookings")

    with pytest.raises(ValueError, match="Tool 'non_existent' is not registered."):
        get_tool_by_name("non_existent")

    assert not requires_confirmation("non_existent")


@pytest.fixture
def mock_client_with_readiness(mock_client):
    mock_client.check_booking_readiness = AsyncMock()
    return mock_client


@pytest.fixture
def run_config_with_readiness(mock_client_with_readiness):
    return RunnableConfig(configurable={"nestjs_client": mock_client_with_readiness})


@pytest.mark.asyncio
async def test_check_booking_readiness_tool_success(
    mock_client_with_readiness, run_config_with_readiness
):
    mock_client_with_readiness.check_booking_readiness.return_value = {
        "ready": False,
        "scope": "INTERNATIONAL",
        "nextAction": "COMPLETE_PROFILE",
        "passengers": [],
    }

    result = await check_booking_readiness.ainvoke(
        {
            "flight_offer_id": "offer-123",
            "passengers": [
                {"passengerType": "ADULT", "passengerOrdinal": 1, "sourceType": "traveler_profile"}
            ],
        },
        config=run_config_with_readiness,
    )

    assert result.get("ready") is False
    assert result.get("nextAction") == "COMPLETE_PROFILE"
    mock_client_with_readiness.check_booking_readiness.assert_called_once_with(
        "offer-123",
        [{"passengerType": "ADULT", "passengerOrdinal": 1, "sourceType": "traveler_profile"}],
    )


@pytest.mark.asyncio
async def test_check_booking_readiness_tool_error(
    mock_client_with_readiness, run_config_with_readiness
):
    mock_client_with_readiness.check_booking_readiness.side_effect = Exception("DB failed")

    result = await check_booking_readiness.ainvoke(
        {"flight_offer_id": "offer-123", "passengers": []}, config=run_config_with_readiness
    )

    assert "error" in result
    assert "Failed to check booking readiness safely" in result["error"]


def test_project_flight_search_for_narration_matched_mode():
    payload = {
        "mode": "MATCHED",
        "snapshotVersion": 1,
        "selectionAttestation": "secret_attestation_signature_abc123",
        "results": [
            {
                "flightOfferId": "f74a816a-723a-4977-9df0-4b2a8d11d123",
                "duffelOfferId": "off_0000A1B2C3D4E5",
                "airline": "VN",
                "flightNumber": "VN310",
                "departureAirport": "HAN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-07-15T08:30:00Z",
                "arrivalTime": "2026-07-15T14:00:00Z",
                "duration": 330,
                "stops": 0,
                "price": "452.00",
                "currency": "USD",
                "fareClass": "economy",
                "baggageAllowance": "23kg checked",
                "matchResult": {
                    "eligibility": {"eligible": True, "violations": []},
                    "score": 85,
                    "matchLevel": "STRONG",
                    "breakdown": [
                        {
                            "dimension": "PRICE",
                            "score": 0.85,
                            "weight": 0.2,
                            "contribution": 0.17,
                            "signal": "POSITIVE",
                            "explanation": {
                                "key": "match.price.below_median",
                                "params": {"percentDiff": 15},
                            },
                        },
                        {
                            "dimension": "AIRLINE",
                            "score": 1.0,
                            "weight": 0.15,
                            "contribution": 0.15,
                            "signal": "POSITIVE",
                            "explanation": {
                                "key": "match.airline.preferred",
                                "params": {"airline": "VN"},
                            },
                        },
                    ],
                },
            }
        ],
    }

    result = project_flight_search_for_narration(payload)

    # 1. Rank
    assert "1." in result
    # 2. Airline name mapped
    assert "Vietnam Airlines" in result
    # 3. Route
    assert "HAN → NRT" in result or "HAN -> NRT" in result
    # 4. Departure and arrival formatted as HH:MM
    assert "08:30" in result
    assert "14:00" in result
    # 5. Price and currency
    assert "$452.00 USD" in result or "452.00 USD" in result
    # 6. Duration
    assert "5h 30m" in result
    # 7. Stops
    assert "Direct" in result
    # 8. Baggage
    assert "23kg checked" in result
    # 9. Overall score
    assert "85" in result
    # 10. Match level
    assert "Strong Match" in result
    # 11. Allowlisted bullet points
    assert "• 15% below median price" in result
    assert "• Matches preferred airline (VN)" in result


def test_project_flight_search_for_narration_ranked_mode():
    payload = {
        "mode": "RANKED",
        "selectionAttestation": "secret_attestation_signature_ranked",
        "results": [
            {
                "flightOfferId": "f74a816a-723a-4977-9df0-4b2a8d11d456",
                "duffelOfferId": "off_0000A1B2C3D4E6",
                "airline": "SQ",
                "flightNumber": "SQ600",
                "departureAirport": "SIN",
                "arrivalAirport": "HAN",
                "departureTime": "2026-07-15T10:15:00Z",
                "arrivalTime": "2026-07-15T13:45:00Z",
                "duration": 210,
                "stops": 1,
                "price": 320.50,
                "currency": "USD",
                "fareClass": "economy",
                "baggageAllowance": "30kg checked",
                "matchResult": None,
            }
        ],
    }

    result = project_flight_search_for_narration(payload)

    # Standard flight details
    assert "1." in result
    assert "Singapore Airlines" in result
    assert "SIN → HAN" in result or "SIN -> HAN" in result
    assert "10:15" in result
    assert "13:45" in result
    assert "3h 30m" in result
    assert "1 stop" in result
    assert "$320.50 USD" in result or "320.50 USD" in result
    assert "30kg checked" in result

    # Disclaimer
    assert (
        "Standard category ranking by stops, price, duration. Set preferences in profile for personalized matches"
        in result
    )

    # Strictly zero score claims or match levels
    lower_result = result.lower()
    assert "score" not in lower_result
    assert "match level" not in lower_result
    assert "strong match" not in lower_result
    assert "good match" not in lower_result
    assert "fair match" not in lower_result
    assert "weak match" not in lower_result


def test_project_flight_search_for_narration_empty_results():
    assert "0 flights" in project_flight_search_for_narration(
        {"results": []}
    ) or "No flights" in project_flight_search_for_narration({"results": []})
    assert "0 flights" in project_flight_search_for_narration(
        {}
    ) or "No flights" in project_flight_search_for_narration({})


def test_project_flight_search_for_narration_negative_privacy_invariants():
    payload = {
        "mode": "MATCHED",
        "selectionAttestation": "jwt.sensitive.attestation.token.value",
        "userId": "usr_super_secret_12345",
        "user_id": "usr_super_secret_12345",
        "email": "traveler@example.com",
        "customerEmail": "traveler@example.com",
        "passengerName": "Secret Traveler",
        "passportNumber": "N12345678",
        "dateOfBirth": "1990-01-01",
        "address": "123 Main Street",
        "results": [
            {
                "flightOfferId": "11111111-2222-3333-4444-555555555555",
                "duffelOfferId": "off_duffel_secret_offer_999",
                "airline": "JL",
                "departureAirport": "HND",
                "arrivalAirport": "HAN",
                "departureTime": "2026-07-15T09:00:00Z",
                "arrivalTime": "2026-07-15T13:00:00Z",
                "duration": 240,
                "stops": 0,
                "price": 500,
                "currency": "USD",
                "matchResult": {
                    "score": 90,
                    "matchLevel": "STRONG",
                    "breakdown": [
                        {
                            "dimension": "PRICE",
                            "score": 0.9,
                            "weight": 0.2,
                            "contribution": 0.18,
                            "signal": "POSITIVE",
                            "explanation": {
                                "key": "match.price.below_median",
                                "params": {"percentDiff": 20},
                            },
                        }
                    ],
                },
            }
        ],
    }

    result = project_flight_search_for_narration(payload)

    # Negative privacy assertions
    assert "off_duffel_secret_offer_999" not in result
    assert "duffelOfferId" not in result
    assert "11111111-2222-3333-4444-555555555555" not in result
    assert "flightOfferId" not in result
    assert "jwt.sensitive.attestation.token.value" not in result
    assert "selectionAttestation" not in result
    assert "usr_super_secret_12345" not in result
    assert "traveler@example.com" not in result
    assert "Secret Traveler" not in result
    assert "N12345678" not in result
    assert "1990-01-01" not in result
    assert "123 Main Street" not in result


def test_project_flight_search_for_narration_top_5_cap_and_fallback():
    # 7 results, unknown airline code "XX"
    results = []
    for i in range(1, 8):
        results.append(
            {
                "flightOfferId": f"uuid-{i}",
                "duffelOfferId": f"duffel-{i}",
                "airline": "XX" if i == 1 else "VN",
                "departureAirport": "HAN",
                "arrivalAirport": "SGN",
                "departureTime": f"2026-07-15T{i:02d}:00:00Z",
                "arrivalTime": f"2026-07-15T{i + 2:02d}:00:00Z",
                "duration": 120,
                "stops": 0,
                "price": 100 * i,
                "currency": "USD",
            }
        )

    payload = {"mode": "RANKED", "results": results}
    result = project_flight_search_for_narration(payload)

    # Top 5 only
    assert "1. XX" in result
    assert "5." in result
    assert "6." not in result
    assert "7." not in result
