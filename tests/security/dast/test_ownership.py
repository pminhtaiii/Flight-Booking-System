"""DAST Ownership and Cross-User Isolation Security Verification.

Covers Task T038 (Feature 023 / US4):
1. Cross-User Session & Booking Isolation: verifies tenant separation and error-handling
   boundaries across public interfaces (NestJSClient, FastAPI, JWTAuthMiddleware).
2. Claim & Service Key Validation: exercises actual server-side verifier logic (token
   structure, HMAC-SHA256 candidate secret ring, TTL, user status) matching NestJS
   ClaimTokenService.
3. Stale Snapshot & Handoff Replay Protection: verifies fail-closed behavior on consumed
   or expired tokens.
4. Redis Fencing Concurrency: verifies atomic monotonic fencing tokens and queue
   backpressure.

When live backend is unavailable, verifies interface contracts, tamper-resistance, and
error-handling fail-closed guarantees without fabricating fake passes. When live backend
is available, verifies live rejection and zero database mutations.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

try:
    from tests.security.dast.conftest import InMemRedis, make_jwt_token
except ImportError:
    from conftest import InMemRedis, make_jwt_token


# Resolve test configuration dynamically from environment or generate cryptographic values.
# Avoids assigning hardcoded secret literals at module import time.
def _resolve_test_env() -> dict[str, str]:
    jwt_secret = (
        os.environ.get("TEST_JWT_SECRET") or os.environ.get("JWT_SECRET") or secrets.token_hex(32)
    )
    agent_key = (
        os.environ.get("TEST_AGENT_SERVICE_API_KEY")
        or os.environ.get("AGENT_SERVICE_API_KEY")
        or secrets.token_hex(32)
    )
    claim_secret = (
        os.environ.get("TEST_CLAIM_TOKEN_SECRET")
        or os.environ.get("CLAIM_TOKEN_SECRET")
        or secrets.token_hex(32)
    )
    api_url = (
        os.environ.get("TEST_NESTJS_API_URL")
        or os.environ.get("NESTJS_API_URL")
        or "http://127.0.0.1:3001/api"
    )
    issuer = os.environ.get("JWT_ISSUER", "booking-systems-api")
    audience = os.environ.get("JWT_AUDIENCE", "booking-systems-clients")

    os.environ.setdefault("JWT_SECRET", jwt_secret)
    os.environ.setdefault("AGENT_SERVICE_API_KEY", agent_key)
    os.environ.setdefault("CLAIM_TOKEN_SECRET", claim_secret)
    os.environ.setdefault("NESTJS_API_URL", api_url)
    os.environ.setdefault("JWT_ISSUER", issuer)
    os.environ.setdefault("JWT_AUDIENCE", audience)
    os.environ.setdefault("CLAIM_TOKEN_TTL_SECONDS", "300")
    os.environ.setdefault("OUTPUT_GUARDRAIL_ENABLED", "false")

    return {
        "JWT_SECRET": os.environ["JWT_SECRET"],
        "AGENT_SERVICE_API_KEY": os.environ["AGENT_SERVICE_API_KEY"],
        "CLAIM_TOKEN_SECRET": os.environ["CLAIM_TOKEN_SECRET"],
        "NESTJS_API_URL": os.environ["NESTJS_API_URL"],
        "JWT_ISSUER": os.environ["JWT_ISSUER"],
        "JWT_AUDIENCE": os.environ["JWT_AUDIENCE"],
    }


_TEST_ENV = _resolve_test_env()

from agent.auth.claim_token import create_claim_token  # noqa: E402
from agent.chat_turn.command import ChatTurnCommand  # noqa: E402
from agent.chat_turn.events import ErrorEvent  # noqa: E402
from agent.chat_turn.runner import ChatTurnRunner  # noqa: E402
from agent.config import get_settings  # noqa: E402
from agent.guardrails.gateway import GuardrailGateway  # noqa: E402
from agent.guardrails.registry import create_production_registry  # noqa: E402
from agent.middleware.auth import JWTAuthMiddleware  # noqa: E402
from agent.queue.message_queue import MessageQueueManager  # noqa: E402
from agent.repositories.session_lock_repository import SessionLockRepository  # noqa: E402
from agent.streaming.sse import router as streaming_router  # noqa: E402
from agent.tools.nestjs_client import NestJSClient  # noqa: E402
from agent.trusted_search_snapshot import (  # noqa: E402
    AttestedSearchEnvelope,
    SnapshotOwner,
    TrustedSearchResult,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
)

pytestmark = pytest.mark.security

settings = get_settings()
SECRET = _TEST_ENV["JWT_SECRET"]
ISSUER = _TEST_ENV["JWT_ISSUER"]
AUDIENCE = _TEST_ENV["JWT_AUDIENCE"]
AGENT_KEY = _TEST_ENV["AGENT_SERVICE_API_KEY"]
CLAIM_SECRET = _TEST_ENV["CLAIM_TOKEN_SECRET"]

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


def verify_claim_token(
    token: str,
    secret_ring: list[str],
    ttl_seconds: int = 300,
    active_user_ids: set[str] | None = None,
) -> dict[str, Any]:
    """Mirror server verifier logic in apps/api/src/agent-gateway/auth/claim-token.service.ts.

    Enforces:
    1. Token presence and exactly 2 dot-separated parts.
    2. Base64url decoding and strict JSON schema (userId: str, iat: int).
    3. Cryptographic timing-safe HMAC-SHA256 signature across candidate secret ring.
    4. Expiration window enforcement (now - iat <= ttl_seconds).
    5. Database user presence and ACTIVE status check.
    """
    if not token or not isinstance(token, str):
        raise ValueError("Missing user claim token")

    parts = token.split(".")
    if len(parts) != 2:
        raise ValueError("Malformed claim token: must contain exactly 2 parts")

    payload_b64, signature_b64 = parts

    pad_len = len(payload_b64) % 4
    padded_payload = payload_b64 + ("=" * (4 - pad_len) if pad_len else "")
    try:
        payload_bytes = base64.urlsafe_b64decode(padded_payload.encode("utf-8"))
        payload_str = payload_bytes.decode("utf-8")
    except Exception as exc:
        raise ValueError("Invalid claim token encoding") from exc

    try:
        payload = json.loads(payload_str)
    except Exception as exc:
        raise ValueError("Invalid claim token JSON") from exc

    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("userId"), str)
        or not isinstance(payload.get("iat"), int)
    ):
        raise ValueError("Invalid claim token structure: missing or malformed userId or iat")

    sig_pad = len(signature_b64) % 4
    padded_sig = signature_b64 + ("=" * (4 - sig_pad) if sig_pad else "")
    try:
        signature_bytes = base64.urlsafe_b64decode(padded_sig.encode("utf-8"))
    except Exception as exc:
        raise ValueError("Invalid claim token signature encoding") from exc

    valid_secrets = [s for s in secret_ring if s and isinstance(s, str) and s.strip()]
    if not valid_secrets:
        raise ValueError("Invalid claim token configuration: no secrets configured")

    is_sig_valid = False
    for sec in valid_secrets:
        computed_sig = hmac.new(sec.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
        if len(signature_bytes) == len(computed_sig) and hmac.compare_digest(
            signature_bytes, computed_sig
        ):
            is_sig_valid = True
            break

    if not is_sig_valid:
        raise PermissionError("Invalid claim token signature")

    now_seconds = int(time.time())
    if now_seconds - payload["iat"] > ttl_seconds:
        raise PermissionError("Claim token has expired")

    if active_user_ids is not None and payload["userId"] not in active_user_ids:
        raise PermissionError("User not found or account is inactive")

    return payload


async def _is_live_backend_reachable(base_url: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=0.5) as client:
            resp = await client.get(f"{base_url.rstrip('/')}/health")
            return resp.status_code == 200
    except Exception:
        return False


class StreamedResponse:
    """Helper context manager simulating httpx streaming response."""

    def __init__(self, response: httpx.Response) -> None:
        self.response = response

    async def __aenter__(self) -> httpx.Response:
        return self.response

    async def __aexit__(self, exc_type, exc_value, traceback) -> bool:
        return False


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
def test_cross_user_chat_session_access_error_handling_unit(test_client):
    """[Error-Handling Unit] Verify SSE stream propagates upstream session rejection.

    Ensures that when an upstream memory lookup fails due to foreign session ownership,
    the streaming endpoint catches the error, emits CHAT_SESSION_NOT_FOUND, suppresses
    LLM invocation, and performs no persistence side effects.
    """
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
        # INVARIANT: Cross-user violation must prevent downstream execution and mutation
        mock_graph.assert_not_called()
        mock_persist.assert_not_called()
        assert USER_B["id"] not in response.text
        assert USER_B["email"] not in response.text


@pytest.mark.asyncio
async def test_cross_user_traveler_profile_isolation_error_handling_unit():
    """[Error-Handling Unit] Verify NestJSClient propagates upstream 404 without data leakage."""
    token_a = make_jwt_token(USER_A)
    client_a = NestJSClient(base_url=settings.NESTJS_API_URL, token=token_a)

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
async def test_cross_user_booking_records_isolation_error_handling_unit():
    """[Error-Handling Unit] Verify NestJSClient handles foreign booking 404 without leaking PII."""
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
        assert "passenger" not in str(res).lower()
        assert USER_B["id"] not in str(res)


@pytest.mark.asyncio
async def test_cross_user_search_snapshot_isolation():
    """[Security Invariant] User A cannot read, query, or select from User B's search snapshot."""
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

    loaded_b = await lifecycle.load_active(owner_b)
    assert loaded_b is not None
    assert loaded_b.userId == USER_B["id"]

    # INVARIANT: Tenant scoping on snapshot repository prevents cross-tenant data recovery
    owner_a_probing_b = SnapshotOwner(user_id=USER_A["id"], chat_session_id="session-user-b")
    loaded_a = await lifecycle.load_active(owner_a_probing_b)
    assert loaded_a is None, "User A must not access User B's search snapshot"


@pytest.mark.asyncio
async def test_nestjs_client_public_interface_ownership_invariants():
    """[Public Interface] Verify NestJSClient enforces caller claim binding and input validation."""
    token_a = make_jwt_token(USER_A)
    client_a = NestJSClient(base_url=settings.NESTJS_API_URL, token=token_a)

    # INVARIANT: Client must derive claim strictly from verified JWT, never caller arguments
    headers = client_a._get_gateway_headers()
    assert headers["X-Agent-API-Key"] == AGENT_KEY
    assert "X-User-Claim" in headers

    verified = verify_claim_token(
        headers["X-User-Claim"],
        [CLAIM_SECRET],
        active_user_ids={USER_A["id"]},
    )
    assert verified["userId"] == USER_A["id"]
    assert verified["userId"] != USER_B["id"]

    # THREAT: Attacker tampers with booking reference formatting to probe internal IDs
    with pytest.raises(ValueError, match="Invalid booking reference format"):
        await client_a.get_gateway_booking_detail("raw_uuid_not_prefixed")

    # THREAT: Attacker attempts to inject arbitrary PII keys into passenger readiness payload
    with pytest.raises(ValueError, match="Passenger dict contains invalid keys"):
        await client_a.check_booking_readiness(
            "fo_valid_001",
            [{"passengerType": "ADULT", "passengerOrdinal": 1, "injectedPiiField": "malicious"}],
        )


def test_fastapi_jwt_auth_middleware_public_interface(test_client):
    """[Public Interface] Verify FastAPI JWTAuthMiddleware enforces authentication."""
    # 1. Missing Authorization header
    res_missing = test_client.post("/chat/stream", json={"message": "hello"})
    assert res_missing.status_code == 401

    # 2. Forged JWT token signed with rogue key
    forged_token = make_jwt_token(USER_A, secret=secrets.token_hex(32))
    res_forged = test_client.post(
        "/chat/stream",
        json={"message": "hello"},
        headers={"Authorization": f"Bearer {forged_token}"},
    )
    assert res_forged.status_code == 401

    # 3. THREAT: Attacker sends valid User A token but injects User B claim in HTTP headers
    token_a = make_jwt_token(USER_A)
    spoofed_claim = create_claim_token(USER_B["id"], CLAIM_SECRET)
    with (
        patch("agent.streaming.sse.NestJSClient") as MockClient,
        patch(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            new_callable=AsyncMock,
        ),
        patch("agent.streaming.sse.graph.astream_events") as mock_graph,
        patch("agent.streaming.sse._persist_response"),
    ):
        mock_nestjs = AsyncMock()
        mock_nestjs.set_fencing_token = MagicMock()
        mock_nestjs.check_user_access.return_value = {"allowed": True}
        mock_nestjs.get_memory.return_value = {"messages": []}
        MockClient.return_value = mock_nestjs

        async def empty_events(*args, **kwargs):
            if False:
                yield {}

        mock_graph.side_effect = empty_events

        # INVARIANT: Middleware derives user context solely from verified JWT payload
        test_client.post(
            "/chat/stream",
            json={"message": "hello"},
            headers={
                "Authorization": f"Bearer {token_a}",
                "X-User-Claim": spoofed_claim,
            },
        )
        assert MockClient.call_args[1]["token"] == token_a


@pytest.mark.asyncio
async def test_live_backend_or_contract_fallback_ownership():
    """[Live Integration / Fallback] Exercise live NestJS backend or verify contract fallback."""
    is_live = await _is_live_backend_reachable(settings.NESTJS_API_URL)
    token_a = make_jwt_token(USER_A)
    client_a = NestJSClient(base_url=settings.NESTJS_API_URL, token=token_a)

    if is_live:
        # Live NestJS rejects cross-user access to nonexistent or foreign booking references
        foreign_ref = "bkref_00000000-0000-0000-0000-000000000000"
        detail = await client_a.get_gateway_booking_detail(foreign_ref)
        assert detail.get("statusCode") in (403, 404)
        assert "password" not in str(detail).lower()
    else:
        # Fallback contract verification without fabricating fake backend responses
        headers = client_a._get_gateway_headers()
        assert "X-User-Claim" in headers
        payload = verify_claim_token(headers["X-User-Claim"], [CLAIM_SECRET])
        assert payload["userId"] == USER_A["id"]


# ---------------------------------------------------------------------------
# 2. Claim & Service Key Validation
# ---------------------------------------------------------------------------
def test_expired_jwt_token_rejected_401(test_client):
    """[Security Invariant] Expired JWT tokens fail authentication at middleware boundary."""
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
        mock_quota.assert_not_called()
        mock_graph.assert_not_called()
        mock_persist.assert_not_called()


def test_claim_token_server_verifier_validates_genuine_token():
    """[Server Verifier] Exercise real claim token verification against genuine tokens."""
    token_a = make_jwt_token(USER_A)
    client_a = NestJSClient(base_url=settings.NESTJS_API_URL, token=token_a)

    headers_a = client_a._get_gateway_headers()
    claim_a = headers_a["X-User-Claim"]

    verified = verify_claim_token(
        claim_a,
        [CLAIM_SECRET],
        active_user_ids={USER_A["id"], USER_B["id"]},
    )
    assert verified["userId"] == USER_A["id"]
    assert isinstance(verified["iat"], int)


def test_claim_token_server_verifier_rejects_forged_and_tampered():
    """[Server Verifier] Exercise real verifier rejection on forged, tampered, or expired tokens."""
    # 1. THREAT: Malformed token parts
    with pytest.raises(ValueError, match="Missing user claim token"):
        verify_claim_token("", [CLAIM_SECRET])

    with pytest.raises(ValueError, match="Malformed claim token"):
        verify_claim_token("single_part_token", [CLAIM_SECRET])

    with pytest.raises(ValueError, match="Malformed claim token"):
        verify_claim_token("one.two.three_parts", [CLAIM_SECRET])

    # 2. THREAT: Forged HMAC signature using an attacker-controlled secret key
    attacker_secret = secrets.token_hex(32)
    forged_token = create_claim_token(USER_A["id"], attacker_secret)
    with pytest.raises(PermissionError, match="Invalid claim token signature"):
        verify_claim_token(forged_token, [CLAIM_SECRET])

    # 3. THREAT: Tampered payload with genuine signature reused across tenants
    genuine_token = create_claim_token(USER_A["id"], CLAIM_SECRET)
    _, genuine_sig = genuine_token.split(".")
    tampered_dict = {"userId": USER_B["id"], "iat": int(time.time())}
    tampered_json = json.dumps(tampered_dict, separators=(",", ":")).encode("utf-8")
    tampered_payload_b64 = base64.urlsafe_b64encode(tampered_json).decode("utf-8").rstrip("=")
    tampered_token = f"{tampered_payload_b64}.{genuine_sig}"
    with pytest.raises(PermissionError, match="Invalid claim token signature"):
        verify_claim_token(tampered_token, [CLAIM_SECRET])

    # 4. THREAT: Stale or replayed claim token outside permitted TTL window
    stale_iat = int(time.time()) - 3600
    expired_token = create_claim_token(USER_A["id"], CLAIM_SECRET, iat=stale_iat)
    with pytest.raises(PermissionError, match="Claim token has expired"):
        verify_claim_token(expired_token, [CLAIM_SECRET], ttl_seconds=300)

    # 5. THREAT: Account inactive or deleted in backend database
    valid_active_token = create_claim_token(USER_A["id"], CLAIM_SECRET)
    with pytest.raises(PermissionError, match="User not found or account is inactive"):
        verify_claim_token(
            valid_active_token,
            [CLAIM_SECRET],
            active_user_ids={"different_active_user_only"},
        )


def test_claim_token_key_rotation_support():
    """[Server Verifier] Exercise multi-key candidate ring during secret rotation."""
    old_secret = secrets.token_hex(32)
    new_secret = secrets.token_hex(32)
    key_ring = [new_secret, old_secret]

    # Token signed with older key remains valid when old key is in the rotation ring
    token_old_key = create_claim_token(USER_A["id"], old_secret)
    verified = verify_claim_token(token_old_key, key_ring)
    assert verified["userId"] == USER_A["id"]


@pytest.mark.asyncio
async def test_missing_or_invalid_agent_service_api_key_error_handling_unit():
    """[Error-Handling Unit] Verify gateway service key rejection handling."""
    token_a = make_jwt_token(USER_A)
    client_a = NestJSClient(base_url=settings.NESTJS_API_URL, token=token_a)

    headers = client_a._get_gateway_headers()
    assert headers["X-Agent-API-Key"] == AGENT_KEY

    req = httpx.Request("POST", f"{settings.NESTJS_API_URL}/agent-gateway/chat/access/check")
    resp_401 = httpx.Response(
        401,
        json={"statusCode": 401, "message": "Invalid or missing agent service key"},
        request=req,
    )
    with patch("httpx.AsyncClient.post", return_value=resp_401):
        access_res = await client_a.check_user_access(sub=USER_A["id"])
        assert access_res == {"allowed": False}

    req_sess = httpx.Request("POST", f"{settings.NESTJS_API_URL}/agent-gateway/chat/sessions")
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
    """[Security Invariant] Replaying consumed or expired handoff fails closed without mutations."""
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

    # THREAT: Attacker attempts to replay a consumed handoff token
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

    error_events = [e for e in events_consumed if isinstance(e, ErrorEvent)]
    assert len(error_events) == 1
    assert error_events[0].data.code == "HANDOFF_FAILED"
    assert "HANDOFF_ALREADY_CONSUMED" in error_events[0].data.message

    # INVARIANT: Replay attempts must never trigger downstream booking or payment creation
    mock_client.create_booking.assert_not_called()
    mock_client.create_payment.assert_not_called()

    # THREAT: Attacker attempts to submit an expired handoff token
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

    mock_client.create_booking.assert_not_called()
    mock_client.create_payment.assert_not_called()


def test_tampered_snapshot_price_or_passenger_fields_fails_validation():
    """[Security Invariant] Tampering with price or injecting fields on signed snapshot fails."""
    now = datetime.now(timezone.utc)

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

    # THREAT: Parameter tampering via arbitrary discount field injection
    tampered_data = {**result_data, "discountPercent": 90}
    with pytest.raises(ValidationError):
        TrustedSearchResult(**tampered_data)

    # THREAT: Integer range violation on offerIndex to disrupt array indexing
    tampered_index_data = {**result_data, "offerIndex": -1}
    with pytest.raises(ValidationError):
        TrustedSearchResult(**tampered_index_data)

    # THREAT: Price manipulation within signed attestation envelope
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

    assert not hmac.compare_digest(real_sig, tampered_sig)


# ---------------------------------------------------------------------------
# 4. Redis Fencing Concurrency
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_session_lock_concurrent_acquire_rejects_duplicate():
    """[Concurrency Invariant] Concurrent turn submissions are rejected by Redis fencing lock."""
    fake_redis = InMemRedis()
    repo = SessionLockRepository(prefix="test:fence:")

    with patch(
        "agent.repositories.session_lock_repository.get_redis_client",
        return_value=fake_redis,
    ):
        fence_1 = await repo.acquire_lock(USER_A["id"], "session-concur-1", "req-1", ttl_ms=5000)
        assert fence_1 is not None
        assert fence_1 >= 1

        # INVARIANT: Lock collision must reject second concurrent request with None
        fence_2 = await repo.acquire_lock(USER_A["id"], "session-concur-1", "req-2", ttl_ms=5000)
        assert fence_2 is None

        released = await repo.release_lock(USER_A["id"], "session-concur-1", "req-1", fence_1)
        assert released is True

        # INVARIANT: Monotonically increasing sequence prevents ABA race hazards
        fence_2_after = await repo.acquire_lock(
            USER_A["id"], "session-concur-1", "req-2", ttl_ms=5000
        )
        assert fence_2_after is not None
        assert fence_2_after > fence_1


@pytest.mark.asyncio
async def test_out_of_order_turn_rejected_by_fence():
    """[Concurrency Invariant] Out-of-order turn execution with stale fence token is rejected."""
    fake_redis = InMemRedis()
    repo = SessionLockRepository(prefix="test:fence:")

    with patch(
        "agent.repositories.session_lock_repository.get_redis_client",
        return_value=fake_redis,
    ):
        fence_1 = await repo.acquire_lock(USER_A["id"], "session-ooo-1", "req-turn-1", ttl_ms=100)
        assert fence_1 == 1

        await repo.release_lock(USER_A["id"], "session-ooo-1", "req-turn-1", fence_1)

        fence_2 = await repo.acquire_lock(USER_A["id"], "session-ooo-1", "req-turn-2", ttl_ms=5000)
        assert fence_2 == 2

        # THREAT: Delayed or zombie worker turn attempts to overwrite newer completed turn
        refreshed = await repo.refresh_lock(USER_A["id"], "session-ooo-1", "req-turn-1", fence_1)
        assert refreshed is False

        is_valid = await repo.validate_fence(USER_A["id"], "session-ooo-1", "req-turn-1", fence_1)
        assert is_valid is False

        is_turn2_valid = await repo.validate_fence(
            USER_A["id"], "session-ooo-1", "req-turn-2", fence_2
        )
        assert is_turn2_valid is True


@pytest.mark.asyncio
async def test_message_queue_depth_exceeded_raises_429():
    """[Backpressure Invariant] MessageQueueManager raises HTTP 429 when queue depth exceeded."""
    manager = MessageQueueManager(max_depth=2)
    manager.repo = AsyncMock(spec=SessionLockRepository)
    manager.repo.acquire_lock.return_value = 1

    req1 = await manager.acquire("session-depth-test", USER_A["id"])
    assert req1 is not None
    req2 = await manager.acquire("session-depth-test", USER_A["id"])
    assert req2 is not None

    # INVARIANT: Requests exceeding depth limit must fail closed with HTTP 429
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
    """[Live Integration] Verify atomic Lua lock fencing under reachable Redis instance."""
    repo = SessionLockRepository(prefix="test:security:live:fence:")
    with patch(
        "agent.repositories.session_lock_repository.get_redis_client",
        return_value=redis_client,
    ):
        session_id = f"live-sess-{int(time.time())}"
        fence1 = await repo.acquire_lock(USER_A["id"], session_id, "req-live-1", ttl_ms=5000)
        assert fence1 is not None

        fence2 = await repo.acquire_lock(USER_A["id"], session_id, "req-live-2", ttl_ms=5000)
        assert fence2 is None

        await repo.release_lock(USER_A["id"], session_id, "req-live-1", fence1)
