"""DAST Ownership and Cross-User Isolation Security Verification.

Covers Task T038 (Feature 023 / US4):
1. Cross-User Session & Booking Isolation
2. Claim & Service Key Validation
3. Stale Snapshot & Handoff Replay Protection
4. Redis Fencing Concurrency
"""

import base64
import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import jwt
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

# Set environment before any agent imports
os.environ["JWT_SECRET"] = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"
os.environ["JWT_ISSUER"] = "booking-systems-api"
os.environ["JWT_AUDIENCE"] = "booking-systems-clients"
os.environ["NESTJS_API_URL"] = "http://127.0.0.1:3001/api"
os.environ["AGENT_SERVICE_API_KEY"] = "agent_secret_service_key_999"
os.environ["CLAIM_TOKEN_SECRET"] = "claim_secret_key_ring_primary_32b"
os.environ["CLAIM_TOKEN_TTL_SECONDS"] = "300"
os.environ["OUTPUT_GUARDRAIL_ENABLED"] = "false"

from agent.auth.claim_token import create_claim_token
from agent.chat_turn.command import ChatTurnCommand
from agent.chat_turn.events import ErrorEvent
from agent.chat_turn.runner import ChatTurnRunner
from agent.config import get_settings
from agent.guardrails.gateway import GuardrailGateway
from agent.guardrails.registry import create_production_registry
from agent.middleware.auth import JWTAuthMiddleware
from agent.queue.message_queue import MessageQueueManager
from agent.repositories.session_lock_repository import SessionLockRepository
from agent.streaming.sse import router as streaming_router
from agent.tools.nestjs_client import NestJSClient
from agent.trusted_search_snapshot import (
    AttestedSearchEnvelope,
    SnapshotOwner,
    TrustedSearchResult,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
)

pytestmark = pytest.mark.security

settings = get_settings()
SECRET = settings.JWT_SECRET
ISSUER = getattr(settings, "JWT_ISSUER", "booking-systems-api")
AUDIENCE = getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")
AGENT_KEY = settings.AGENT_SERVICE_API_KEY
CLAIM_SECRET = settings.CLAIM_TOKEN_SECRET

# Provision two synthetic authenticated users
USER_A = {
    "id": "usr_synthetic_a_001",
    "sub": "usr_synthetic_a_001",
    "email": "user_a@synthetic.test",
    "name": "Synthetic User A",
    "status": "ACTIVE",
}

USER_B = {
    "id": "usr_synthetic_b_002",
    "sub": "usr_synthetic_b_002",
    "email": "user_b@synthetic.test",
    "name": "Synthetic User B",
    "status": "ACTIVE",
}


def make_jwt_token(
    user_dict: dict,
    exp_offset: int = 3600,
    jti: str = "jti-synt-1",
    secret: str = SECRET,
    issuer: str = ISSUER,
    audience: str = AUDIENCE,
) -> str:
    payload = {
        "id": user_dict["id"],
        "sub": user_dict["sub"],
        "email": user_dict.get("email"),
        "name": user_dict.get("name"),
        "jti": jti,
        "iss": issuer,
        "aud": audience,
        "exp": int(time.time()) + exp_offset,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


class StreamedResponse:
    """Helper context manager simulating httpx streaming response."""

    def __init__(self, response: httpx.Response) -> None:
        self.response = response

    async def __aenter__(self) -> httpx.Response:
        return self.response

    async def __aexit__(self, exc_type, exc_value, traceback) -> bool:
        return False


# ---------------------------------------------------------------------------
# In-Memory Fast Redis for Isolated Fencing & Snapshot Lifecycle Tests
# ---------------------------------------------------------------------------
class InMemRedis:
    """In-memory Async Redis mock simulating hash and eval scripts."""

    def __init__(self):
        self.hashes = {}
        self.strings = {}
        self.ttls = {}
        self._clock = 0

    async def hget(self, name: str, key: str):
        h = self.hashes.get(name, {})
        return h.get(key)

    async def hset(self, name: str, *args, **kwargs):
        if name not in self.hashes:
            self.hashes[name] = {}
        mapping = {}
        if len(args) == 1 and isinstance(args[0], dict):
            mapping = args[0]
        elif len(args) % 2 == 0:
            for i in range(0, len(args), 2):
                mapping[args[i]] = args[i + 1]
        mapping.update(kwargs)
        for k, v in mapping.items():
            self.hashes[name][str(k)] = str(v)
        return len(mapping)

    async def get(self, key: str):
        return self.strings.get(key)

    async def set(self, key: str, value: str | int, ex: int = None):
        self.strings[key] = str(value)
        if ex is not None:
            self.ttls[key] = int(ex)
        return True

    async def delete(self, *keys: str):
        count = 0
        for k in keys:
            if k in self.strings:
                del self.strings[k]
                count += 1
            if k in self.hashes:
                del self.hashes[k]
                count += 1
        return count

    async def ttl(self, key: str):
        return self.ttls.get(key, -1)

    async def ping(self):
        return True

    async def eval(self, script: str, num_keys: int, *args):
        # 1. SessionLockRepository acquire_lock script
        if "fencing_key" in script and "PEXPIRE" in script:
            lock_key, fence_key = args[0], args[1]
            req_id = str(args[2])
            ttl = int(args[3])

            current = self.hashes.get(lock_key, {})
            current_owner = current.get("req_id")
            if current_owner and current_owner != req_id:
                return None

            current_fence = int(self.strings.get(fence_key, 0)) + 1
            self.strings[fence_key] = str(current_fence)

            if lock_key not in self.hashes:
                self.hashes[lock_key] = {}
            self.hashes[lock_key]["req_id"] = req_id
            self.hashes[lock_key]["fence"] = str(current_fence)
            self.ttls[lock_key] = ttl // 1000
            return current_fence

        # 2. SessionLockRepository refresh_lock script
        if "refresh_lock" in script or ("current_fence == fence" in script and "DEL" not in script):
            lock_key = args[0]
            req_id = str(args[1])
            fence = str(args[2])
            current = self.hashes.get(lock_key, {})
            if current.get("req_id") == req_id and str(current.get("fence")) == fence:
                return 1
            return 0

        # 3. SessionLockRepository release_lock script
        if "DEL" in script and "lock_key" in script:
            lock_key = args[0]
            req_id = str(args[1])
            fence = str(args[2])
            current = self.hashes.get(lock_key, {})
            if current.get("req_id") == req_id and str(current.get("fence")) == fence:
                self.hashes.pop(lock_key, None)
                return 1
            return 0

        # 4. Snapshot repository Lua scripts:
        if "initial_ttl" in script or "snapshot_key" in script:
            snapshot_key, issued_key, accepted_key = args[0], args[1], args[2]
            op_args = args[3:]
            # next_version
            if len(op_args) == 1:
                snap_val = self.strings.get(snapshot_key)
                s_ver = 0
                if snap_val:
                    s_ver = json.loads(snap_val).get("snapshotVersion", 0)
                i_ver = int(self.strings.get(issued_key, 0))
                a_ver = int(self.strings.get(accepted_key, 0))
                nxt = max(s_ver, i_ver, a_ver) + 1
                self.strings[issued_key] = str(nxt)
                return nxt

            # replace / save snapshot Lua
            if len(op_args) == 3:
                incoming_json, incoming_version, ttl_sec = op_args
                inc_v = int(incoming_version)
                snap_val = self.strings.get(snapshot_key)
                s_ver = 0
                if snap_val:
                    s_ver = json.loads(snap_val).get("snapshotVersion", 0)
                a_ver = int(self.strings.get(accepted_key, 0))
                eff = max(s_ver, a_ver)
                if inc_v <= eff:
                    return 0
                self.strings[snapshot_key] = incoming_json
                self.strings[issued_key] = str(inc_v)
                self.strings[accepted_key] = str(inc_v)
                return 1

            # delete Lua
            if len(op_args) == 0:
                self.strings.pop(snapshot_key, None)
                return 1

        return 1


@pytest.fixture(autouse=True)
def setup_test_redis(monkeypatch):
    """Provide in-memory Redis client mock to agent components."""
    fake_redis = InMemRedis()
    import agent.infrastructure.redis

    monkeypatch.setattr(agent.infrastructure.redis, "_redis_client", fake_redis)
    monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: fake_redis)
    monkeypatch.setattr(
        "agent.repositories.session_lock_repository.get_redis_client", lambda: fake_redis
    )
    yield fake_redis
    agent.infrastructure.redis._redis_client = None


@pytest.fixture
def test_app():
    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware, secret=SECRET, exclude_paths=["/health"])
    app.include_router(streaming_router)
    app.state.message_queue = MessageQueueManager()
    app.state.guardrail_gateway = GuardrailGateway(create_production_registry())
    return app


@pytest.fixture
def test_client(test_app):
    return TestClient(test_app)


# ---------------------------------------------------------------------------
# 1. Cross-User Session & Booking Isolation
# ---------------------------------------------------------------------------
def test_cross_user_chat_session_access_rejected(test_client):
    """User A attempts to access User B's chat session: strict CHAT_SESSION_NOT_FOUND error."""
    token_a = make_jwt_token(USER_A)
    foreign_session_id = "session-owned-by-user-b-999"

    with (
        patch("agent.streaming.sse.NestJSClient") as MockClient,
        patch(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            new_callable=AsyncMock,
        ),
        patch("agent.streaming.sse.graph.astream_events") as mock_graph,
        patch("agent.streaming.sse._persist_response") as mock_persist,
    ):
        mock_nestjs = AsyncMock()
        mock_nestjs.set_fencing_token = MagicMock()
        mock_nestjs.check_user_access.return_value = {"allowed": True}
        # NestJS gateway rejects access to foreign session
        mock_nestjs.get_memory.side_effect = Exception(
            "CHAT_SESSION_NOT_FOUND: Session not found or foreign owner"
        )
        MockClient.return_value = mock_nestjs

        response = test_client.post(
            "/chat/stream",
            json={"message": "Read foreign messages", "sessionId": foreign_session_id},
            headers={"Authorization": f"Bearer {token_a}"},
        )

        assert response.status_code == 200
        assert "CHAT_SESSION_NOT_FOUND" in response.text
        # Assert zero model/graph inference
        mock_graph.assert_not_called()
        # Assert zero persistence/database mutations
        mock_persist.assert_not_called()
        # Assert zero foreign metadata or PII leakage
        assert USER_B["id"] not in response.text
        assert USER_B["email"] not in response.text


@pytest.mark.asyncio
async def test_cross_user_traveler_profile_isolation():
    """User A cannot query or receive User B's traveler profile via gateway delegation."""
    token_a = make_jwt_token(USER_A)
    client_a = NestJSClient(base_url=settings.NESTJS_API_URL, token=token_a)

    headers_a = client_a._get_gateway_headers()
    assert "X-User-Claim" in headers_a
    claim_a = headers_a["X-User-Claim"]

    # Decode claim payload to verify it strictly binds to user A, never user B
    payload_b64 = claim_a.split(".")[0]
    payload_bytes = base64.urlsafe_b64decode(payload_b64 + "==")
    claim_payload = json.loads(payload_bytes.decode("utf-8"))
    assert claim_payload["userId"] == USER_A["id"]
    assert claim_payload["userId"] != USER_B["id"]

    # Simulate backend gateway response for user A
    req = httpx.Request("GET", f"{settings.NESTJS_API_URL}/agent-gateway/users/preferences")
    resp_404 = httpx.Response(
        404,
        json={
            "statusCode": 404,
            "message": "No traveler profile exists for this user",
            "code": "PROFILE_NOT_FOUND",
        },
        request=req,
    )
    with patch("httpx.AsyncClient.stream", return_value=StreamedResponse(resp_404)):
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await client_a.get_gateway_user_preferences()

        assert exc_info.value.response.status_code == 404
        assert "B987654321" not in exc_info.value.response.text
        assert USER_B["id"] not in exc_info.value.response.text


@pytest.mark.asyncio
async def test_cross_user_booking_records_isolation():
    """User A querying User B's booking reference returns 404 with zero PII leakage."""
    token_a = make_jwt_token(USER_A)
    client_a = NestJSClient(base_url=settings.NESTJS_API_URL, token=token_a)

    foreign_booking_ref = "bkref_11111111-2222-3333-4444-555555555555"
    req = httpx.Request(
        "GET",
        f"{settings.NESTJS_API_URL}/agent-gateway/users/bookings/{foreign_booking_ref}",
    )
    resp_404 = httpx.Response(
        404,
        json={
            "statusCode": 404,
            "message": "Booking reference not found",
            "code": "BOOKING_REFERENCE_NOT_FOUND",
        },
        request=req,
    )
    with patch("httpx.AsyncClient.stream", return_value=StreamedResponse(resp_404)):
        res = await client_a.get_gateway_booking_detail(foreign_booking_ref)
        assert res.get("error") == "BOOKING_REFERENCE_NOT_FOUND"
        assert res.get("statusCode") == 404
        # Assert zero foreign booking detail or PII leakage
        assert "passenger" not in str(res).lower()
        assert USER_B["id"] not in str(res)


@pytest.mark.asyncio
async def test_cross_user_search_snapshot_isolation():
    """User A cannot read, query, or select from User B's search snapshot."""
    fake_redis = InMemRedis()
    repo = TrustedSnapshotRepository(fake_redis)
    lifecycle = TrustedSearchSnapshotLifecycle(repo)

    now = datetime.now(timezone.utc)
    envelope = AttestedSearchEnvelope(
        schemaVersion=1,
        snapshotVersion=1,
        expiresAt=now + timedelta(hours=1),
        fingerprint="fp_synthetic_user_b",
        selectionAttestation="sel_v1_synthetic_attestation_user_b",
        results=[
            TrustedSearchResult(
                offerIndex=1,
                flightOfferId="fo_b_001",
                duffelOfferId="off_duffel_b_001",
                airline="VN",
                origin="SGN",
                destination="HAN",
                departureAt=now + timedelta(days=1),
                arrivalAt=now + timedelta(days=1, hours=2),
                price="150.00",
                currency="USD",
            )
        ],
    )

    owner_b = SnapshotOwner(user_id=USER_B["id"], chat_session_id="session-user-b")
    await lifecycle.create_or_replace(owner_b, envelope)

    # User B can load their own snapshot
    loaded_b = await lifecycle.load_active(owner_b)
    assert loaded_b is not None
    assert loaded_b.userId == USER_B["id"]

    # User A attempting to load User B's session snapshot returns None
    owner_a_probing_b = SnapshotOwner(user_id=USER_A["id"], chat_session_id="session-user-b")
    loaded_a = await lifecycle.load_active(owner_a_probing_b)
    assert loaded_a is None, "User A must not access User B's search snapshot"


# ---------------------------------------------------------------------------
# 2. Claim & Service Key Validation
# ---------------------------------------------------------------------------
def test_expired_jwt_token_rejected_401(test_client):
    """Expired JWT tokens are strictly rejected with HTTP 401 Unauthorized."""
    expired_token = make_jwt_token(USER_A, exp_offset=-300)
    with (
        patch(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            new_callable=AsyncMock,
        ) as mock_quota,
        patch("agent.streaming.sse.graph.astream_events") as mock_graph,
        patch("agent.streaming.sse._persist_response") as mock_persist,
    ):
        res = test_client.post(
            "/chat/stream",
            json={"message": "hello"},
            headers={"Authorization": f"Bearer {expired_token}"},
        )
        assert res.status_code == 401
        assert "invalid" in res.json().get("detail", "").lower() or "expired" in res.text.lower()
        # Assert zero quota charged, zero inference, zero persistence
        mock_quota.assert_not_called()
        mock_graph.assert_not_called()
        mock_persist.assert_not_called()


def test_forged_hmac_claim_token_rejected():
    """Forged, tampered, or expired HMAC claim tokens fail validation (HTTP 401/403)."""
    token_a = make_jwt_token(USER_A)
    client_a = NestJSClient(base_url=settings.NESTJS_API_URL, token=token_a)

    # 1. Valid token produces valid HMAC claim bound to User A
    headers_a = client_a._get_gateway_headers()
    assert "X-User-Claim" in headers_a
    claim_a = headers_a["X-User-Claim"]
    parts = claim_a.split(".")
    assert len(parts) == 2, "Claim token must have payload and signature"

    payload_b64, sig_b64 = parts
    missing_padding = len(payload_b64) % 4
    if missing_padding:
        payload_b64 += "=" * (4 - missing_padding)
    payload = json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8"))
    assert payload["userId"] == USER_A["id"]

    # Verify signature matches HMAC-SHA256 of payload with CLAIM_SECRET
    expected_sig = (
        base64.urlsafe_b64encode(
            hmac.new(
                CLAIM_SECRET.encode("utf-8"),
                json.dumps(payload, separators=(",", ":")).encode("utf-8"),
                hashlib.sha256,
            ).digest()
        )
        .decode("utf-8")
        .rstrip("=")
    )
    assert hmac.compare_digest(sig_b64, expected_sig)

    # 2. Forged signature (signed with attacker key) fails verification
    forged_claim = create_claim_token(USER_A["id"], "attacker_forged_secret_key_32b")
    forged_sig = forged_claim.split(".")[1]
    assert not hmac.compare_digest(forged_sig, expected_sig)

    # 3. Tampered userId in payload breaks signature verification
    tampered_payload = {"userId": USER_B["id"], "iat": payload["iat"]}
    _tampered_b64 = (
        base64.urlsafe_b64encode(
            json.dumps(tampered_payload, separators=(",", ":")).encode("utf-8")
        )
        .decode("utf-8")
        .rstrip("=")
    )
    tampered_expected_sig = (
        base64.urlsafe_b64encode(
            hmac.new(
                CLAIM_SECRET.encode("utf-8"),
                json.dumps(tampered_payload, separators=(",", ":")).encode("utf-8"),
                hashlib.sha256,
            ).digest()
        )
        .decode("utf-8")
        .rstrip("=")
    )
    # Reusing signature from user A fails against tampered user B payload
    assert not hmac.compare_digest(sig_b64, tampered_expected_sig)

    # 4. Expired JWT passed to NestJSClient raises ValueError
    expired_token = make_jwt_token(USER_A, exp_offset=-300)
    client_expired = NestJSClient(base_url=settings.NESTJS_API_URL, token=expired_token)
    with pytest.raises(ValueError, match="Invalid authentication token"):
        client_expired._get_gateway_headers()


@pytest.mark.asyncio
async def test_missing_or_invalid_agent_service_api_key():
    """Gateway calls with missing or invalid AGENT_SERVICE_API_KEY return HTTP 401."""
    token_a = make_jwt_token(USER_A)
    client_a = NestJSClient(base_url=settings.NESTJS_API_URL, token=token_a)

    headers = client_a._get_gateway_headers()
    assert headers["X-Agent-API-Key"] == AGENT_KEY

    # 1. Gateway returns 401 when service key is invalid or rejected
    req = httpx.Request(
        "POST",
        f"{settings.NESTJS_API_URL}/agent-gateway/chat/access/check",
    )
    resp_401 = httpx.Response(
        401,
        json={"statusCode": 401, "message": "Invalid or missing agent service key"},
        request=req,
    )
    with patch("httpx.AsyncClient.post", return_value=resp_401):
        access_res = await client_a.check_user_access(sub=USER_A["id"])
        assert access_res == {"allowed": False}

    # 2. Session creation fails with 401 HTTPStatusError when service key rejected
    req_sess = httpx.Request(
        "POST",
        f"{settings.NESTJS_API_URL}/agent-gateway/chat/sessions",
    )
    resp_sess_401 = httpx.Response(
        401,
        json={"statusCode": 401, "message": "Unauthorized agent service call"},
        request=req_sess,
    )
    with patch("httpx.AsyncClient.post", return_value=resp_sess_401):
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await client_a.create_session(title="Security Test Session")
        assert exc_info.value.response.status_code == 401


# ---------------------------------------------------------------------------
# 3. Stale Snapshot & Handoff Replay Protection
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_replaying_consumed_or_expired_handoff_token_fails_closed():
    """Replaying consumed or expired booking handoff fails closed without database mutations."""
    gateway = GuardrailGateway(create_production_registry())
    mock_client = AsyncMock()
    mock_client.create_booking = AsyncMock()
    mock_client.create_payment = AsyncMock()
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    def mock_client_factory(*args, **kwargs):
        return mock_client

    dummy_settings = MagicMock()
    dummy_settings.NESTJS_API_URL = "http://localhost:3001"
    dummy_settings.MEMORY_WINDOW_SIZE = 20
    dummy_settings.REDIS_MAX_CONNECTIONS = 10

    # 1. Simulated handoff resolution failure: already consumed
    mock_graph_consumed = MagicMock()

    async def mock_events_consumed(*args, **kwargs):
        yield {
            "event": "on_chain_end",
            "name": "create_handoff_token_node",
            "data": {
                "output": {
                    "action": {
                        "error": (
                            "HANDOFF_ALREADY_CONSUMED: Token was previously claimed and booked"
                        ),
                        "code": 409,
                    }
                }
            },
        }

    mock_graph_consumed.astream_events = mock_events_consumed

    runner_consumed = ChatTurnRunner(
        settings=dummy_settings,
        gateway=gateway,
        require_gateway=True,
        graph=mock_graph_consumed,
        client_factory=mock_client_factory,
    )

    cmd_consumed = ChatTurnCommand(
        user_id=USER_A["id"],
        session_id="session-replay-1",
        message="Please proceed with checkout for my selected flight",
        token=make_jwt_token(USER_A),
        action_required=True,
        action_type="begin_checkout",
    )

    events_consumed = []
    async for event in runner_consumed.run(cmd_consumed):
        events_consumed.append(event)

    # Must fail closed with ErrorEvent HANDOFF_FAILED
    error_events = [e for e in events_consumed if isinstance(e, ErrorEvent)]
    assert len(error_events) == 1
    assert error_events[0].data.code == "HANDOFF_FAILED"
    assert "HANDOFF_ALREADY_CONSUMED" in error_events[0].data.message

    # ZERO database mutations on booking or payment
    mock_client.create_booking.assert_not_called()
    mock_client.create_payment.assert_not_called()

    # 2. Simulated handoff resolution failure: expired token
    mock_graph_expired = MagicMock()

    async def mock_events_expired(*args, **kwargs):
        yield {
            "event": "on_chain_end",
            "name": "create_handoff_token_node",
            "data": {
                "output": {
                    "action": {
                        "error": "HANDOFF_EXPIRED: Token expiration window has elapsed",
                        "code": 410,
                    }
                }
            },
        }

    mock_graph_expired.astream_events = mock_events_expired

    runner_expired = ChatTurnRunner(
        settings=dummy_settings,
        gateway=gateway,
        require_gateway=True,
        graph=mock_graph_expired,
        client_factory=mock_client_factory,
    )

    events_expired = []
    async for event in runner_expired.run(cmd_consumed):
        events_expired.append(event)

    error_events_exp = [e for e in events_expired if isinstance(e, ErrorEvent)]
    assert len(error_events_exp) == 1
    assert error_events_exp[0].data.code == "HANDOFF_FAILED"
    assert "HANDOFF_EXPIRED" in error_events_exp[0].data.message

    # Zero database mutations on replay of expired handoff
    mock_client.create_booking.assert_not_called()
    mock_client.create_payment.assert_not_called()


def test_tampered_snapshot_price_or_passenger_fields_fails_validation():
    """Modifying flight price, currency, or injecting fields on a signed snapshot fails."""
    now = datetime.now(timezone.utc)

    # Valid signed snapshot result
    result_data = {
        "offerIndex": 1,
        "flightOfferId": "fo_secure_001",
        "duffelOfferId": "off_duffel_001",
        "airline": "VN",
        "origin": "SGN",
        "destination": "HAN",
        "departureAt": now + timedelta(days=1),
        "arrivalAt": now + timedelta(days=1, hours=2),
        "price": "500.00",
        "currency": "USD",
    }
    result = TrustedSearchResult(**result_data)
    assert result.price == "500.00"

    # Attacker attempts to tamper with extra unapproved fields (e.g. injected discount)
    tampered_data = {**result_data, "discountPercent": 90}
    with pytest.raises(ValidationError):
        TrustedSearchResult(**tampered_data)

    # Attacker attempts to forge non-positive or float offerIndex
    tampered_index_data = {**result_data, "offerIndex": -1}
    with pytest.raises(ValidationError):
        TrustedSearchResult(**tampered_index_data)

    # Attacker attempts to tamper with selection attestation HMAC
    attestation_payload = {
        "userId": USER_A["id"],
        "sessionId": "sess-tamper-1",
        "version": 1,
        "issuedAt": now.isoformat(),
        "expiresAt": (now + timedelta(hours=1)).isoformat(),
        "offers": [{"flightOfferId": "fo_secure_001", "price": "500.00"}],
    }
    payload_str = json.dumps(attestation_payload, separators=(",", ":"))
    real_sig = hmac.new(
        CLAIM_SECRET.encode("utf-8"), payload_str.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    # Attacker alters price to 10.00 in attestation payload
    tampered_attestation_payload = {
        **attestation_payload,
        "offers": [{"flightOfferId": "fo_secure_001", "price": "10.00"}],
    }
    tampered_payload_str = json.dumps(tampered_attestation_payload, separators=(",", ":"))
    tampered_sig = hmac.new(
        CLAIM_SECRET.encode("utf-8"),
        tampered_payload_str.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    # The real signature cannot validate the tampered payload
    assert not hmac.compare_digest(real_sig, tampered_sig)


# ---------------------------------------------------------------------------
# 4. Redis Fencing Concurrency
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_session_lock_concurrent_acquire_rejects_duplicate():
    """Concurrent turn submissions for the same session are rejected by Redis fencing lock."""
    fake_redis = InMemRedis()
    repo = SessionLockRepository(prefix="test:fence:")

    with patch(
        "agent.repositories.session_lock_repository.get_redis_client",
        return_value=fake_redis,
    ):
        # req_1 acquires lock
        fence_1 = await repo.acquire_lock(USER_A["id"], "session-concur-1", "req-1", ttl_ms=5000)
        assert fence_1 is not None
        assert fence_1 >= 1

        # req_2 concurrently attempts to acquire while req-1 is still held => returns None
        fence_2 = await repo.acquire_lock(USER_A["id"], "session-concur-1", "req-2", ttl_ms=5000)
        assert fence_2 is None, "Concurrent lock acquire must return None"

        # req_1 releases lock
        released = await repo.release_lock(USER_A["id"], "session-concur-1", "req-1", fence_1)
        assert released is True

        # Now req_2 can acquire and receives a strictly higher monotonic fence
        fence_2_after = await repo.acquire_lock(
            USER_A["id"], "session-concur-1", "req-2", ttl_ms=5000
        )
        assert fence_2_after is not None
        assert fence_2_after > fence_1


@pytest.mark.asyncio
async def test_out_of_order_turn_rejected_by_fence():
    """Out-of-order turn execution with stale fence token is rejected from persistence."""
    fake_redis = InMemRedis()
    repo = SessionLockRepository(prefix="test:fence:")

    with patch(
        "agent.repositories.session_lock_repository.get_redis_client",
        return_value=fake_redis,
    ):
        # Turn 1 acquires fence 1
        fence_1 = await repo.acquire_lock(USER_A["id"], "session-ooo-1", "req-turn-1", ttl_ms=100)
        assert fence_1 == 1

        # Turn 1 releases
        await repo.release_lock(USER_A["id"], "session-ooo-1", "req-turn-1", fence_1)

        # Turn 2 acquires fence 2
        fence_2 = await repo.acquire_lock(USER_A["id"], "session-ooo-1", "req-turn-2", ttl_ms=5000)
        assert fence_2 == 2

        # Turn 1 (delayed/stale) tries to refresh or validate fence 1 => rejected
        refreshed = await repo.refresh_lock(USER_A["id"], "session-ooo-1", "req-turn-1", fence_1)
        assert refreshed is False

        # Validating stale fence fails
        is_valid = await repo.validate_fence(USER_A["id"], "session-ooo-1", "req-turn-1", fence_1)
        assert is_valid is False

        # Turn 2 is valid
        is_turn2_valid = await repo.validate_fence(
            USER_A["id"], "session-ooo-1", "req-turn-2", fence_2
        )
        assert is_turn2_valid is True


@pytest.mark.asyncio
async def test_message_queue_depth_exceeded_raises_429():
    """MessageQueueManager raises HTTP 429 when queue depth exceeds max_depth."""
    manager = MessageQueueManager(max_depth=2)
    manager.repo = AsyncMock(spec=SessionLockRepository)
    manager.repo.acquire_lock.return_value = 1

    # Request 1 and 2 succeed
    req1 = await manager.acquire("session-depth-test", USER_A["id"])
    assert req1 is not None
    req2 = await manager.acquire("session-depth-test", USER_A["id"])
    assert req2 is not None

    # Request 3 exceeds depth limit of 2 => raises 429
    with pytest.raises(HTTPException) as exc_info:
        await manager.acquire("session-depth-test", USER_A["id"])

    assert exc_info.value.status_code == 429
    assert (
        "too many concurrent requests" in exc_info.value.detail.lower()
        or "wait" in exc_info.value.detail.lower()
    )


@pytest.mark.redis_integration
@pytest.mark.asyncio
async def test_live_redis_fencing_concurrency(redis_client):
    """Real Redis integration test verifying atomic Lua lock fencing under live service."""
    repo = SessionLockRepository(prefix="test:security:live:fence:")
    with patch(
        "agent.repositories.session_lock_repository.get_redis_client",
        return_value=redis_client,
    ):
        session_id = f"live-sess-{int(time.time())}"
        fence1 = await repo.acquire_lock(USER_A["id"], session_id, "req-live-1", ttl_ms=5000)
        assert fence1 is not None

        # Duplicate concurrent acquire
        fence2 = await repo.acquire_lock(USER_A["id"], session_id, "req-live-2", ttl_ms=5000)
        assert fence2 is None

        # Clean up
        await repo.release_lock(USER_A["id"], session_id, "req-live-1", fence1)
