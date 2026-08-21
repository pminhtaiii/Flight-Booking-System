import re
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest
from fastapi.testclient import TestClient

from agent.config import get_settings
from agent.main import app

client = TestClient(app)
settings = get_settings()


def make_valid_jwt(sub="user-123", jti="jti-456"):
    issuer = getattr(settings, "JWT_ISSUER", "booking-systems-api")
    audience = getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")
    payload = {
        "sub": sub,
        "jti": jti,
        "iss": issuer,
        "aud": audience,
        "exp": 9999999999,
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm="HS256")


def test_cors_preflight_success():
    """OPTIONS /chat/stream from configured origin must return exact CORS headers and allow_credentials=False."""
    response = client.options(
        "/chat/stream",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization, Content-Type, Accept, X-Trace-Id, X-Correlation-Id",
        },
    )
    assert response.status_code in (200, 204)
    assert response.headers.get("access-control-allow-origin") == "http://localhost:3000"
    methods = response.headers.get("access-control-allow-methods", "")
    assert "POST" in methods
    req_headers = response.headers.get("access-control-allow-headers", "").lower()
    assert "authorization" in req_headers
    assert "content-type" in req_headers
    assert "accept" in req_headers
    assert "x-trace-id" in req_headers
    assert "x-correlation-id" in req_headers
    # allow_credentials must be False or absent/not 'true'
    assert response.headers.get("access-control-allow-credentials") in (None, "false")


def test_cors_unallowed_origin_rejection():
    """Request from disallowed origin must be explicitly rejected with 403 ORIGIN_NOT_ALLOWED."""
    response = client.post(
        "/chat/stream",
        headers={
            "Origin": "http://evil-unallowed-domain.com",
            "Content-Type": "application/json",
        },
        json={"message": "hello"},
    )
    assert response.status_code == 403
    assert response.headers.get("access-control-allow-origin") != "http://evil-unallowed-domain.com"
    data = response.json()
    assert data.get("detail") == "ORIGIN_NOT_ALLOWED" or "Origin" in str(data.get("detail"))


def test_cors_headers_present_on_auth_error():
    """CORS headers must be present on 401 auth errors for allowed origins."""
    response = client.post(
        "/chat/stream",
        headers={
            "Origin": "http://localhost:3000",
            "Content-Type": "application/json",
        },
        json={"message": "hello"},
    )
    assert response.status_code == 401
    assert response.headers.get("access-control-allow-origin") == "http://localhost:3000"


def test_cors_headers_present_on_quota_error(monkeypatch):
    """CORS headers must be present on 429 rate limit / quota errors for allowed origins."""
    token = make_valid_jwt()
    mock_client = MagicMock()
    mock_client.check_user_access = AsyncMock(return_value={"allowed": True})

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_client):
        # Mock Redis budget to raise daily limit error
        mock_budget = MagicMock()
        from agent.repositories.chat_budget_repository import BudgetExceededException

        mock_budget.admit_request = AsyncMock(
            side_effect=BudgetExceededException("CHAT_DAILY_QUOTA_EXCEEDED")
        )

        with (
            patch(
                "agent.repositories.chat_budget_repository.ChatBudgetRepository",
                return_value=mock_budget,
            ),
            patch("agent.streaming.sse.get_redis_client", return_value=MagicMock()),
        ):
            response = client.post(
                "/chat/stream",
                headers={
                    "Origin": "http://localhost:3000",
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json={"message": "hello"},
            )
            assert response.status_code == 429
            assert response.headers.get("access-control-allow-origin") == "http://localhost:3000"


@pytest.mark.parametrize(
    "correlation_id",
    [
        None,
        "session-123",
        "chat_session-123",
        f"chat_{'a' * 31}",
        f"chat_{'A' * 32}",
        f"chat_{'a' * 32}_suffix",
    ],
)
def test_direct_stream_generates_correlation_for_missing_or_invalid_header(
    monkeypatch,
    correlation_id,
):
    """Missing or malformed correlation data must not enter downstream telemetry."""
    token = make_valid_jwt(sub="user-direct-bearer-123")
    mock_client = MagicMock()
    mock_client.check_user_access = AsyncMock(return_value={"allowed": True})
    mock_client.create_session = AsyncMock(return_value={"id": "session-123"})
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})

    mock_guardrails = MagicMock()
    mock_guardrails.validate_message = AsyncMock(return_value=(True, None))
    mock_guardrails.validate_text = AsyncMock(return_value=(True, None, None))
    mock_guardrails.is_healthy = MagicMock(return_value=True)
    monkeypatch.setattr(app.state, "guardrails", mock_guardrails, raising=False)
    monkeypatch.setattr(app.state, "message_queue", None, raising=False)

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="Hello")}}

    mock_graph.astream_events = mock_astream_events
    mock_graph.aget_state = AsyncMock(return_value=MagicMock(next=(), values={}))
    monkeypatch.setattr("agent.streaming.sse.graph", mock_graph)

    monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: MagicMock())
    monkeypatch.setattr(
        "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request", AsyncMock()
    )
    monkeypatch.setattr("agent.streaming.sse.NestJSClient", lambda **kwargs: mock_client)

    headers = {
        "Origin": "http://localhost:3000",
        "Authorization": f"Bearer {token}",
        "X-Trace-Id": "chat_session-123",
        "Content-Type": "application/json",
    }
    if correlation_id is not None:
        headers["X-Correlation-Id"] = correlation_id

    response = client.post(
        "/chat/stream",
        headers=headers,
        json={"message": "hello agent", "sessionId": "session-123"},
    )
    # Should be processed (either 200 stream or valid response)
    assert response.status_code == 200, (
        f"Expected 200 but got {response.status_code}: {response.text}"
    )
    assert mock_client.correlation_id != "session-123"
    assert mock_client.correlation_id != correlation_id
    assert re.fullmatch(r"chat_[a-f0-9]{32}", mock_client.correlation_id)
    assert mock_client.trace_id != "chat_session-123"
    assert re.fullmatch(r"chat_[a-f0-9]{32}", mock_client.trace_id)
    mock_client.create_session.assert_not_awaited()
    assert mock_client.get_memory.await_count == 1
    assert mock_client.get_memory.await_args.args[0] == "session-123"


def test_direct_stream_preserves_strictly_valid_opaque_trace_and_correlation_ids(monkeypatch):
    """Strictly formatted opaque trace and correlation headers remain stable downstream."""
    token = make_valid_jwt(sub="user-direct-bearer-123")
    opaque_trace_id = f"chat_{'b2' * 16}"
    opaque_correlation_id = f"chat_{'a1' * 16}"
    mock_client = MagicMock()
    mock_client.check_user_access = AsyncMock(return_value={"allowed": True})
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})

    mock_guardrails = MagicMock()
    mock_guardrails.validate_message = AsyncMock(return_value=(True, None))
    mock_guardrails.validate_text = AsyncMock(return_value=(True, None, None))
    mock_guardrails.is_healthy = MagicMock(return_value=True)
    monkeypatch.setattr(app.state, "guardrails", mock_guardrails, raising=False)
    monkeypatch.setattr(app.state, "message_queue", None, raising=False)

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="Hello")}}

    mock_graph.astream_events = mock_astream_events
    mock_graph.aget_state = AsyncMock(return_value=MagicMock(next=(), values={}))
    monkeypatch.setattr("agent.streaming.sse.graph", mock_graph)

    monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: MagicMock())
    monkeypatch.setattr(
        "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request", AsyncMock()
    )
    monkeypatch.setattr("agent.streaming.sse.NestJSClient", lambda **kwargs: mock_client)

    response = client.post(
        "/chat/stream",
        headers={
            "Origin": "http://localhost:3000",
            "Authorization": f"Bearer {token}",
            "X-Trace-Id": opaque_trace_id,
            "X-Correlation-Id": opaque_correlation_id,
            "Content-Type": "application/json",
        },
        json={"message": "hello agent", "sessionId": "session-123"},
    )

    assert response.status_code == 200, (
        f"Expected 200 but got {response.status_code}: {response.text}"
    )
    assert mock_client.trace_id == opaque_trace_id
    assert mock_client.correlation_id == opaque_correlation_id


def test_health_degraded_when_redis_down(monkeypatch):
    """Health check reports degraded status and redis: 'down' when Redis ping fails."""
    mock_redis = MagicMock()
    mock_redis.ping = AsyncMock(side_effect=Exception("Redis connection error"))

    with patch("agent.infrastructure.redis.get_redis_client", return_value=mock_redis):
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "degraded"
        assert data["dependencies"]["redis"]["status"] == "down"
