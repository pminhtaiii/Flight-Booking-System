import jwt
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi.testclient import TestClient

from agent.main import app
from agent.config import get_settings

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
        mock_budget.admit_request = AsyncMock(side_effect=BudgetExceededException("CHAT_DAILY_QUOTA_EXCEEDED"))
        
        with patch("agent.repositories.chat_budget_repository.ChatBudgetRepository", return_value=mock_budget), \
             patch("agent.streaming.sse.get_redis_client", return_value=MagicMock()):
            
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

def test_direct_bearer_stream_with_correlation_headers(monkeypatch):
    """Direct stream request supporting bearer auth, X-Trace-Id, and X-Correlation-Id headers."""
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
    monkeypatch.setattr("agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request", AsyncMock())
    monkeypatch.setattr("agent.streaming.sse.NestJSClient", lambda **kwargs: mock_client)

    response = client.post(
        "/chat/stream",
        headers={
            "Origin": "http://localhost:3000",
            "Authorization": f"Bearer {token}",
            "X-Trace-Id": "trace-abc-123",
            "X-Correlation-Id": "corr-xyz-456",
            "Content-Type": "application/json",
        },
        json={"message": "hello agent"},
    )
    # Should be processed (either 200 stream or valid response)
    assert response.status_code == 200, f"Expected 200 but got {response.status_code}: {response.text}"
    assert mock_client.correlation_id in ("session-123", "corr-xyz-456")

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
