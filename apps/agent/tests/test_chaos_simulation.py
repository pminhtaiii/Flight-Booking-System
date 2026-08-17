import asyncio
import json
import time
import pytest
import jwt
import httpx
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import redis.asyncio as redis

from agent.main import app
from agent.middleware.auth import JWTAuthMiddleware
from agent.middleware.rate_limit import RateLimitMiddleware
from agent.config import get_settings
from agent.repositories.chat_budget_repository import (
    ChatBudgetRepository,
    BudgetExceededException,
    RedisUnavailableException,
)
from agent.queue.message_queue import MessageQueueManager
from agent.streaming.sse import _persist_response

settings = get_settings()
SECRET = settings.JWT_SECRET
ISSUER = getattr(settings, "JWT_ISSUER", "booking-systems-api")
AUDIENCE = getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")


def make_token(user_id="user-chaos-drill-1"):
    payload = {
        "id": user_id,
        "sub": user_id,
        "jti": f"jti-{user_id}",
        "iss": ISSUER,
        "aud": AUDIENCE,
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


# =========================================================================
# Drill 1: Redis Partition / Outage Drill
# =========================================================================
@pytest.mark.asyncio
async def test_redis_partition_outage_fails_closed_before_llm_inference():
    """
    Chaos Simulation: When Redis control plane drops or is partitioned during
    quota/budget check, the stream request MUST fail-closed with HTTP 503
    CHAT_CONTROL_PLANE_UNAVAILABLE before LLM inference, without leaking burst
    reservations or incrementing daily quota.
    """
    user_id = "chaos-user-partition-1"
    token = make_token(user_id)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    mock_redis = MagicMock()
    # Simulate Redis partition / network connection drop during Lua script execution
    mock_redis.eval = AsyncMock(side_effect=redis.ConnectionError("Redis cluster partitioned / unreachable"))
    mock_redis.ping = AsyncMock(side_effect=redis.ConnectionError("Redis cluster unreachable"))

    mock_client = MagicMock()
    mock_client.check_user_access = AsyncMock(return_value={"allowed": True})

    llm_inference_called = False

    async def mock_astream_events(*args, **kwargs):
        nonlocal llm_inference_called
        llm_inference_called = True
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="leak")}}

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_client), \
         patch("agent.streaming.sse.get_redis_client", return_value=mock_redis), \
         patch("agent.streaming.sse.graph.astream_events", side_effect=mock_astream_events):

        client = TestClient(app)
        response = client.post(
            "/chat/stream",
            headers=headers,
            json={"message": "Search flights to Tokyo"},
        )

        # 1. Assert fails closed with HTTP 503 CHAT_CONTROL_PLANE_UNAVAILABLE
        assert response.status_code == 503
        data = response.json()
        assert data.get("detail") == "CHAT_CONTROL_PLANE_UNAVAILABLE" or data.get("code") == "CHAT_CONTROL_PLANE_UNAVAILABLE"

        # 2. Assert that LLM inference was NOT invoked (zero cost / zero compute leaked)
        assert llm_inference_called is False

        # 3. Assert no quota/burst reservation leaked or committed
        # Since eval threw ConnectionError, no atomic increments completed
        mock_redis.eval.assert_awaited_once()


@pytest.mark.asyncio
async def test_redis_outage_middleware_fails_closed_503():
    """
    Chaos Simulation: RateLimitMiddleware fails closed with 503 CHAT_CONTROL_PLANE_UNAVAILABLE
    on RedisUnavailableException and ConnectionError.
    """
    mock_redis = MagicMock()
    mock_redis.eval = AsyncMock(side_effect=RedisUnavailableException("Cluster connection dropped"))

    test_app = FastAPI()
    test_app.add_middleware(RateLimitMiddleware, limit=10, window=60, redis_client=mock_redis)
    test_app.add_middleware(JWTAuthMiddleware, secret=SECRET)

    @test_app.post("/chat/stream")
    async def dummy_endpoint():
        return {"result": "should_not_reach_here"}

    token = make_token("chaos-user-mid-1")
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=test_app), base_url="http://test") as client:
        res = await client.post("/chat/stream", headers=headers)
        assert res.status_code == 503
        data = res.json()
        assert data.get("code") == "CHAT_CONTROL_PLANE_UNAVAILABLE"
        assert "Control plane unavailable" in data.get("detail", "")


@pytest.mark.asyncio
async def test_redis_midstream_lock_refresh_loss_cancels_worker():
    """
    Chaos Simulation: If Redis drops mid-stream during background session lock refresh,
    MessageQueueManager cancels monitored producer tasks to prevent split-brain execution.
    """
    manager = MessageQueueManager(max_depth=3, lock_ttl_ms=5000, refresh_interval=0.05)

    session_id = "session-midstream-chaos"
    user_id = "user-midstream-1"
    worker_started = asyncio.Event()
    worker_cancelled = False

    async def worker():
        nonlocal worker_cancelled
        req = await manager.acquire(session_id, user_id=user_id)
        worker_started.set()
        try:
            while True:
                await asyncio.sleep(0.01)
        except asyncio.CancelledError:
            worker_cancelled = True
            raise
        finally:
            await manager.release(session_id, req)

    worker_task = asyncio.create_task(worker())
    await worker_started.wait()

    # Simulate Redis connection dropping during lock refresh
    manager.repo.refresh_lock = AsyncMock(side_effect=redis.ConnectionError("Redis partitioned mid-stream"))

    # Wait for worker task to be cancelled by refresher
    try:
        await worker_task
    except asyncio.CancelledError:
        pass

    # Monitored worker task must have been cancelled
    assert worker_task.done()
    assert worker_cancelled is True



# =========================================================================
# Drill 2: Abrupt Client Disconnect Drill
# =========================================================================
@pytest.mark.asyncio
async def test_abrupt_client_disconnect_releases_session_lock():
    """
    Chaos Simulation: When client abruptly disconnects during streaming (asyncio.CancelledError / aclose),
    the production sse_generator finally handler promptly releases the active session lock so
    subsequent requests can immediately proceed.
    """
    from starlette.requests import Request
    from agent.streaming.sse import chat_stream, ChatStreamRequest

    queue_manager = MessageQueueManager(max_depth=1)
    session_id = "session-disconnect-drill-1"
    user_id = "user-disconnect-1"
    token = make_token(user_id)

    mock_app = MagicMock()
    mock_app.state.message_queue = queue_manager
    mock_app.state.guardrails = None

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/chat/stream",
        "headers": [],
        "app": mock_app,
    }
    request = Request(scope)

    mock_client = MagicMock()
    mock_client.check_user_access = AsyncMock(return_value={"allowed": True})
    mock_client.create_session = AsyncMock(return_value={"id": session_id})
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": [{"id": "msg-1"}]})
    mock_client.set_fencing_token = MagicMock()

    mock_redis = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="First chunk")}}
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            raise

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_client), \
         patch("agent.streaming.sse.get_redis_client", return_value=mock_redis), \
         patch("agent.streaming.sse.graph.astream_events", side_effect=mock_astream_events), \
         patch("agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request", AsyncMock()):

        body = ChatStreamRequest(message="Search flights", sessionId=session_id)
        response = await chat_stream(
            request=request,
            body=body,
            authorization=f"Bearer {token}",
            x_trace_id="test-trace-disconnect",
            x_correlation_id="test-corr-disconnect",
        )

        gen = response.body_iterator
        # Start streaming and consume first chunk
        first_chunk = await gen.__anext__()
        assert first_chunk is not None


        # Lock is actively held during streaming
        assert queue_manager.depths.get(session_id) == 1

        # Simulate client abrupt disconnect by closing the response generator
        await gen.aclose()

        # Session lock is promptly released and depth cleared by sse_generator's finally block
        assert queue_manager.depths.get(session_id) is None
        assert session_id not in queue_manager.active_fences

        # Subsequent request can immediately acquire lock without 429
        new_req_id = await queue_manager.acquire(session_id, user_id=user_id)
        assert new_req_id is not None
        assert queue_manager.depths.get(session_id) == 1
        await queue_manager.release(session_id, new_req_id)



@pytest.mark.asyncio
async def test_stale_fencing_token_prevents_persistence_when_lease_lost():
    """
    Chaos Simulation: validate_active_fence prevents stale turn persistence
    when a session lease was lost, taken over, or expired.
    """
    mock_client = MagicMock()
    mock_client.create_message_batch = AsyncMock(return_value={"messages": [{"id": "msg-1"}]})

    mock_queue_manager = MagicMock()
    # Simulate lost/stale fence
    mock_queue_manager.validate_active_fence = AsyncMock(return_value=False)

    session_id = "session-stale-fence-1"
    user_msg = "Hello"
    response_text = "I have planned your trip."

    # Must raise RuntimeError and abort persistence
    with pytest.raises(RuntimeError, match="Session fence is no longer active"):
        await _persist_response(
            client=mock_client,
            session_id=session_id,
            user_msg=user_msg,
            response_text=response_text,
            queue_manager=mock_queue_manager,
        )

    # NestJS client create_message_batch MUST NOT have been called
    mock_client.create_message_batch.assert_not_awaited()


@pytest.mark.asyncio
async def test_disconnect_persistence_with_valid_fence_succeeds():
    """
    Chaos Simulation: When disconnect occurs and partial response exists with VALID fence,
    _persist_response validates active fence and safely persists the batch.
    """
    mock_client = MagicMock()
    mock_client.create_message_batch = AsyncMock(return_value={
        "messages": [
            {"id": "msg-u1", "sender": "USER"},
            {"id": "msg-a1", "sender": "AGENT"},
        ]
    })

    mock_queue_manager = MagicMock()
    mock_queue_manager.validate_active_fence = AsyncMock(return_value=True)

    session_id = "session-valid-fence-1"
    user_msg = "Book flight"
    response_text = "Searching for flights..."

    res = await _persist_response(
        client=mock_client,
        session_id=session_id,
        user_msg=user_msg,
        response_text=response_text,
        queue_manager=mock_queue_manager,
    )

    mock_queue_manager.validate_active_fence.assert_awaited_once_with(session_id)
    mock_client.create_message_batch.assert_awaited_once()
    assert len(res["messages"]) == 2
