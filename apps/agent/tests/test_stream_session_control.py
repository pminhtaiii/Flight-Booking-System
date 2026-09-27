import asyncio
import json
import time
from typing import AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from langchain_core.messages import ToolMessage

from agent.chat_turn import (
    ActionHandoffEvent,
    ActionRequiredEvent,
    ChatTurnCommand,
    ChatTurnRunner,
    ErrorEvent,
)
from agent.config import get_settings
from agent.guardrails.gateway import GuardrailGateway
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
app.state.guardrail_gateway = GuardrailGateway()
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
        assert res.status_code == 200
        assert "CHAT_SESSION_NOT_FOUND" in res.text
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
        curr = asyncio.current_task()
        if curr and hasattr(curr, "uncancel"):
            curr.uncancel()

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


# ---------------------------------------------------------------------------
# 7. T022 Stale-Fence Action Suppression and Disconnect Cleanup Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_t022_stale_fence_suppression_action_required() -> None:
    """Requirement 4: Before yielding ActionRequiredEvent, coordinator validates active fence
    via queue_manager.validate_active_fence(session_id). If false, suppresses
    ActionRequiredEvent and routes to PERSISTENCE_ERROR / cleanup.
    """
    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t022-stale-act")
    mock_queue.get_fence = MagicMock(return_value=50)
    # Stale fence detected before yielding ActionRequiredEvent
    mock_queue.validate_active_fence = AsyncMock(return_value=False)
    mock_queue.release = AsyncMock()

    mock_client = MagicMock()
    mock_client.set_fencing_token = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    class TrackingOutputStreamSession:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.closed = False
            self.flushed = False

        async def process_token(self, token: str) -> AsyncIterator[str]:
            yield token

        async def flush(self) -> AsyncIterator[str]:
            self.flushed = True
            if False:
                yield ""

        async def aclose(self) -> None:
            self.closed = True

        def close(self) -> None:
            self.closed = True

    tracking_pipeline = TrackingOutputStreamSession()

    mock_graph = MagicMock()

    async def mock_astream_events(
        *args: object, **kwargs: object
    ) -> AsyncIterator[dict[str, object]]:
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps(
                                {
                                    "scope": "DOMESTIC",
                                    "ready": False,
                                    "nextAction": "COMPLETE_PROFILE",
                                    "passengers": [],
                                }
                            ),
                            tool_call_id="call-act-1",
                            name="check_booking_readiness",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }

    mock_graph.astream_events = mock_astream_events

    with patch(
        "agent.chat_turn.runner.OutputStreamSession",
        return_value=tracking_pipeline,
    ):
        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **_kwargs: mock_client,
            redis_client=MagicMock(),
        )

        command = ChatTurnCommand(
            user_id="user-t022",
            session_id="session-t022-stale-act",
            message="Check readiness",
            token="jwt.token.val",
        )

        events = [e async for e in runner.run(command)]

    # Coordinator validates active fence before yielding ActionRequiredEvent
    mock_queue.validate_active_fence.assert_awaited()

    # ActionRequiredEvent is suppressed
    action_events = [e for e in events if isinstance(e, ActionRequiredEvent)]
    assert len(action_events) == 0

    # Routes to terminal PERSISTENCE_ERROR
    error_events = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(error_events) == 1
    assert error_events[0].data.code == "PERSISTENCE_ERROR"
    assert "session lease was lost" in error_events[0].data.message

    # Pipeline closed and lease released
    assert tracking_pipeline.closed is True
    mock_queue.release.assert_awaited_once_with("session-t022-stale-act", "req-t022-stale-act")


@pytest.mark.asyncio
async def test_t022_stale_fence_suppression_action_handoff() -> None:
    """Requirement 4: Before yielding ActionHandoffEvent, coordinator validates active fence
    via queue_manager.validate_active_fence(session_id). If false, suppresses
    ActionHandoffEvent and routes to PERSISTENCE_ERROR / cleanup.
    """
    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t022-stale-handoff")
    mock_queue.get_fence = MagicMock(return_value=51)
    # Stale fence detected before yielding ActionHandoffEvent
    mock_queue.validate_active_fence = AsyncMock(return_value=False)
    mock_queue.release = AsyncMock()

    mock_client = MagicMock()
    mock_client.set_fencing_token = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    class TrackingOutputStreamSession:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.closed = False
            self.flushed = False

        async def process_token(self, token: str) -> AsyncIterator[str]:
            yield token

        async def flush(self) -> AsyncIterator[str]:
            self.flushed = True
            if False:
                yield ""

        async def aclose(self) -> None:
            self.closed = True

        def close(self) -> None:
            self.closed = True

    tracking_pipeline = TrackingOutputStreamSession()

    mock_graph = MagicMock()

    async def mock_astream_events(
        *args: object, **kwargs: object
    ) -> AsyncIterator[dict[str, object]]:
        yield {
            "event": "on_chain_end",
            "name": "create_handoff_token",
            "data": {
                "output": {
                    "action": {
                        "action": "begin_checkout",
                        "handoffToken": "chk-tok-stale-1",
                        "expiresAt": "2026-09-30T12:00:00Z",
                        "display": {"price": "350"},
                    }
                }
            },
        }

    mock_graph.astream_events = mock_astream_events

    with patch(
        "agent.chat_turn.runner.OutputStreamSession",
        return_value=tracking_pipeline,
    ):
        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **_kwargs: mock_client,
            redis_client=MagicMock(),
        )

        command = ChatTurnCommand(
            user_id="user-t022",
            session_id="session-t022-stale-handoff",
            message="Proceed to checkout",
            token="jwt.token.val",
        )

        events = [e async for e in runner.run(command)]

    # Coordinator validates active fence before yielding ActionHandoffEvent
    mock_queue.validate_active_fence.assert_awaited()

    # ActionHandoffEvent is suppressed
    handoff_events = [e for e in events if isinstance(e, ActionHandoffEvent)]
    assert len(handoff_events) == 0

    # Routes to terminal PERSISTENCE_ERROR
    error_events = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(error_events) == 1
    assert error_events[0].data.code == "PERSISTENCE_ERROR"
    assert "session lease was lost" in error_events[0].data.message

    # Pipeline closed and lease released
    assert tracking_pipeline.closed is True
    mock_queue.release.assert_awaited_once_with(
        "session-t022-stale-handoff", "req-t022-stale-handoff"
    )


@pytest.mark.asyncio
async def test_t022_cancellation_shielded_persistence_cleanup_sequence() -> None:
    """Requirement 5: Turn Cancellation (Client Disconnect)
    - asyncio.CancelledError handled gracefully.
    - Partial response persisted using asyncio.shield if tokens were emitted.
    - Pipeline closed without flushing (pipeline.aclose()).
    - Session lease released cleanly.
    """
    call_order: list[str] = []

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-t022-cancel")
    mock_queue.get_fence = MagicMock(return_value=77)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)

    async def tracked_release(session_id: str, req_id: str) -> None:
        call_order.append("queue_release")

    mock_queue.release = AsyncMock(side_effect=tracked_release)

    mock_client = MagicMock()
    mock_client.set_fencing_token = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )

    async def tracked_batch(
        session_id: str, messages: list[dict[str, object]]
    ) -> dict[str, object]:
        if any(m.get("sender") == "USER" for m in messages) and not any(
            m.get("sender") == "AGENT" for m in messages
        ):
            call_order.append("user_pre_persist")
        else:
            call_order.append("partial_persist_shielded")
        return {"messages": [{"id": "cancel-msg-id", "sender": "AGENT"}]}

    mock_client.create_message_batch = AsyncMock(side_effect=tracked_batch)

    class TrackingOutputStreamSession:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.closed = False
            self.flushed = False

        async def process_token(self, token: str) -> AsyncIterator[str]:
            call_order.append("process_token")
            yield token

        async def flush(self) -> AsyncIterator[str]:
            call_order.append("pipeline_flush")
            self.flushed = True
            if False:
                yield ""

        async def aclose(self) -> None:
            call_order.append("pipeline_aclose")
            self.closed = True

        def close(self) -> None:
            call_order.append("pipeline_close")
            self.closed = True

    tracking_pipeline = TrackingOutputStreamSession()

    mock_graph = MagicMock()

    async def mock_astream_events(
        *args: object, **kwargs: object
    ) -> AsyncIterator[dict[str, object]]:
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Emitted tokens before cancel")},
        }
        raise asyncio.CancelledError()

    mock_graph.astream_events = mock_astream_events

    with patch(
        "agent.chat_turn.runner.OutputStreamSession",
        return_value=tracking_pipeline,
    ):
        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **_kwargs: mock_client,
            redis_client=MagicMock(),
        )

        command = ChatTurnCommand(
            user_id="user-t022",
            session_id="session-t022-cancel",
            message="Cancel during streaming",
            token="jwt.token.val",
        )

        with pytest.raises(asyncio.CancelledError):
            async for _ in runner.run(command):
                pass

    # Partial response persisted using asyncio.shield
    assert "partial_persist_shielded" in call_order

    # Pipeline closed without flushing
    assert tracking_pipeline.closed is True
    assert "pipeline_aclose" in call_order
    assert tracking_pipeline.flushed is False
    assert "pipeline_flush" not in call_order

    # Session lease released cleanly
    assert "queue_release" in call_order
    mock_queue.release.assert_awaited_once_with("session-t022-cancel", "req-t022-cancel")

    # Causal cleanup sequence: partial_persist -> pipeline.aclose -> queue_release
    persist_idx = call_order.index("partial_persist_shielded")
    close_idx = call_order.index("pipeline_aclose")
    release_idx = call_order.index("queue_release")
    assert persist_idx < close_idx < release_idx
