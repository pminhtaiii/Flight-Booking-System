import pytest
import asyncio
from fastapi.testclient import TestClient
from agent.infrastructure.redis import init_redis, close_redis, get_redis_client
from agent.main import app

@pytest.fixture
def mock_settings(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")

@pytest.mark.asyncio
async def test_redis_lifecycle(mock_settings):
    # Before init, get_redis_client should raise an error or return None
    with pytest.raises(RuntimeError):
        get_redis_client()

    await init_redis("redis://localhost:6379/0")
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
