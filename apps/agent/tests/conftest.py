import os
import pytest

# Set environment variables before importing any application code
os.environ["JWT_SECRET"] = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"
os.environ["NESTJS_API_URL"] = "http://localhost:3001/api"
os.environ["AGENT_SERVICE_API_KEY"] = "mock_agent_key"
os.environ["CLAIM_TOKEN_SECRET"] = "mock_claim_secret_must_be_long_enough_for_security"
os.environ["OUTPUT_GUARDRAIL_ENABLED"] = "false"


@pytest.fixture(autouse=True)
def setup_env(monkeypatch):
    from unittest.mock import AsyncMock, MagicMock
    monkeypatch.setattr("agent.tools.nestjs_client.NestJSClient.check_user_access", AsyncMock(return_value={"allowed": True}))
    
    import agent.infrastructure.redis
    mock_redis = MagicMock()
    mock_redis.get = AsyncMock(return_value=None)
    mock_redis.set = AsyncMock(return_value=True)
    mock_redis.eval = AsyncMock(return_value=[1, "ok"])
    mock_redis.ping = AsyncMock(return_value=True)
    mock_redis.aclose = AsyncMock()
    
    monkeypatch.setattr("agent.infrastructure.redis.init_redis", AsyncMock())
    monkeypatch.setattr("agent.infrastructure.redis.close_redis", AsyncMock())
    
    agent.infrastructure.redis._redis_client = mock_redis
    
    # Keep variables set, but yield for test duration
    yield
    agent.infrastructure.redis._redis_client = None

from unittest.mock import AsyncMock, MagicMock
from agent.queue.message_queue import SessionLockRepository

@pytest.fixture(autouse=True)
def mock_session_lock_repo(monkeypatch):
    _locks = set()
    
    async def mock_acquire_lock(user_id, session_id, req_id, ttl_ms=None):
        if session_id in _locks:
            return None
        _locks.add(session_id)
        return 1
        
    async def mock_release_lock(user_id, session_id, req_id, fence):
        _locks.discard(session_id)
        return True

    mock_repo = MagicMock(spec=SessionLockRepository)
    mock_repo.acquire_lock = mock_acquire_lock
    mock_repo.release_lock = mock_release_lock
    mock_repo.refresh_lock = AsyncMock(return_value=True)
    mock_repo.validate_fence = AsyncMock(return_value=True)
    monkeypatch.setattr("agent.queue.message_queue.SessionLockRepository", lambda *args, **kwargs: mock_repo)
