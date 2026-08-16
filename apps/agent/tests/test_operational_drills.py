import time
import pytest
import jwt
import httpx
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi import FastAPI
from fastapi.testclient import TestClient
import redis.asyncio as redis

from agent.main import app
from agent.middleware.auth import JWTAuthMiddleware
from agent.middleware.rate_limit import RateLimitMiddleware
from agent.config import get_settings
from agent.repositories.chat_budget_repository import RedisUnavailableException

settings = get_settings()
SECRET = settings.JWT_SECRET
ISSUER = getattr(settings, "JWT_ISSUER", "booking-systems-api")
AUDIENCE = getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")


def make_token(user_id="user-op-drill-1"):
    payload = {
        "id": user_id,
        "sub": user_id,
        "jti": f"jti-{user_id}",
        "iss": ISSUER,
        "aud": AUDIENCE,
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


@pytest.mark.asyncio
async def test_redis_outage_rate_limit_fails_closed_503():
    """
    Operational Drill: When Redis control plane is down, rate limiting must fail-closed
    with a stable 503 CHAT_CONTROL_PLANE_UNAVAILABLE, protecting against unbudgeted LLM costs.
    """
    mock_redis = MagicMock()
    mock_redis.eval = AsyncMock(side_effect=redis.ConnectionError("Redis cluster unreachable"))

    test_app = FastAPI()
    test_app.add_middleware(RateLimitMiddleware, limit=10, window=60, redis_client=mock_redis)
    test_app.add_middleware(JWTAuthMiddleware, secret=SECRET)

    @test_app.post("/chat/stream")
    async def chat_stream_endpoint():
        return {"result": "llm_generated_response"}

    token = make_token("drill-user-1")
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=test_app), base_url="http://test") as client:
        res = await client.post("/chat/stream", headers=headers)
        assert res.status_code == 503
        data = res.json()
        assert data.get("code") == "CHAT_CONTROL_PLANE_UNAVAILABLE"
        assert "Control plane unavailable" in data.get("detail", "")


@pytest.mark.asyncio
async def test_redis_runtime_error_fails_closed_503():
    """
    Operational Drill: If Redis client raises uninitialized RuntimeError or RedisUnavailableException,
    must fail-closed with 503 CHAT_CONTROL_PLANE_UNAVAILABLE.
    """
    mock_redis = MagicMock()
    mock_redis.eval = AsyncMock(side_effect=RedisUnavailableException("Connection timed out"))

    test_app = FastAPI()
    test_app.add_middleware(RateLimitMiddleware, limit=5, window=60, redis_client=mock_redis)
    test_app.add_middleware(JWTAuthMiddleware, secret=SECRET)

    @test_app.post("/chat/stream")
    async def chat_stream_endpoint():
        return {"result": "llm_generated_response"}

    token = make_token("drill-user-2")
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=test_app), base_url="http://test") as client:
        res = await client.post("/chat/stream", headers=headers)
        assert res.status_code == 503
        data = res.json()
        assert data.get("code") == "CHAT_CONTROL_PLANE_UNAVAILABLE"


def test_health_reports_degraded_when_redis_down(monkeypatch):
    """
    Operational Drill: /health endpoint accurately reports 'degraded' status
    and 'down' for redis when Redis pings fail.
    """
    mock_redis = MagicMock()
    mock_redis.ping = AsyncMock(side_effect=redis.ConnectionError("Redis connection refused"))

    client = TestClient(app)

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get, \
         patch("agent.main.settings") as mock_settings, \
         patch("agent.infrastructure.redis.get_redis_client", return_value=mock_redis):

        mock_settings.MIMO_API_URL = "http://mockmimo"
        mock_settings.MIMO_API_KEY = "mockkey"
        mock_settings.NESTJS_API_URL = "http://localhost:3001"

        mock_response = httpx.Response(
            200,
            json={"status": "ok"},
            request=httpx.Request("GET", "http://localhost:3001/api/health"),
        )
        mock_get.return_value = mock_response

        mock_guardrail = MagicMock()
        mock_guardrail.is_healthy.return_value = True
        monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

        response = client.get("/health")
        assert response.status_code == 200

        data = response.json()
        assert data["status"] == "degraded"
        assert data["dependencies"]["redis"]["status"] == "down"
        assert data["dependencies"]["nestjsApi"]["status"] == "ok"
        assert data["dependencies"]["guardrails"]["status"] == "ok"


def test_health_reports_degraded_when_redis_client_none(monkeypatch):
    """
    Operational Drill: /health endpoint reports degraded if Redis client is None or not initialized.
    """
    client = TestClient(app)

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get, \
         patch("agent.main.settings") as mock_settings, \
         patch("agent.infrastructure.redis.get_redis_client", return_value=None):

        mock_settings.MIMO_API_URL = "http://mockmimo"
        mock_settings.MIMO_API_KEY = "mockkey"
        mock_settings.NESTJS_API_URL = "http://localhost:3001"

        mock_response = httpx.Response(
            200,
            json={"status": "ok"},
            request=httpx.Request("GET", "http://localhost:3001/api/health"),
        )
        mock_get.return_value = mock_response

        mock_guardrail = MagicMock()
        mock_guardrail.is_healthy.return_value = True
        monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

        response = client.get("/health")
        assert response.status_code == 200

        data = response.json()
        assert data["status"] == "degraded"
        assert data["dependencies"]["redis"]["status"] == "down"
