import asyncio
import os
import time
from unittest.mock import AsyncMock, MagicMock

import httpx
import jwt
import pytest
from fastapi import HTTPException
from langchain_core.messages import AIMessageChunk

from agent.infrastructure.redis import close_redis, init_redis
from agent.main import app
from agent.queue.message_queue import ActiveFence, MessageQueueManager


@pytest.fixture(autouse=True)
async def setup_redis():
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    await init_redis(redis_url)
    yield
    await close_redis()


# JWT Secret from conftest / env
JWT_SECRET = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"


def get_auth_headers(payload_data=None):
    payload = {
        "sub": "12345",
        "iss": "booking-systems-api",
        "aud": "booking-systems-clients",
        "jti": "jti-test-uuid",
        "email": "test@example.com",
        "exp": int(time.time()) + 100,
    }
    if payload_data:
        payload.update(payload_data)
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_queue_manager_max_depth():
    manager = MessageQueueManager(max_depth=2)

    # First acquire
    req1 = await manager.acquire("session-1")
    # Second acquire (blocks because lock is held, but increments depth)
    acquire_task = asyncio.create_task(manager.acquire("session-1"))
    await asyncio.sleep(0.01)  # Yield to let task run

    assert manager.depths["session-1"] == 2

    # Third acquire should fail immediately with 429 HTTPException
    with pytest.raises(HTTPException) as exc_info:
        await manager.acquire("session-1")

    assert exc_info.value.status_code == 429
    assert "Too many concurrent requests" in exc_info.value.detail

    # Clean up tasks
    await manager.release("session-1", req1)
    req2 = await acquire_task
    await manager.release("session-1", req2)


@pytest.mark.asyncio
async def test_queue_manager_fifo_order():
    manager = MessageQueueManager(max_depth=3)
    order = []

    async def worker(name, session_id, hold_time=0.05):
        req = await manager.acquire(session_id)
        order.append(name)
        await asyncio.sleep(hold_time)
        await manager.release(session_id, req)

    # Start worker 1 (acquires lock immediately and holds for 0.2s)
    t1 = asyncio.create_task(worker("worker1", "session-fifo-1", hold_time=0.2))
    await asyncio.sleep(0.01)

    # Start worker 2 (waits)
    t2 = asyncio.create_task(worker("worker2", "session-fifo-1"))
    await asyncio.sleep(0.01)

    # Start worker 3 (waits)
    t3 = asyncio.create_task(worker("worker3", "session-fifo-1"))
    await asyncio.sleep(0.01)

    await asyncio.gather(t1, t2, t3)

    # Verification of FIFO order
    assert order == ["worker1", "worker2", "worker3"]


@pytest.mark.asyncio
async def test_queue_manager_session_isolation():
    manager = MessageQueueManager(max_depth=1)

    # Acquire for session-1
    req1 = await manager.acquire("session-1")

    # Acquire for session-2 should succeed because it is a different session
    req2 = await manager.acquire("session-2")

    assert manager.depths["session-1"] == 1
    assert manager.depths["session-2"] == 1

    await manager.release("session-1", req1)
    await manager.release("session-2", req2)


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
    mock_create_batch = AsyncMock(
        return_value={
            "messages": [{"id": "msg-123", "sender": "USER"}, {"id": "msg-456", "sender": "AGENT"}]
        }
    )
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.create_message_batch", mock_create_batch
    )

    # Mock graph
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        await asyncio.sleep(2.0)
        yield {"event": "on_chat_model_stream", "data": {"chunk": AIMessageChunk(content="Word")}}

    mock_graph.astream_events = mock_astream_events

    mock_state = MagicMock()
    mock_state.next = ()
    from langchain_core.messages import HumanMessage

    mock_state.values = {"messages": [HumanMessage(content="hello")]}
    mock_graph.aget_state = AsyncMock(return_value=mock_state)

    import agent.streaming.sse

    monkeypatch.setattr(agent.streaming.sse, "graph", mock_graph)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        # Send first request (will run and hold queue slot)
        r1_task = asyncio.create_task(
            ac.post(
                "/chat/stream", json={"message": "hello", "sessionId": "session-1"}, headers=headers
            )
        )

        # Send second request (will wait in queue, slot 2)
        r2_task = asyncio.create_task(
            ac.post(
                "/chat/stream",
                json={"message": "hello again", "sessionId": "session-1"},
                headers=headers,
            )
        )

        # Wait for both requests to hit the queue
        for _ in range(50):
            if queue_manager.depths.get("session-1", 0) == 2:
                break
            await asyncio.sleep(0.01)

        # Send third request (should be immediately rejected with 429)
        r3_task = asyncio.create_task(
            ac.post(
                "/chat/stream",
                json={"message": "hello third", "sessionId": "session-1"},
                headers=headers,
            )
        )

        responses = await asyncio.gather(r1_task, r2_task, r3_task)
        status_codes = [r.status_code for r in responses]

        assert status_codes.count(429) == 1, (
            f"Expected exactly one 429, got statuses: {status_codes}"
        )
        assert status_codes.count(200) == 2, (
            f"Expected exactly two 200s, got statuses: {status_codes}"
        )


@pytest.mark.asyncio
async def test_refresher_redis_error_cancels_request(monkeypatch):
    manager = MessageQueueManager(max_depth=3)
    manager.refresh_interval = 0.01

    # Mock refresh_lock to raise an exception
    mock_repo = MagicMock()
    mock_repo.acquire_lock = AsyncMock(return_value=1)
    mock_repo.refresh_lock = AsyncMock(side_effect=Exception("Redis connection error"))
    mock_repo.release_lock = AsyncMock()
    manager.repo = mock_repo

    cancelled = False

    async def sample_task():
        nonlocal cancelled
        try:
            await manager.acquire("session-err-1")
            await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            cancelled = True
            raise

    task = asyncio.create_task(sample_task())
    with pytest.raises(asyncio.CancelledError):
        await task

    assert cancelled is True


@pytest.mark.asyncio
async def test_attached_producer_task_cancelled_on_refresh_loss():
    manager = MessageQueueManager(max_depth=3)
    manager.refresh_interval = 0.01

    mock_repo = MagicMock()
    mock_repo.acquire_lock = AsyncMock(return_value=1)
    mock_repo.refresh_lock = AsyncMock(return_value=False)
    mock_repo.release_lock = AsyncMock()
    manager.repo = mock_repo

    producer_cancelled = False

    async def producer_work():
        nonlocal producer_cancelled
        try:
            await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            producer_cancelled = True
            raise

    # Handler acquires lock
    req_id = await manager.acquire("session-producer-1")

    # Producer task is spawned after handler returns
    p_task = asyncio.create_task(producer_work())
    attached = await manager.attach_task("session-producer-1", req_id, p_task)
    assert attached is True

    # Wait for refresher to detect refresh loss and cancel attached producer
    with pytest.raises(asyncio.CancelledError):
        await p_task

    assert producer_cancelled is True


@pytest.mark.asyncio
async def test_stale_release_decrements_queue_depth():
    manager = MessageQueueManager(max_depth=3)
    mock_repo = MagicMock()
    mock_repo.acquire_lock = AsyncMock(return_value=1)
    mock_repo.release_lock = AsyncMock()
    manager.repo = mock_repo

    req_id_1 = await manager.acquire("session-stale-1")
    assert manager.depths["session-stale-1"] == 1

    # Simulate successor acquiring the active fence and incrementing depth
    req_id_2 = "req-id-successor"
    dummy_task = asyncio.create_task(asyncio.sleep(10))
    successor_fence = ActiveFence(
        req_id=req_id_2, fence=2, refresh_task=dummy_task, user_id="default"
    )
    manager.active_fences["session-stale-1"] = successor_fence
    manager.depths["session-stale-1"] = 2

    # Stale release call from former owner req_id_1
    await manager.release("session-stale-1", req_id_1)

    # Queue depth must be decremented even for stale release
    assert manager.depths["session-stale-1"] == 1

    # New owner's active fence and lock/refresh task must NOT be released or cancelled
    assert manager.active_fences["session-stale-1"].req_id == req_id_2
    assert not dummy_task.cancelled()
    mock_repo.release_lock.assert_not_called()

    # Valid release call from new owner req_id_2
    dummy_task.cancel()
    await manager.release("session-stale-1", req_id_2)
    assert "session-stale-1" not in manager.depths
    assert "session-stale-1" not in manager.active_fences
    mock_repo.release_lock.assert_called_once_with("default", "session-stale-1", req_id_2, 2)


@pytest.mark.asyncio
async def test_get_fence():
    manager = MessageQueueManager(max_depth=3)
    mock_repo = MagicMock()
    mock_repo.acquire_lock = AsyncMock(return_value=105)
    mock_repo.release_lock = AsyncMock()
    manager.repo = mock_repo

    assert manager.get_fence("session-get-fence") is None

    req_id = await manager.acquire("session-get-fence")
    assert manager.get_fence("session-get-fence") == 105

    await manager.release("session-get-fence", req_id)
    assert manager.get_fence("session-get-fence") is None


@pytest.mark.asyncio
async def test_release_none_req_id_ignored():
    manager = MessageQueueManager(max_depth=3)
    mock_repo = MagicMock()
    mock_repo.acquire_lock = AsyncMock(return_value=1)
    mock_repo.release_lock = AsyncMock()
    manager.repo = mock_repo

    req_id = await manager.acquire("session-none-test")
    assert manager.depths["session-none-test"] == 1

    # Calling release with req_id=None should be ignored (no depth decrement, state unchanged)
    await manager.release("session-none-test", None)
    assert manager.depths["session-none-test"] == 1
    assert manager.active_fences["session-none-test"].req_id == req_id
    mock_repo.release_lock.assert_not_called()

    # Clean up with valid release
    await manager.release("session-none-test", req_id)
    assert "session-none-test" not in manager.depths
