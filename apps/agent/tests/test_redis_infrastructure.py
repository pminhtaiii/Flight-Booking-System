import pytest
import os
import asyncio
from fastapi.testclient import TestClient
from agent.infrastructure.redis import init_redis, close_redis, get_redis_client
from agent.main import app

@pytest.fixture
def mock_settings(monkeypatch):
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    monkeypatch.setenv("REDIS_URL", redis_url)

@pytest.mark.asyncio
async def test_redis_lifecycle(mock_settings):
    import importlib
    import agent.infrastructure.redis
    importlib.reload(agent.infrastructure.redis)
    from agent.infrastructure.redis import get_redis_client, init_redis, close_redis
    with pytest.raises(RuntimeError):
        get_redis_client()

    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    
    from unittest.mock import patch, MagicMock, AsyncMock
    mock_redis_client = MagicMock()
    mock_redis_client.ping = AsyncMock(return_value=True)
    mock_redis_client.aclose = AsyncMock()
    
    with patch("redis.asyncio.from_url", return_value=mock_redis_client):
        await init_redis(redis_url)
        client = get_redis_client()
        assert client is not None
        
        # Ping should work
        assert await client.ping() == True

    await close_redis()
    with pytest.raises(RuntimeError):
        get_redis_client()

def test_redis_health_integration_ok(mock_settings):
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert "redis" in data["dependencies"]
        assert data["dependencies"]["redis"]["status"] == "ok"
