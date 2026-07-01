import asyncio
import pytest
import jwt
import time
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi import HTTPException
from fastapi.testclient import TestClient
import httpx
from agent.queue.message_queue import MessageQueueManager
from agent.main import app

# JWT Secret from conftest / env
JWT_SECRET = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"

def get_auth_headers(payload_data=None):
    payload = {
        "sub": "12345",
        "email": "test@example.com",
        "exp": int(time.time()) + 100
    }
    if payload_data:
        payload.update(payload_data)
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}

@pytest.mark.asyncio
async def test_queue_manager_max_depth():
    manager = MessageQueueManager(max_depth=2)
    
    # First acquire
    await manager.acquire("session-1")
    # Second acquire (blocks because lock is held, but increments depth)
    acquire_task = asyncio.create_task(manager.acquire("session-1"))
    await asyncio.sleep(0.01) # Yield to let task run
    
    assert manager.depths["session-1"] == 2
    
    # Third acquire should fail immediately with 429 HTTPException
    with pytest.raises(HTTPException) as exc_info:
        await manager.acquire("session-1")
    
    assert exc_info.value.status_code == 429
    assert "Too many concurrent requests" in exc_info.value.detail
    
    # Clean up tasks
    await manager.release("session-1")
    await acquire_task
    await manager.release("session-1")

@pytest.mark.asyncio
async def test_queue_manager_fifo_order():
    manager = MessageQueueManager(max_depth=3)
    order = []
    
    async def worker(name, session_id):
        await manager.acquire(session_id)
        order.append(name)
        await asyncio.sleep(0.05)
        await manager.release(session_id)
        
    # Start worker 1 (acquires lock immediately)
    t1 = asyncio.create_task(worker("worker1", "session-1"))
    await asyncio.sleep(0.01)
    
    # Start worker 2 (waits)
    t2 = asyncio.create_task(worker("worker2", "session-1"))
    await asyncio.sleep(0.01)
    
    # Start worker 3 (waits)
    t3 = asyncio.create_task(worker("worker3", "session-1"))
    await asyncio.sleep(0.01)
    
    await asyncio.gather(t1, t2, t3)
    
    # Verification of FIFO order
    assert order == ["worker1", "worker2", "worker3"]

@pytest.mark.asyncio
async def test_queue_manager_session_isolation():
    manager = MessageQueueManager(max_depth=1)
    
    # Acquire for session-1
    await manager.acquire("session-1")
    
    # Acquire for session-2 should succeed because it is a different session
    await manager.acquire("session-2")
    
    assert manager.depths["session-1"] == 1
    assert manager.depths["session-2"] == 1
    
    await manager.release("session-1")
    await manager.release("session-2")

@pytest.mark.asyncio
async def test_endpoint_concurrency_limit(monkeypatch):
    headers = get_auth_headers()
    
    # Configure app state message queue to max_depth=2
    queue_manager = MessageQueueManager(max_depth=2)
    monkeypatch.setattr(app.state, "message_queue", queue_manager, raising=False)
    
    # Mock guardrails to allow
    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = True
    mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)
    
    # Mock get_memory to wait briefly
    async def mock_get_memory(self, session_id, recent_count):
        await asyncio.sleep(0.1)
        return {"recentMessages": [], "summary": None}
    monkeypatch.setattr("agent.tools.nestjs_client.NestJSClient.get_memory", mock_get_memory)
    
    # Mock create_message_batch
    mock_create_batch = AsyncMock(return_value={
        "messages": [
            {"id": "msg-123", "sender": "USER"},
            {"id": "msg-456", "sender": "AGENT"}
        ]
    })
    monkeypatch.setattr("agent.tools.nestjs_client.NestJSClient.create_message_batch", mock_create_batch)
    
    # Mock chat model
    from langchain_core.messages import AIMessageChunk
    mock_model = MagicMock()
    async def mock_astream(*args, **kwargs):
        yield AIMessageChunk(content="Word")
    mock_model.astream = mock_astream
    
    import agent.streaming.sse
    monkeypatch.setattr(agent.streaming.sse, "get_chat_model", lambda: mock_model)
    
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        # Send first request (will run and hold queue slot)
        r1_task = asyncio.create_task(
            ac.post(
                "/chat/stream",
                json={"message": "hello", "sessionId": "session-1"},
                headers=headers
            )
        )
        await asyncio.sleep(0.02) # yield
        
        # Send second request (will wait in queue, slot 2)
        r2_task = asyncio.create_task(
            ac.post(
                "/chat/stream",
                json={"message": "hello again", "sessionId": "session-1"},
                headers=headers
            )
        )
        await asyncio.sleep(0.02) # yield
        
        # Send third request (should be immediately rejected with 429)
        r3_response = await ac.post(
            "/chat/stream",
            json={"message": "hello third", "sessionId": "session-1"},
            headers=headers
        )
        
        assert r3_response.status_code == 429
        assert "Too many concurrent requests" in r3_response.json()["detail"]
        
        # Let other requests finish
        r1_response, r2_response = await asyncio.gather(r1_task, r2_task)
        assert r1_response.status_code == 200
        assert r2_response.status_code == 200
