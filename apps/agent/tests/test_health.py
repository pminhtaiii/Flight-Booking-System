from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from agent.main import app

client = TestClient(app)


def test_health_live_success():
    response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_live_zero_inference_guarantee(monkeypatch):
    with (
        patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_http_get,
        patch("agent.main.settings") as mock_settings,
        patch("agent.infrastructure.redis.get_redis_client", return_value=None),
    ):
        mock_settings.MIMO_API_KEY = None
        mock_settings.MIMO_API_URL = "http://unreachable-mimo:9999"
        mock_settings.NESTJS_API_URL = "http://unreachable-nestjs:9999"
        monkeypatch.setattr(app.state, "guardrails", None, raising=False)

        response = client.get("/health/live")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        mock_http_get.assert_not_called()


def test_health_success(monkeypatch):
    # Mock nestjsApi, llm, and redis check responses
    mock_redis = MagicMock()
    mock_redis.ping = AsyncMock(return_value=True)
    with (
        patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get,
        patch("agent.main.settings") as mock_settings,
        patch("agent.infrastructure.redis.get_redis_client", return_value=mock_redis),
    ):
        mock_settings.MIMO_API_URL = "http://mockmimo"
        mock_settings.MIMO_API_KEY = "mockkey"
        mock_settings.NESTJS_API_URL = "http://localhost:3001"

        # Mocking NestJS API health check to be ok
        mock_response = httpx.Response(
            200,
            json={"status": "ok"},
            request=httpx.Request("GET", "http://localhost:3001/api/health"),
        )
        mock_get.return_value = mock_response

        # Mock healthy guardrail service in app state
        mock_guardrail = MagicMock()
        mock_guardrail.is_healthy.return_value = True
        monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

        response = client.get("/health")
        assert response.status_code == 200

        data = response.json()
        assert data["status"] == "ok"
        assert "dependencies" in data
        assert "llm" in data["dependencies"]
        assert "nestjsApi" in data["dependencies"]
        assert "guardrails" in data["dependencies"]
        assert data["dependencies"]["nestjsApi"]["status"] == "ok"
        assert data["version"] == "0.1.0"


def test_health_nestjs_down(monkeypatch):
    with (
        patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get,
        patch("agent.main.settings") as mock_settings,
    ):
        mock_settings.MIMO_API_URL = "http://mockmimo"
        mock_settings.MIMO_API_KEY = "mockkey"
        mock_settings.NESTJS_API_URL = "http://localhost:3001"

        # Simulate NestJS API connection error
        mock_get.side_effect = httpx.RequestError("Connection failed")

        # Mock healthy guardrail service in app state
        mock_guardrail = MagicMock()
        mock_guardrail.is_healthy.return_value = True
        monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

        response = client.get("/health")
        assert response.status_code == 200

        data = response.json()
        assert data["status"] == "degraded"
        assert data["dependencies"]["nestjsApi"]["status"] == "down"


def test_lifespan_shutdown():
    import asyncio

    from agent.main import active_streams, app

    q = asyncio.Queue()
    active_streams.add(q)

    with TestClient(app):
        pass

    assert q.qsize() == 1
    event = q.get_nowait()
    assert event["event"] == "error"
    assert "Server is shutting down" in event["data"]


@pytest.mark.asyncio
async def test_lifespan_shutdown_cancels_active_runners(monkeypatch):
    import asyncio

    from agent.main import active_runners, app, lifespan

    monkeypatch.setattr("agent.infrastructure.redis.init_redis", AsyncMock())
    monkeypatch.setattr("agent.infrastructure.redis.close_redis", AsyncMock())
    monkeypatch.setattr("agent.guardrails.nemo.NemoGuardrailService.probe", AsyncMock())

    cancelled = False

    async def mock_runner_task():
        nonlocal cancelled
        try:
            await asyncio.sleep(100)
        except asyncio.CancelledError:
            cancelled = True
            raise

    task = asyncio.create_task(mock_runner_task())
    await asyncio.sleep(0)
    active_runners.add(task)

    assert not task.done()
    assert task in active_runners

    async with lifespan(app):
        pass

    assert task.cancelled() or task.done()
    assert cancelled is True
    assert len(active_runners) == 0
