import pytest
import os
import json
import uuid
import datetime
import httpx
from unittest.mock import patch, MagicMock

from agent.tools.search_flights import project_snapshot_results, search_flights
from agent.models.snapshot import TrustedSearchSnapshot
from agent.tools.nestjs_client import NestJSClient
from agent.repositories.trusted_snapshot_repository import TrustedSnapshotRepository

@pytest.mark.asyncio
async def test_nestjs_client_post_gateway_flights_search_v2():
    client = NestJSClient(base_url="http://mock", token="mock_token", correlation_id="corr-123")
    
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "selectionAttestation": "sel_v1_signed-opaque",
        "snapshotVersion": 3,
        "snapshotExpiresAt": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=15)).isoformat(),
        "results": [
            {
                "flightOfferId": str(uuid.uuid4()),
                "duffelOfferId": "off_123",
                "offerExpiresAt": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=15)).isoformat(),
                "airline": "VN",
                "flightNumber": "VN300",
                "departureAirport": "SGN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-09-20T02:00:00.000Z",
                "arrivalTime": "2026-09-20T08:30:00.000Z",
                "duration": 330,
                "stops": 0,
                "price": "420.00",
                "currency": "USD",
                "fareClass": "economy",
                "baggageAllowance": "1 checked bag"
            }
        ]
    }
    mock_response.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient.post", return_value=mock_response) as mock_post:
        result = await client.post_gateway_flights_search_v2(
            chat_session_id="session-123",
            proposed_snapshot_version=3,
            origin="SGN",
            destination="NRT",
            date="2026-09-20",
            passengers=1
        )
        
        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        url = args[0] if args else kwargs.get("url")
        assert url.endswith("/agent-gateway/v2/flights/search")
        assert kwargs["json"]["chatSessionId"] == "session-123"
        assert kwargs["json"]["proposedSnapshotVersion"] == 3
        assert kwargs["json"]["search"]["origin"] == "SGN"
        
        assert "selectionAttestation" in result
        assert result["snapshotVersion"] == 3

@pytest.mark.asyncio
async def test_search_flights_strips_identifiers_and_saves_snapshot():
    config = {
        "configurable": {
            "thread_id": "session-123",
            "user_id": "user-456",
            "token": "mock_token"
        }
    }
    
    mock_search_response = {
        "selectionAttestation": "sel_v1_signed-opaque",
        "snapshotVersion": 3,
        "snapshotExpiresAt": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=15)).isoformat(),
        "results": [
            {
                "flightOfferId": "local-uuid-1",
                "duffelOfferId": "provider-id-1",
                "offerExpiresAt": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=15)).isoformat(),
                "airline": "VN",
                "flightNumber": "VN300",
                "departureAirport": "SGN",
                "arrivalAirport": "NRT",
                "departureTime": "2026-09-20T02:00:00.000Z",
                "arrivalTime": "2026-09-20T08:30:00.000Z",
                "duration": 330,
                "stops": 0,
                "price": "420.00",
                "currency": "USD",
                "fareClass": "economy",
                "baggageAllowance": "1 checked bag"
            }
        ]
    }

    from unittest.mock import AsyncMock
    mock_client = MagicMock()
    mock_client.post_gateway_flights_search_v2 = AsyncMock(return_value=mock_search_response)
    mock_repo = MagicMock()
    mock_repo.get_snapshot = AsyncMock(return_value=None)
    mock_repo.save_snapshot = AsyncMock()

    with patch("agent.tools.search_flights.get_nestjs_client", return_value=mock_client), \
         patch("agent.tools.search_flights.get_redis_client", return_value=MagicMock()), \
         patch("agent.tools.search_flights.TrustedSnapshotRepository", return_value=mock_repo):
             
        tool_result = await search_flights.ainvoke({
            "origin": "SGN", 
            "destination": "NRT", 
            "date": "2026-09-20", 
            "passengers": 1
        }, config)
        
        # Verify identifiers are stripped from LLM output
        assert "local-uuid-1" not in tool_result
        assert "provider-id-1" not in tool_result
        assert "sel_v1_signed-opaque" not in tool_result
        
        # Verify it saved the snapshot to Redis
        mock_repo.save_snapshot.assert_called_once()
        saved_snapshot = mock_repo.save_snapshot.call_args[0][0]
        assert saved_snapshot.snapshotVersion == 3
        assert saved_snapshot.selectionAttestation == "sel_v1_signed-opaque"
        assert len(saved_snapshot.results) == 1
        assert saved_snapshot.results[0].flightOfferId == "local-uuid-1"


def test_project_snapshot_results_is_identifier_free():
    snapshot = TrustedSearchSnapshot.model_validate({
        "schemaVersion": 1,
        "snapshotVersion": 3,
        "userId": "user-456",
        "sessionId": "session-123",
        "createdAt": "2026-09-20T00:00:00Z",
        "expiresAt": "2026-09-20T00:15:00Z",
        "fingerprint": "opaque-fingerprint",
        "selectionAttestation": "sel_v1_signed-opaque",
        "results": [{
            "offerIndex": 1,
            "flightOfferId": "local-uuid-1",
            "duffelOfferId": "provider-id-1",
            "airline": "VN",
            "origin": "SGN",
            "destination": "NRT",
            "departureAt": "2026-09-20T02:00:00Z",
            "arrivalAt": "2026-09-20T08:30:00Z",
            "price": "420.00",
            "currency": "USD",
        }],
    })

    projected = project_snapshot_results(snapshot)

    assert projected == [{
        "index": 1,
        "airline": "VN",
        "origin": "SGN",
        "destination": "NRT",
        "departureAt": "2026-09-20T02:00:00+00:00",
        "arrivalAt": "2026-09-20T08:30:00+00:00",
        "price": "420.00",
        "currency": "USD",
    }]
    assert "local-uuid-1" not in str(projected)
    assert "provider-id-1" not in str(projected)
    assert "sel_v1_signed-opaque" not in str(projected)
