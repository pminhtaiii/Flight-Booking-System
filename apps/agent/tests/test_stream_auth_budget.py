import time
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent.config import get_settings
from agent.middleware.auth import JWTAuthMiddleware
from agent.streaming.sse import router as streaming_router

settings = get_settings()
SECRET = settings.JWT_SECRET
ISSUER = getattr(settings, "JWT_ISSUER", "booking-systems-api")
AUDIENCE = getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")

app = FastAPI()
app.add_middleware(JWTAuthMiddleware, secret=SECRET, exclude_paths=["/health"])
app.include_router(streaming_router)

client = TestClient(app)


def make_token(
    user_id="user-123",
    sub="user-123",
    jti="jti-uuid-1",
    iss="booking-systems-api",
    aud="booking-systems-clients",
    exp=None,
    extra=None,
):
    payload = {
        "id": user_id,
        "sub": sub,
        "jti": jti,
        "iss": iss,
        "aud": aud,
        "exp": exp or (int(time.time()) + 3600),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, SECRET, algorithm="HS256")


# ---------------------------------------------------------------------------
# T025: Canonical JWT profile tests for sub/iss/aud/jti & legacy id
# ---------------------------------------------------------------------------


def test_canonical_jwt_valid_claims_accepted():
    token = make_token()
    headers = {"Authorization": f"Bearer {token}"}
    with (
        patch("agent.streaming.sse.NestJSClient") as MockClient,
        patch("agent.streaming.sse.graph.astream_events") as _mock_events,
    ):
        mock_nestjs = AsyncMock()
        mock_nestjs.check_user_access.return_value = {"allowed": True}
        mock_nestjs.create_session.return_value = {"id": "sess-1"}
        mock_nestjs.get_memory.return_value = {"recentMessages": [], "summary": None}
        MockClient.return_value = mock_nestjs

        response = client.post("/chat/stream", json={"message": "hello"}, headers=headers)
        assert response.status_code == 200


def test_jwt_missing_required_claims_rejected():
    # Missing jti
    payload = {"sub": "user-123", "iss": ISSUER, "aud": AUDIENCE, "exp": int(time.time()) + 3600}
    token = jwt.encode(payload, SECRET, algorithm="HS256")
    res = client.post(
        "/chat/stream", json={"message": "hello"}, headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 401
    assert (
        "Invalid token" in res.json().get("detail", "")
        or "claims" in res.json().get("detail", "").lower()
    )

    # Missing sub
    payload = {"jti": "jti-1", "iss": ISSUER, "aud": AUDIENCE, "exp": int(time.time()) + 3600}
    token = jwt.encode(payload, SECRET, algorithm="HS256")
    res = client.post(
        "/chat/stream", json={"message": "hello"}, headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 401


def test_jwt_invalid_issuer_or_audience_rejected():
    # Wrong issuer
    token = make_token(iss="wrong-issuer")
    res = client.post(
        "/chat/stream", json={"message": "hello"}, headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 401

    # Wrong audience
    token = make_token(aud="wrong-audience")
    res = client.post(
        "/chat/stream", json={"message": "hello"}, headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 401


def test_legacy_id_transition_supported():
    # Has both id and sub
    token = make_token(user_id="user-123", sub="user-123")
    with patch("agent.streaming.sse.NestJSClient") as MockClient:
        mock_nestjs = AsyncMock()
        mock_nestjs.check_user_access.return_value = {"allowed": True}
        mock_nestjs.create_session.return_value = {"id": "sess-1"}
        mock_nestjs.get_memory.return_value = {"recentMessages": [], "summary": None}
        MockClient.return_value = mock_nestjs

        res = client.post(
            "/chat/stream", json={"message": "hello"}, headers={"Authorization": f"Bearer {token}"}
        )
        assert res.status_code == 200


# ---------------------------------------------------------------------------
# T025: Logout revocation & user deactivation via NestJS access check
# ---------------------------------------------------------------------------


def test_nestjs_access_check_revoked_or_deactivated_rejected():
    token = make_token()
    with patch("agent.streaming.sse.NestJSClient") as MockClient:
        mock_nestjs = AsyncMock()
        # Simulate NestJS returning allowed: False (deactivated user or blacklisted jti)
        mock_nestjs.check_user_access.return_value = {"allowed": False}
        MockClient.return_value = mock_nestjs

        res = client.post(
            "/chat/stream", json={"message": "hello"}, headers={"Authorization": f"Bearer {token}"}
        )
        assert res.status_code == 401
        assert (
            "unauthorized" in res.json().get("detail", "").lower()
            or "revoked" in res.json().get("detail", "").lower()
            or "inactive" in res.json().get("detail", "").lower()
        )


# ---------------------------------------------------------------------------
# T025: Ordering - Auth -> NestJS access check -> Quota -> Fenced Session -> Safety -> Inference/Persistence
# Zero-inference and zero-persistence on denial
# ---------------------------------------------------------------------------


def test_zero_quota_charged_and_zero_inference_on_auth_failure():
    invalid_token = "Bearer invalid.jwt.token"

    with (
        patch(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            new_callable=AsyncMock,
        ) as mock_quota,
        patch("agent.streaming.sse.graph.astream_events") as mock_graph,
        patch("agent.streaming.sse._persist_response") as mock_persist,
    ):
        res = client.post(
            "/chat/stream", json={"message": "hello"}, headers={"Authorization": invalid_token}
        )
        assert res.status_code == 401
        # Quota MUST NOT be charged on auth failure
        mock_quota.assert_not_called()
        mock_graph.assert_not_called()
        mock_persist.assert_not_called()


def test_zero_quota_charged_and_zero_inference_on_access_check_failure():
    token = make_token()
    with (
        patch("agent.streaming.sse.NestJSClient") as MockClient,
        patch(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            new_callable=AsyncMock,
        ) as mock_quota,
        patch("agent.streaming.sse.graph.astream_events") as mock_graph,
        patch("agent.streaming.sse._persist_response") as mock_persist,
    ):
        mock_nestjs = AsyncMock()
        mock_nestjs.check_user_access.return_value = {"allowed": False}
        MockClient.return_value = mock_nestjs

        res = client.post(
            "/chat/stream", json={"message": "hello"}, headers={"Authorization": f"Bearer {token}"}
        )
        assert res.status_code == 401
        # Quota MUST NOT be charged when access check fails
        mock_quota.assert_not_called()
        mock_graph.assert_not_called()
        mock_persist.assert_not_called()


def test_zero_inference_and_zero_persistence_on_quota_exceeded():
    token = make_token()
    mock_redis = MagicMock()
    with (
        patch("agent.streaming.sse.NestJSClient") as MockClient,
        patch("agent.streaming.sse.get_redis_client", return_value=mock_redis),
        patch(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            new_callable=AsyncMock,
        ) as mock_quota,
        patch("agent.streaming.sse.graph.astream_events") as mock_graph,
        patch("agent.streaming.sse._persist_response") as mock_persist,
    ):
        mock_nestjs = AsyncMock()
        mock_nestjs.check_user_access.return_value = {"allowed": True}
        MockClient.return_value = mock_nestjs

        # Simulate quota exceeded exception
        from agent.repositories.chat_budget_repository import BudgetExceededException

        mock_quota.side_effect = BudgetExceededException("daily_quota_exceeded")

        res = client.post(
            "/chat/stream", json={"message": "hello"}, headers={"Authorization": f"Bearer {token}"}
        )
        assert res.status_code == 429
        # Graph inference and persistence MUST NOT be called
        mock_graph.assert_not_called()
        mock_persist.assert_not_called()


def test_cross_user_session_isolation_denied():
    token_user_a = make_token(user_id="user-A", sub="user-A")
    with (
        patch("agent.streaming.sse.NestJSClient") as MockClient,
        patch("agent.streaming.sse.graph.astream_events") as mock_graph,
        patch("agent.streaming.sse._persist_response") as mock_persist,
    ):
        mock_nestjs = AsyncMock()
        mock_nestjs.check_user_access.return_value = {"allowed": True}
        # Simulate session owned by user-B returning 404 / CHAT_SESSION_NOT_FOUND when user-A accesses it
        mock_nestjs.get_memory.side_effect = Exception(
            "CHAT_SESSION_NOT_FOUND: Session not owned by user"
        )
        MockClient.return_value = mock_nestjs

        res = client.post(
            "/chat/stream",
            json={"message": "hello", "sessionId": "session-owned-by-user-B"},
            headers={"Authorization": f"Bearer {token_user_a}"},
        )
        assert res.status_code in (403, 404, 503)
        mock_graph.assert_not_called()
        mock_persist.assert_not_called()
