import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.runnables import RunnableConfig

from agent.models.snapshot import TrustedSearchSnapshot
from agent.repositories.trusted_snapshot_repository import TrustedSnapshotRepository
from agent.tools.nestjs_client import NestJSClient
from agent.tools.search_flights import project_snapshot_results, search_flights


class FakeAsyncRedis:
    """In-memory Async Redis mock for fast and isolated repository tests."""

    def __init__(self):
        self.store = {}
        self.ttls = {}

    async def set(self, key: str, value: str, ex: int = None):
        self.store[key] = value
        if ex is not None:
            self.ttls[key] = ex

    async def get(self, key: str):
        return self.store.get(key)

    async def delete(self, key: str):
        self.store.pop(key, None)
        self.ttls.pop(key, None)

    async def ttl(self, key: str):
        if key not in self.store:
            return -2
        return self.ttls.get(key, -1)


@pytest.mark.asyncio
async def test_nestjs_client_post_gateway_flights_search_v2():
    client = NestJSClient(
        base_url="http://localhost:3001/api",
        token="mock_user_token",
        correlation_id="corr-test-123",
        trace_id="trace-test-456",
    )

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "selectionAttestation": "sel_v1_signed-opaque",
        "snapshotVersion": 3,
        "snapshotExpiresAt": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
        "results": [
            {
                "flightOfferId": str(uuid.uuid4()),
                "duffelOfferId": "off_123",
                "offerExpiresAt": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
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
                "baggageAllowance": "1 checked bag",
            }
        ],
    }
    mock_response.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient.post", return_value=mock_response) as mock_post:
        result = await client.post_gateway_flights_search_v2(
            chat_session_id="session-123",
            proposed_snapshot_version=3,
            origin="SGN",
            destination="NRT",
            date="2026-09-20",
            passengers=2,
        )

        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        url = args[0] if args else kwargs.get("url")
        assert url.endswith("/agent-gateway/v2/flights/search")
        assert kwargs["json"]["chatSessionId"] == "session-123"
        assert kwargs["json"]["proposedSnapshotVersion"] == 3
        assert kwargs["json"]["search"]["origin"] == "SGN"
        assert kwargs["json"]["search"]["destination"] == "NRT"
        assert kwargs["json"]["search"]["date"] == "2026-09-20"
        assert kwargs["json"]["search"]["adults"] == 2

        # Verify authenticated headers
        headers = kwargs["headers"]
        assert "X-Agent-API-Key" in headers
        assert "X-User-Claim" in headers
        assert headers.get("X-Correlation-ID") == client.correlation_id
        assert headers.get("X-Trace-ID") == client.trace_id

        assert "selectionAttestation" in result
        assert result["snapshotVersion"] == 3


@pytest.mark.asyncio
async def test_nestjs_client_post_gateway_flights_search_v2_handles_400_error():
    client = NestJSClient(base_url="http://localhost:3001/api", token="mock_user_token")

    mock_response = MagicMock()
    mock_response.status_code = 400
    mock_response.json.return_value = {
        "statusCode": 400,
        "message": "I can currently only search economy class for adult passengers. For other cabin classes or passenger types, please use the search page.",
    }

    with patch("httpx.AsyncClient.post", return_value=mock_response):
        result = await client.post_gateway_flights_search_v2(
            chat_session_id="session-123",
            proposed_snapshot_version=1,
            origin="SGN",
            destination="NRT",
            date="2026-09-20",
            passengers=1,
        )
        assert "error" in result
        assert "I can currently only search economy class" in result["error"]


@pytest.mark.asyncio
async def test_nestjs_client_search_flights_v2_alias():
    client = NestJSClient(base_url="http://localhost:3001/api", token="mock_user_token")

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "selectionAttestation": "sel_v1_alias_test",
        "snapshotVersion": 1,
        "results": [],
    }
    mock_response.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient.post", return_value=mock_response) as mock_post:
        result = await client.search_flights_v2(
            chat_session_id="session-alias",
            proposed_snapshot_version=1,
            origin="HAN",
            destination="DAD",
            date="2026-09-21",
            passengers=1,
        )
        mock_post.assert_called_once()
        assert result["selectionAttestation"] == "sel_v1_alias_test"


@pytest.mark.asyncio
async def test_search_flights_strips_identifiers_and_saves_snapshot():
    config = RunnableConfig(
        configurable={"thread_id": "session-123", "user_id": "user-456", "token": "mock_token"}
    )

    mock_search_response = {
        "selectionAttestation": "sel_v1_signed-opaque",
        "snapshotVersion": 3,
        "snapshotExpiresAt": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
        "results": [
            {
                "flightOfferId": "local-uuid-1",
                "duffelOfferId": "provider-id-1",
                "offerExpiresAt": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
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
                "baggageAllowance": "1 checked bag",
            }
        ],
    }

    mock_client = MagicMock()
    mock_client.post_gateway_flights_search_v2 = AsyncMock(return_value=mock_search_response)
    mock_repo = MagicMock()
    mock_repo.get_snapshot = AsyncMock(return_value=None)
    mock_repo.save_snapshot = AsyncMock()

    with (
        patch("agent.tools.search_flights.get_nestjs_client", return_value=mock_client),
        patch("agent.tools.search_flights.get_redis_client", return_value=MagicMock()),
        patch("agent.tools.search_flights.TrustedSnapshotRepository", return_value=mock_repo),
    ):
        tool_result = await search_flights.ainvoke(
            {"origin": "SGN", "destination": "NRT", "date": "2026-09-20", "passengers": 1}, config
        )

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
        assert saved_snapshot.results[0].duffelOfferId == "provider-id-1"


@pytest.mark.asyncio
async def test_snapshot_overwrite_and_monotonic_version():
    fake_redis = FakeAsyncRedis()
    repo = TrustedSnapshotRepository(fake_redis)

    mock_client = MagicMock()

    # Simulate 3 sequential searches
    user_id = "user-mono-test"
    thread_id = "session-mono-test"
    config = RunnableConfig(
        configurable={"thread_id": thread_id, "user_id": user_id, "token": "mock_token"}
    )

    for step in range(1, 4):

        def make_search_response(version):
            return {
                "selectionAttestation": f"sel_v1_attestation_step_{version}",
                "snapshotVersion": version,
                "snapshotExpiresAt": (
                    datetime.now(timezone.utc) + timedelta(minutes=15)
                ).isoformat(),
                "results": [
                    {
                        "flightOfferId": f"local-uuid-{version}",
                        "duffelOfferId": f"provider-id-{version}",
                        "airline": "VN",
                        "flightNumber": f"VN{version}00",
                        "departureAirport": "SGN",
                        "arrivalAirport": "NRT",
                        "departureTime": "2026-09-20T02:00:00.000Z",
                        "arrivalTime": "2026-09-20T08:30:00.000Z",
                        "duration": 330,
                        "stops": 0,
                        "price": "420.00",
                        "currency": "USD",
                        "fareClass": "economy",
                        "baggageAllowance": "1 checked bag",
                    }
                ],
            }

        mock_client.post_gateway_flights_search_v2 = AsyncMock(
            return_value=make_search_response(step)
        )

        with (
            patch("agent.tools.search_flights.get_nestjs_client", return_value=mock_client),
            patch("agent.tools.search_flights.get_redis_client", return_value=fake_redis),
            patch("agent.tools.search_flights.TrustedSnapshotRepository", return_value=repo),
        ):
            await search_flights.ainvoke(
                {"origin": "SGN", "destination": "NRT", "date": "2026-09-20", "passengers": 1},
                config,
            )

            # Check gateway was called with proposed version == step
            mock_client.post_gateway_flights_search_v2.assert_called_once_with(
                chat_session_id=thread_id,
                proposed_snapshot_version=step,
                origin="SGN",
                destination="NRT",
                date="2026-09-20",
                passengers=1,
            )

            # Check snapshot in Redis is replaced with monotonic version
            saved = await repo.get_snapshot(user_id, thread_id)
            assert saved is not None
            assert saved.snapshotVersion == step
            assert saved.selectionAttestation == f"sel_v1_attestation_step_{step}"
            assert saved.results[0].flightOfferId == f"local-uuid-{step}"


@pytest.mark.asyncio
async def test_snapshot_ttl_calculation_and_expiry():
    fake_redis = FakeAsyncRedis()
    repo = TrustedSnapshotRepository(fake_redis)

    now = datetime.now(timezone.utc)

    # 1. Valid snapshot expiring in 600s
    snapshot_600 = TrustedSearchSnapshot.model_validate(
        {
            "schemaVersion": 1,
            "snapshotVersion": 1,
            "userId": "user-ttl-1",
            "sessionId": "session-ttl-1",
            "createdAt": now.isoformat(),
            "expiresAt": (now + timedelta(seconds=600)).isoformat(),
            "selectionAttestation": "sel_v1_ttl_test",
            "fingerprint": "mock_fp",
            "results": [
                {
                    "offerIndex": 1,
                    "flightOfferId": "uuid-1",
                    "duffelOfferId": "duff-1",
                    "airline": "VN",
                    "origin": "SGN",
                    "destination": "HAN",
                    "departureAt": (now + timedelta(days=1)).isoformat(),
                    "arrivalAt": (now + timedelta(days=1, hours=2)).isoformat(),
                    "price": "100.00",
                    "currency": "USD",
                }
            ],
        }
    )

    await repo.save_snapshot(snapshot_600)
    key = repo._get_key("user-ttl-1", "session-ttl-1")
    ttl = await fake_redis.ttl(key)
    assert 590 <= ttl <= 600

    # 2. Already-expired snapshot (expires in the past) -> not saved
    snapshot_past = TrustedSearchSnapshot.model_validate(
        {
            "schemaVersion": 1,
            "snapshotVersion": 1,
            "userId": "user-ttl-2",
            "sessionId": "session-ttl-2",
            "createdAt": (now - timedelta(minutes=30)).isoformat(),
            "expiresAt": (now - timedelta(minutes=5)).isoformat(),
            "selectionAttestation": "sel_v1_past",
            "fingerprint": "mock_fp",
            "results": [
                {
                    "offerIndex": 1,
                    "flightOfferId": "uuid-2",
                    "duffelOfferId": "duff-2",
                    "airline": "VN",
                    "origin": "SGN",
                    "destination": "HAN",
                    "departureAt": (now + timedelta(days=1)).isoformat(),
                    "arrivalAt": (now + timedelta(days=1, hours=2)).isoformat(),
                    "price": "100.00",
                    "currency": "USD",
                }
            ],
        }
    )

    await repo.save_snapshot(snapshot_past)
    assert await repo.get_snapshot("user-ttl-2", "session-ttl-2") is None

    # 3. Non-existent snapshot -> returns None
    assert await repo.get_snapshot("unknown-user", "unknown-session") is None


@pytest.mark.asyncio
async def test_snapshot_cross_user_and_session_isolation():
    fake_redis = FakeAsyncRedis()
    repo = TrustedSnapshotRepository(fake_redis)

    now = datetime.now(timezone.utc)
    snapshot = TrustedSearchSnapshot.model_validate(
        {
            "schemaVersion": 1,
            "snapshotVersion": 1,
            "userId": "user-alice",
            "sessionId": "session-alice-1",
            "createdAt": now.isoformat(),
            "expiresAt": (now + timedelta(minutes=15)).isoformat(),
            "selectionAttestation": "sel_v1_alice",
            "fingerprint": "mock_fp",
            "results": [
                {
                    "offerIndex": 1,
                    "flightOfferId": "uuid-alice-offer",
                    "duffelOfferId": "duff-alice",
                    "airline": "VN",
                    "origin": "SGN",
                    "destination": "HAN",
                    "departureAt": (now + timedelta(days=1)).isoformat(),
                    "arrivalAt": (now + timedelta(days=1, hours=2)).isoformat(),
                    "price": "150.00",
                    "currency": "USD",
                }
            ],
        }
    )

    await repo.save_snapshot(snapshot)

    # Alice in her own session can read
    loaded = await repo.get_snapshot("user-alice", "session-alice-1")
    assert loaded is not None
    assert loaded.userId == "user-alice"
    assert loaded.sessionId == "session-alice-1"

    # Bob cannot read Alice's snapshot even with same sessionId
    assert await repo.get_snapshot("user-bob", "session-alice-1") is None

    # Alice cannot read her snapshot with a different sessionId
    assert await repo.get_snapshot("user-alice", "session-alice-2") is None

    # Bob in Bob's session cannot read
    assert await repo.get_snapshot("user-bob", "session-bob-1") is None


@pytest.mark.asyncio
async def test_strict_privacy_no_identifiers_in_tool_output():
    config = RunnableConfig(
        configurable={
            "thread_id": "session-secret-thread-999",
            "user_id": "usr-secret-user-888",
            "token": "mock_token",
        }
    )

    offer_uuid_1 = "d3b07384-d113-40e1-bb44-486ff0086202"
    offer_uuid_2 = "e5a6f2c3-9b81-4321-a1b2-c3d4e5f6a7b8"
    duffel_id_1 = "off_0000A1b2C3d4E5f6G7h8"
    duffel_id_2 = "off_9999Z9y8X7w6V5u4T3s2"
    attestation = "sel_v1_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdHQiOiJzZWNyZXQifQ.sig123"

    mock_search_response = {
        "selectionAttestation": attestation,
        "snapshotVersion": 1,
        "snapshotExpiresAt": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
        "results": [
            {
                "flightOfferId": offer_uuid_1,
                "duffelOfferId": duffel_id_1,
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
                "baggageAllowance": "1 checked bag",
            },
            {
                "flightOfferId": offer_uuid_2,
                "duffelOfferId": duffel_id_2,
                "airline": "NH",
                "flightNumber": "NH892",
                "departureAirport": "HAN",
                "arrivalAirport": "HND",
                "departureTime": "2026-09-20T07:00:00.000Z",
                "arrivalTime": "2026-09-20T14:30:00.000Z",
                "duration": 330,
                "stops": 0,
                "price": "550.00",
                "currency": "USD",
                "fareClass": "economy",
                "baggageAllowance": "2 checked bags",
            },
        ],
    }

    mock_client = MagicMock()
    mock_client.post_gateway_flights_search_v2 = AsyncMock(return_value=mock_search_response)
    mock_repo = MagicMock()
    mock_repo.get_snapshot = AsyncMock(return_value=None)
    mock_repo.save_snapshot = AsyncMock()

    with (
        patch("agent.tools.search_flights.get_nestjs_client", return_value=mock_client),
        patch("agent.tools.search_flights.get_redis_client", return_value=MagicMock()),
        patch("agent.tools.search_flights.TrustedSnapshotRepository", return_value=mock_repo),
    ):
        tool_output = await search_flights.ainvoke(
            {"origin": "SGN", "destination": "NRT", "date": "2026-09-20", "passengers": 1}, config
        )

        # 1. Negative assertions: No UUIDs of any kind in the output string
        uuid_pattern = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
        assert re.search(uuid_pattern, tool_output, re.IGNORECASE) is None

        # 2. Negative assertions: No Duffel IDs or provider IDs
        assert offer_uuid_1 not in tool_output
        assert offer_uuid_2 not in tool_output
        assert duffel_id_1 not in tool_output
        assert duffel_id_2 not in tool_output
        assert "off_" not in tool_output

        # 3. Negative assertions: No selection attestations
        assert attestation not in tool_output
        assert "sel_v1_" not in tool_output

        # 4. Negative assertions: No user IDs or internal session IDs
        assert "usr-secret-user-888" not in tool_output
        assert "session-secret-thread-999" not in tool_output

        # 5. Positive assertions: Formatted human-readable output
        assert "1. Vietnam Airlines VN300" in tool_output
        assert "2. ANA NH892" in tool_output
        assert "Departs: 02:00 SGN → Arrives: 08:30 NRT" in tool_output
        assert "Price: $420.00 USD (Economy)" in tool_output
        assert "Price: $550.00 USD (Economy)" in tool_output


def test_project_snapshot_results_is_identifier_free():
    snapshot = TrustedSearchSnapshot.model_validate(
        {
            "schemaVersion": 1,
            "snapshotVersion": 3,
            "userId": "user-456",
            "sessionId": "session-123",
            "createdAt": "2026-09-20T00:00:00Z",
            "expiresAt": "2026-09-20T00:15:00Z",
            "fingerprint": "opaque-fingerprint",
            "selectionAttestation": "sel_v1_signed-opaque",
            "results": [
                {
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
                }
            ],
        }
    )

    projected = project_snapshot_results(snapshot)

    assert projected == [
        {
            "index": 1,
            "airline": "VN",
            "origin": "SGN",
            "destination": "NRT",
            "departureAt": "2026-09-20T02:00:00+00:00",
            "arrivalAt": "2026-09-20T08:30:00+00:00",
            "price": "420.00",
            "currency": "USD",
        }
    ]

    # Exhaustive negative check across serialized output
    projected_str = json.dumps(projected)
    assert "local-uuid-1" not in projected_str
    assert "provider-id-1" not in projected_str
    assert "sel_v1_signed-opaque" not in projected_str
    assert "user-456" not in projected_str
    assert "session-123" not in projected_str
    assert "opaque-fingerprint" not in projected_str
    assert "flightOfferId" not in projected_str
    assert "duffelOfferId" not in projected_str
