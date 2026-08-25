import asyncio
import time
from unittest.mock import AsyncMock, patch

import jwt
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from agent.config import get_settings
from agent.middleware.auth import JWTAuthMiddleware
from agent.queue.message_queue import MessageQueueManager
from agent.repositories.session_lock_repository import SessionLockRepository
from agent.streaming.sse import _persist_response
from agent.streaming.sse import router as streaming_router

settings = get_settings()
SECRET = settings.JWT_SECRET
ISSUER = getattr(settings, "JWT_ISSUER", "booking-systems-api")
AUDIENCE = getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")

app = FastAPI()
app.add_middleware(JWTAuthMiddleware, secret=SECRET, exclude_paths=["/health"])
app.include_router(streaming_router)

client = TestClient(app)


def make_token(user_id="user-123", sub="user-123", jti="jti-uuid-1"):
    payload = {
        "id": user_id,
        "sub": sub,
        "jti": jti,
        "iss": ISSUER,
        "aud": AUDIENCE,
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


# ---------------------------------------------------------------------------
# 1. Session Ownership & Cross-User Isolation Tests
# ---------------------------------------------------------------------------


def test_cross_user_session_access_returns_404_and_zero_inference():
    token_user_a = make_token(user_id="user-A", sub="user-A")
    with (
        patch("agent.streaming.sse.NestJSClient") as MockClient,
        patch("agent.streaming.sse.graph.astream_events") as mock_graph,
        patch("agent.streaming.sse._persist_response") as mock_persist,
    ):
        mock_nestjs = AsyncMock()
        mock_nestjs.check_user_access.return_value = {"allowed": True}
        mock_nestjs.get_memory.side_effect = Exception(
            "CHAT_SESSION_NOT_FOUND: Session not found or foreign owner"
        )
        MockClient.return_value = mock_nestjs

        res = client.post(
            "/chat/stream",
            json={"message": "check status", "sessionId": "foreign-session-id-123"},
            headers={"Authorization": f"Bearer {token_user_a}"},
        )
        assert res.status_code == 404
        assert "CHAT_SESSION_NOT_FOUND" in res.json().get("detail", "")
        mock_graph.assert_not_called()
        mock_persist.assert_not_called()


# ---------------------------------------------------------------------------
# 2. Distributed Serialization & Bounded Queue Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_distributed_serialization_and_queue_depth_exceeded():
    queue_manager = MessageQueueManager(max_depth=1)
    queue_manager.repo = AsyncMock(spec=SessionLockRepository)

    # First acquire succeeds
    queue_manager.repo.acquire_lock.return_value = 1
    req1 = await queue_manager.acquire("session-queue-1", "user-1")
    assert req1 is not None

    # Second acquire should fail with depth limit exceeded 429
    with pytest.raises(HTTPException) as exc_info:
        await queue_manager.acquire("session-queue-1", "user-1")

    assert exc_info.value.status_code == 429
    assert "Too many concurrent requests" in exc_info.value.detail

    # Clean up
    await queue_manager.release("session-queue-1", req1)


# ---------------------------------------------------------------------------
# 3. TTL Overrun and Fence Takeover Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ttl_overrun_and_fence_takeover():
    repo = SessionLockRepository(prefix="test:lock:ttl:")

    mock_redis = AsyncMock()
    # First acquire returns fence 1
    mock_redis.eval.side_effect = [1, None, 2, 0, None]
    mock_redis.hget.side_effect = [b"req2", b"2"]  # req1 validate returns false

    with patch(
        "agent.repositories.session_lock_repository.get_redis_client", return_value=mock_redis
    ):
        fence1 = await repo.acquire_lock("u1", "s-ttl", "req1", ttl_ms=100)
        assert fence1 == 1

        # req2 tries while req1 held -> returns None
        fence_fail = await repo.acquire_lock("u1", "s-ttl", "req2", ttl_ms=100)
        assert fence_fail is None

        # Overrun: req2 acquires higher fence
        fence2 = await repo.acquire_lock("u1", "s-ttl", "req2", ttl_ms=100)
        assert fence2 == 2
        assert fence2 > fence1

        # req1 tries to refresh -> fails (returns 0/False)
        refreshed = await repo.refresh_lock("u1", "s-ttl", "req1", fence1)
        assert refreshed is False

        # req1 tries to validate fence -> fails
        is_valid = await repo.validate_fence("u1", "s-ttl", "req1", fence1)
        assert is_valid is False


# ---------------------------------------------------------------------------
# 4. Refresh-Loss Cancellation Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_refresh_loss_cancels_monitored_tasks():
    manager = MessageQueueManager(max_depth=2)
    manager.refresh_interval = 0.05
    manager.lock_ttl_ms = 200

    mock_repo = AsyncMock(spec=SessionLockRepository)
    mock_repo.acquire_lock.return_value = 10
    # First refresh succeeds, second refresh fails (simulating lock loss)
    mock_repo.refresh_lock.side_effect = [True, False]
    manager.repo = mock_repo

    task_cancelled = False

    async def dummy_worker():
        nonlocal task_cancelled
        try:
            await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            task_cancelled = True
            raise

    worker_task = asyncio.create_task(dummy_worker())

    req_id = await manager.acquire("s-refresh-loss", "u1")
    attached = await manager.attach_task("s-refresh-loss", req_id, worker_task)
    assert attached is True

    # Wait for refresher loop to trigger refresh loss
    try:
        await asyncio.sleep(0.2)
    except asyncio.CancelledError:
        pass

    await asyncio.gather(worker_task, return_exceptions=True)

    assert task_cancelled is True
    assert worker_task.cancelled() or worker_task.done()


# ---------------------------------------------------------------------------
# 5. Disconnect / Shielded Persistence Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_disconnect_shielded_persistence():
    mock_client = AsyncMock()
    mock_client.create_message_batch.return_value = {"messages": [{"id": "m1", "sender": "AGENT"}]}

    # Calling _persist_response with use_shield=True
    res = await _persist_response(
        mock_client,
        session_id="sess-shield",
        user_msg="hello",
        response_text="world",
        user_already_persisted=False,
        use_shield=True,
    )
    assert res == {"messages": [{"id": "m1", "sender": "AGENT"}]}
    mock_client.create_message_batch.assert_called_once()


# ---------------------------------------------------------------------------
# 6. Stale-Fence Rejection Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stale_fence_rejection_prevents_persistence():
    manager = MessageQueueManager(max_depth=2)
    mock_repo = AsyncMock(spec=SessionLockRepository)
    mock_repo.validate_fence.return_value = False  # Stale fence!
    manager.repo = mock_repo

    # Add dummy active fence
    from agent.queue.message_queue import ActiveFence

    manager.active_fences["sess-stale"] = ActiveFence(
        req_id="req-stale",
        fence=5,
        refresh_task=AsyncMock(),
        user_id="u1",
    )

    is_valid = await manager.validate_active_fence("sess-stale")
    assert is_valid is False
