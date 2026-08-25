from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from langchain_core.runnables import RunnableConfig

from agent.tools.booking_detail import get_booking_detail
from agent.tools.booking_summaries import list_user_booking_summaries


@pytest.fixture
def mock_client():
    client = MagicMock()
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
        }
    )


@pytest.mark.asyncio
async def test_list_user_booking_summaries_empty(mock_client, run_config):
    mock_client.get_gateway_user_booking_summaries.return_value = {"bookings": []}

    result = await list_user_booking_summaries.ainvoke({}, config=run_config)
    assert "No bookings found" in result or "You don't have any bookings" in result


@pytest.mark.asyncio
async def test_list_user_booking_summaries_single(mock_client, run_config):
    mock_client.get_gateway_user_booking_summaries.return_value = {
        "bookings": [
            {
                "bookingReference": "bkref_12345",
                "airline": "VN",
                "origin": "SGN",
                "destination": "NRT",
                "departureTime": "2026-09-20T02:00:00.000Z",
                "arrivalTime": "2026-09-20T08:30:00.000Z",
                "status": "CONFIRMED",
                "durationMinutes": 330,
                "stops": 0,
            }
        ]
    }

    result = await list_user_booking_summaries.ainvoke({}, config=run_config)

    assert "bkref_12345" in result
    assert "CONFIRMED" in result
    assert "VN" in result
    assert "SGN" in result
    assert "NRT" in result
    assert "2026-09-20T02:00:00.000Z" in result or "02:00" in result
    assert "2026-09-20T08:30:00.000Z" in result or "08:30" in result
    assert "330" in result or "5h 30m" in result
    assert "0" in result or "Direct" in result or "non-stop" in result.lower()


@pytest.mark.asyncio
async def test_list_user_booking_summaries_multiple(mock_client, run_config):
    mock_client.get_gateway_user_booking_summaries.return_value = {
        "bookings": [
            {
                "bookingReference": "bkref_11111",
                "airline": "VN",
                "origin": "SGN",
                "destination": "NRT",
                "departureTime": "2026-09-20T02:00:00.000Z",
                "arrivalTime": "2026-09-20T08:30:00.000Z",
                "status": "CONFIRMED",
                "durationMinutes": 330,
                "stops": 0,
            },
            {
                "bookingReference": "bkref_22222",
                "airline": "JL",
                "origin": "HAN",
                "destination": "HND",
                "departureTime": "2026-09-22T08:00:00.000Z",
                "arrivalTime": "2026-09-22T15:00:00.000Z",
                "status": "CONFIRMED",
                "durationMinutes": 300,
                "stops": 0,
            },
            {
                "bookingReference": "bkref_33333",
                "airline": "SQ",
                "origin": "SGN",
                "destination": "SIN",
                "departureTime": "2026-09-25T10:00:00.000Z",
                "arrivalTime": "2026-09-25T13:00:00.000Z",
                "status": "CANCELLED",
                "durationMinutes": 120,
                "stops": 0,
            },
        ]
    }

    result = await list_user_booking_summaries.ainvoke({}, config=run_config)

    assert "bkref_11111" in result
    assert "bkref_22222" in result
    assert "bkref_33333" in result


@pytest.mark.asyncio
async def test_list_user_booking_summaries_privacy_negative(mock_client, run_config):
    mock_client.get_gateway_user_booking_summaries.return_value = {
        "bookings": [
            {
                "bookingReference": "bkref_12345",
                "airline": "VN",
                "origin": "SGN",
                "destination": "NRT",
                "departureTime": "2026-09-20T02:00:00.000Z",
                "arrivalTime": "2026-09-20T08:30:00.000Z",
                "status": "CONFIRMED",
                "durationMinutes": 330,
                "stops": 0,
            }
        ]
    }

    result = await list_user_booking_summaries.ainvoke({}, config=run_config)
    lower_res = result.lower()

    forbidden = [
        "price",
        "usd",
        "vnd",
        "currency",
        "pnr",
        "passenger",
        "passport",
        "payment",
        "database id",
        "credit_card",
        "stripe",
    ]
    for term in forbidden:
        assert term not in lower_res, (
            f"Forbidden term '{term}' found in booking summary output: {result}"
        )


@pytest.mark.asyncio
async def test_list_user_booking_summaries_error_degradation(mock_client, run_config):
    mock_client.get_gateway_user_booking_summaries.side_effect = Exception(
        "Internal DB Connection Timeout"
    )

    result = await list_user_booking_summaries.ainvoke({}, config=run_config)

    assert (
        "failed" in result.lower()
        or "error" in result.lower()
        or "couldn't" in result.lower()
        or "unavailable" in result.lower()
    )
    assert "Internal DB Connection Timeout" not in result
    assert "Traceback" not in result


@pytest.mark.asyncio
async def test_get_booking_detail_success(mock_client, run_config):
    mock_client.get_gateway_booking_detail.return_value = {
        "bookingReference": "bkref_12345",
        "airline": "VN",
        "origin": "SGN",
        "destination": "NRT",
        "departureTime": "2026-09-20T02:00:00.000Z",
        "arrivalTime": "2026-09-20T08:30:00.000Z",
        "status": "CONFIRMED",
        "durationMinutes": 330,
        "stops": 0,
        "flightNumber": "VN300",
        "baggageAllowance": "1 checked bag",
        "changeable": True,
        "refundable": False,
    }

    result = await get_booking_detail.ainvoke(
        {"booking_reference": "bkref_12345"}, config=run_config
    )

    assert "bkref_12345" in result
    assert "VN300" in result
    assert "1 checked bag" in result
    assert "Changeable: True" in result or "changeable" in result.lower()
    assert "Refundable: False" in result or "refundable" in result.lower()


@pytest.mark.asyncio
async def test_get_booking_detail_not_found(mock_client, run_config):
    req = httpx.Request("GET", "http://localhost:3001/api/agent-gateway/users/bookings/bkref_99999")
    resp = httpx.Response(
        404, json={"error": "BOOKING_REFERENCE_NOT_FOUND", "statusCode": 404}, request=req
    )
    mock_client.get_gateway_booking_detail.side_effect = httpx.HTTPStatusError(
        "Not Found", request=req, response=resp
    )

    result = await get_booking_detail.ainvoke(
        {"booking_reference": "bkref_99999"}, config=run_config
    )

    assert "not found" in result.lower() or "no booking found" in result.lower()


@pytest.mark.asyncio
async def test_get_booking_detail_malformed_reference(mock_client, run_config):
    result = await get_booking_detail.ainvoke(
        {"booking_reference": "invalid_ref_no_prefix"}, config=run_config
    )

    assert (
        "invalid" in result.lower() or "malformed" in result.lower() or "format" in result.lower()
    )
    mock_client.get_gateway_booking_detail.assert_not_called()

    mock_client.reset_mock()
    result_empty = await get_booking_detail.ainvoke({"booking_reference": ""}, config=run_config)
    assert (
        "invalid" in result_empty.lower()
        or "required" in result_empty.lower()
        or "malformed" in result_empty.lower()
    )
    mock_client.get_gateway_booking_detail.assert_not_called()


@pytest.mark.asyncio
async def test_get_booking_detail_privacy_negative(mock_client, run_config):
    mock_client.get_gateway_booking_detail.return_value = {
        "bookingReference": "bkref_12345",
        "airline": "VN",
        "origin": "SGN",
        "destination": "NRT",
        "departureTime": "2026-09-20T02:00:00.000Z",
        "arrivalTime": "2026-09-20T08:30:00.000Z",
        "status": "CONFIRMED",
        "durationMinutes": 330,
        "stops": 0,
        "flightNumber": "VN300",
        "baggageAllowance": "1 checked bag",
        "changeable": True,
        "refundable": False,
    }

    result = await get_booking_detail.ainvoke(
        {"booking_reference": "bkref_12345"}, config=run_config
    )
    lower_res = result.lower()

    forbidden = [
        "price",
        "usd",
        "vnd",
        "currency",
        "pnr",
        "passenger",
        "passport",
        "payment",
        "database id",
        "credit_card",
        "stripe",
        "cvv",
    ]
    for term in forbidden:
        assert term not in lower_res, (
            f"Forbidden term '{term}' found in booking detail output: {result}"
        )


@pytest.mark.asyncio
async def test_get_booking_detail_error_degradation(mock_client, run_config):
    mock_client.get_gateway_booking_detail.side_effect = Exception("Gateway connection error 500")

    result = await get_booking_detail.ainvoke(
        {"booking_reference": "bkref_12345"}, config=run_config
    )

    assert (
        "failed" in result.lower()
        or "error" in result.lower()
        or "couldn't" in result.lower()
        or "unavailable" in result.lower()
    )
    assert "500" not in result
    assert "Traceback" not in result
