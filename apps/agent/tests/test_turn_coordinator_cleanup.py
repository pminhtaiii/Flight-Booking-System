"""Public turn-lifecycle regressions for cancellation and persistence cleanup."""

import asyncio
from collections.abc import AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent.chat_turn import ChatTurnCommand, ChatTurnRunner, ErrorEvent, TokenEvent


class RecordingPipeline:
    def __init__(self, order: list[str]) -> None:
        self.order = order
        self.closed = False
        self.flushed = False

    async def process_token(self, token: str) -> AsyncIterator[str]:
        yield token

    async def flush(self) -> AsyncIterator[str]:
        self.flushed = True
        if False:
            yield ""

    async def aclose(self) -> None:
        self.order.append("pipeline_closed")
        self.closed = True


@pytest.mark.asyncio
async def test_partial_persistence_timeout_finishes_before_pipeline_close_and_lease_release() -> (
    None
):
    order: list[str] = []
    batch_task: asyncio.Task[object] | None = None
    pipeline = RecordingPipeline(order)

    async def create_batch(
        _session_id: str, messages: list[dict[str, object]]
    ) -> dict[str, object]:
        nonlocal batch_task
        if messages[0]["sender"] == "USER":
            return {"messages": []}
        batch_task = asyncio.current_task()
        order.append("batch_started")
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            order.append("batch_cancelled")
            raise
        return {"messages": []}

    async def release(_session_id: str, _req_id: str) -> None:
        order.append("lease_released")

    client = MagicMock()
    client.create_message_batch = AsyncMock(side_effect=create_batch)
    client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    queue = MagicMock()
    queue.acquire = AsyncMock(return_value="request")
    queue.get_fence.return_value = 1
    queue.validate_active_fence = AsyncMock(return_value=True)
    queue.release = AsyncMock(side_effect=release)

    async def graph_events(*_args: object, **_kwargs: object) -> AsyncIterator[dict[str, object]]:
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="safe partial")},
        }
        raise RuntimeError("provider failed")

    graph = MagicMock()
    graph.astream_events = graph_events
    runner = ChatTurnRunner(
        graph=graph,
        queue_manager=queue,
        client_factory=lambda **_kwargs: client,
        redis_client=MagicMock(),
    )
    command = ChatTurnCommand(
        user_id="user", session_id="session", message="question", token="token"
    )
    try:
        with patch("agent.chat_turn.runner.OutputStreamSession", return_value=pipeline):
            events = [event async for event in runner.run(command)]
        assert any(isinstance(event, TokenEvent) for event in events)
        assert [event.data.code for event in events if isinstance(event, ErrorEvent)] == [
            "LLM_ERROR"
        ]
        assert order == [
            "batch_started",
            "batch_cancelled",
            "pipeline_closed",
            "lease_released",
        ]
        assert pipeline.flushed is False
    finally:
        if batch_task is not None and not batch_task.done():
            batch_task.cancel()
            await asyncio.gather(batch_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_repeated_turn_cancellation_completes_cleanup_before_exit() -> None:
    order: list[str] = []
    token_seen = asyncio.Event()
    cleanup_fence_started = asyncio.Event()
    allow_cleanup_fence = asyncio.Event()
    pipeline = RecordingPipeline(order)
    fence_calls = 0

    async def validate_fence(_session_id: str) -> bool:
        nonlocal fence_calls
        fence_calls += 1
        if fence_calls == 2:
            cleanup_fence_started.set()
            await allow_cleanup_fence.wait()
        return True

    async def release(_session_id: str, _req_id: str) -> None:
        order.append("lease_released")

    async def create_batch(
        _session_id: str, messages: list[dict[str, object]]
    ) -> dict[str, object]:
        if messages[0]["sender"] == "AGENT":
            order.append("partial_persisted")
        return {"messages": [{"sender": "AGENT", "id": "partial-id"}]}

    client = MagicMock()
    client.create_message_batch = AsyncMock(side_effect=create_batch)
    client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    queue = MagicMock()
    queue.acquire = AsyncMock(return_value="request")
    queue.get_fence.return_value = 1
    queue.validate_active_fence = AsyncMock(side_effect=validate_fence)
    queue.release = AsyncMock(side_effect=release)

    async def graph_events(*_args: object, **_kwargs: object) -> AsyncIterator[dict[str, object]]:
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="safe partial")},
        }
        await asyncio.Event().wait()

    graph = MagicMock()
    graph.astream_events = graph_events
    runner = ChatTurnRunner(
        graph=graph,
        queue_manager=queue,
        client_factory=lambda **_kwargs: client,
        redis_client=MagicMock(),
    )
    command = ChatTurnCommand(
        user_id="user", session_id="session", message="question", token="token"
    )

    async def consume() -> None:
        async for event in runner.run(command):
            if isinstance(event, TokenEvent):
                token_seen.set()

    with patch("agent.chat_turn.runner.OutputStreamSession", return_value=pipeline):
        turn_task = asyncio.create_task(consume())
        try:
            await asyncio.wait_for(token_seen.wait(), timeout=2)
            turn_task.cancel()
            await asyncio.wait_for(cleanup_fence_started.wait(), timeout=2)
            turn_task.cancel()
            allow_cleanup_fence.set()
            result = await asyncio.wait_for(
                asyncio.gather(turn_task, return_exceptions=True), timeout=3
            )
            assert isinstance(result[0], asyncio.CancelledError)
            assert order == ["partial_persisted", "pipeline_closed", "lease_released"]
            assert pipeline.flushed is False
        finally:
            allow_cleanup_fence.set()
            if not turn_task.done():
                turn_task.cancel()
                await asyncio.gather(turn_task, return_exceptions=True)
