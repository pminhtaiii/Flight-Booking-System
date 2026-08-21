import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import jwt
import pytest
from langchain_core.messages import AIMessageChunk

from agent.config import get_settings
from agent.main import active_streams, app

JWT_SECRET = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"


def get_auth_headers(payload_data=None):
    payload = {
        "sub": "12345",
        "email": "test@example.com",
        "iss": "booking-systems-api",
        "aud": "booking-systems-clients",
        "jti": "test-jti-12345",
        "exp": int(time.time()) + 100,
    }
    if payload_data:
        payload.update(payload_data)
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


def parse_sse(lines):
    events = []
    current_event = {}
    for line in lines:
        if isinstance(line, bytes):
            line = line.decode("utf-8")
        line = line.strip()
        if not line:
            if current_event:
                events.append(current_event)
                current_event = {}
            continue
        if ":" in line:
            key, val = line.split(":", 1)
            key = key.strip()
            val = val.strip()
            if key == "event":
                current_event["event"] = val
            elif key == "data":
                import json

                current_event["data"] = json.loads(val)
    if current_event:
        events.append(current_event)
    return events


@pytest.mark.asyncio
async def test_stream_success_path(monkeypatch):
    headers = get_auth_headers()

    # 1. Mock guardrails to allow
    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = True
    mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

    # 2. Mock NestJSClient methods and Redis/Budget
    monkeypatch.setattr("agent.middleware.rate_limit.get_redis_client", lambda: MagicMock())
    monkeypatch.setattr(
        "agent.middleware.rate_limit.ChatBudgetRepository.admit_request", AsyncMock()
    )
    monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: MagicMock())
    monkeypatch.setattr(
        "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request", AsyncMock()
    )
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.check_user_access",
        AsyncMock(return_value={"allowed": True}),
    )
    mock_get_memory = AsyncMock(
        return_value={
            "recentMessages": [
                {"sender": "USER", "content": "hello agent"},
                {"sender": "AGENT", "content": "hello user"},
            ],
            "summary": "Previous travel plans summarized",
        }
    )
    mock_create_batch = AsyncMock(
        return_value={
            "messages": [
                {"id": "user-msg-123", "sender": "USER"},
                {"id": "agent-msg-456", "sender": "AGENT"},
            ]
        }
    )
    monkeypatch.setattr("agent.tools.nestjs_client.NestJSClient.get_memory", mock_get_memory)
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.create_message_batch", mock_create_batch
    )
    monkeypatch.setattr("agent.memory.manager.MemoryManager.check_and_summarize", AsyncMock())

    # 3. Mock graph.astream_events
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {"event": "on_chat_model_stream", "data": {"chunk": AIMessageChunk(content="Hello ")}}
        yield {"event": "on_chat_model_stream", "data": {"chunk": AIMessageChunk(content="there ")}}
        yield {"event": "on_chat_model_stream", "data": {"chunk": AIMessageChunk(content="human!")}}

    mock_graph.astream_events = mock_astream_events

    mock_state = MagicMock()
    mock_state.next = ()
    from langchain_core.messages import HumanMessage

    mock_state.values = {"messages": [HumanMessage(content="how are you?")]}
    mock_graph.aget_state = AsyncMock(return_value=mock_state)

    with patch("agent.streaming.sse.graph", mock_graph):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            async with ac.stream(
                "POST",
                "/chat/stream",
                json={"message": "how are you?", "sessionId": "session-123"},
                headers=headers,
            ) as response:
                assert response.status_code == 200
                lines = []
                async for line in response.aiter_lines():
                    lines.append(line)

                events = parse_sse(lines)

                # Check events
                token_events = [e for e in events if e["event"] == "token"]
                done_events = [e for e in events if e["event"] == "done"]

                assert len(token_events) == 3
                assert token_events[0]["data"]["content"] == "Hello "
                assert token_events[1]["data"]["content"] == "there "
                assert token_events[2]["data"]["content"] == "human!"

                assert len(done_events) == 1
                assert done_events[0]["data"]["sessionId"] == "session-123"
                assert done_events[0]["data"]["messageId"] == "agent-msg-456"

                # Verify NestJS calls
                settings = get_settings()
                assert mock_get_memory.call_count == 1
                mock_get_memory.assert_called_once_with(
                    "session-123", recent_count=settings.MEMORY_WINDOW_SIZE
                )
                assert mock_create_batch.call_count == 2
                mock_create_batch.assert_any_call(
                    "session-123",
                    [{"sender": "USER", "type": "STANDARD", "content": "how are you?"}],
                )
                mock_create_batch.assert_any_call(
                    "session-123",
                    [{"sender": "AGENT", "type": "STANDARD", "content": "Hello there human!"}],
                )


@pytest.mark.asyncio
async def test_stream_llm_error_path(monkeypatch):
    headers = get_auth_headers()

    # 1. Mock guardrails to allow
    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = True
    mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

    # 2. Mock NestJSClient methods and Redis/Budget
    monkeypatch.setattr("agent.middleware.rate_limit.get_redis_client", lambda: MagicMock())
    monkeypatch.setattr(
        "agent.middleware.rate_limit.ChatBudgetRepository.admit_request", AsyncMock()
    )
    monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: MagicMock())
    monkeypatch.setattr(
        "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request", AsyncMock()
    )
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.check_user_access",
        AsyncMock(return_value={"allowed": True}),
    )
    mock_get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_create_batch = AsyncMock(
        return_value={
            "messages": [
                {"id": "user-msg-err-123", "sender": "USER"},
                {"id": "agent-partial-msg-456", "sender": "AGENT"},
            ]
        }
    )
    monkeypatch.setattr("agent.tools.nestjs_client.NestJSClient.get_memory", mock_get_memory)
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.create_message_batch", mock_create_batch
    )

    # 3. Mock graph.astream_events to raise exception mid-stream
    mock_graph = MagicMock()

    async def mock_astream_error(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": AIMessageChunk(content="Partial answer...")},
        }
        raise ValueError("Simulated LLM connection error")

    mock_graph.astream_events = mock_astream_error

    mock_state = MagicMock()
    mock_state.next = ()
    from langchain_core.messages import HumanMessage

    mock_state.values = {"messages": [HumanMessage(content="fail for me")]}
    mock_graph.aget_state = AsyncMock(return_value=mock_state)

    with patch("agent.streaming.sse.graph", mock_graph):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            async with ac.stream(
                "POST",
                "/chat/stream",
                json={"message": "fail for me", "sessionId": "session-456"},
                headers=headers,
            ) as response:
                assert response.status_code == 200
                lines = []
                async for line in response.aiter_lines():
                    lines.append(line)

                events = parse_sse(lines)

                # Check events
                token_events = [e for e in events if e["event"] == "token"]
                error_events = [e for e in events if e["event"] == "error"]

                assert len(token_events) == 1
                assert token_events[0]["data"]["content"] == "Partial answer..."

                assert len(error_events) == 1
                assert error_events[0]["data"]["code"] == "LLM_ERROR"
                assert error_events[0]["data"]["partialMessageId"] == "agent-partial-msg-456"

                # Verify NestJS calls
                settings = get_settings()
                mock_get_memory.assert_called_once_with(
                    "session-456", recent_count=settings.MEMORY_WINDOW_SIZE
                )
                assert mock_create_batch.call_count == 2
                mock_create_batch.assert_any_call(
                    "session-456",
                    [{"sender": "USER", "type": "STANDARD", "content": "fail for me"}],
                )
                mock_create_batch.assert_any_call(
                    "session-456",
                    [{"sender": "AGENT", "type": "STANDARD", "content": "Partial answer..."}],
                )


@pytest.mark.asyncio
async def test_stream_connection_drop_path(monkeypatch):
    headers = get_auth_headers()

    # 1. Mock guardrails to allow
    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = True
    mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

    # 2. Mock NestJSClient methods and Redis/Budget
    monkeypatch.setattr("agent.middleware.rate_limit.get_redis_client", lambda: MagicMock())
    monkeypatch.setattr(
        "agent.middleware.rate_limit.ChatBudgetRepository.admit_request", AsyncMock()
    )
    monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: MagicMock())
    monkeypatch.setattr(
        "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request", AsyncMock()
    )
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.check_user_access",
        AsyncMock(return_value={"allowed": True}),
    )
    mock_get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})

    call_event = asyncio.Event()

    async def mock_create_batch_side_effect(*args, **kwargs):
        call_event.set()
        return {
            "messages": [
                {"id": "dropped-user-id", "sender": "USER"},
                {"id": "dropped-agent-id", "sender": "AGENT"},
            ]
        }

    mock_create_batch = AsyncMock(side_effect=mock_create_batch_side_effect)

    monkeypatch.setattr("agent.tools.nestjs_client.NestJSClient.get_memory", mock_get_memory)
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.create_message_batch", mock_create_batch
    )

    # 3. Mock graph.astream_events to stream slowly
    mock_graph = MagicMock()

    async def mock_astream_slow(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": AIMessageChunk(content="First chunk")},
        }
        await asyncio.sleep(0.5)
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": AIMessageChunk(content="Second chunk")},
        }

    mock_graph.astream_events = mock_astream_slow

    mock_state = MagicMock()
    mock_state.next = ()
    from langchain_core.messages import HumanMessage

    mock_state.values = {"messages": [HumanMessage(content="drop me")]}
    mock_graph.aget_state = AsyncMock(return_value=mock_state)

    # Clear active streams
    active_streams.clear()

    with patch("agent.streaming.sse.graph", mock_graph):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            # We open the stream, read one line, and then close the connection (exit the block)
            async with ac.stream(
                "POST",
                "/chat/stream",
                json={"message": "drop me", "sessionId": "session-drop"},
                headers=headers,
            ) as response:
                assert response.status_code == 200
                async for line in response.aiter_lines():
                    # We exit as soon as we get the first line/event containing content
                    if "First chunk" in line:
                        break

            # Now the connection is dropped.
            # We wait for the background persistence task to execute and call the database
            await asyncio.wait_for(call_event.wait(), timeout=2.0)

            # Assert that create_message_batch was called
            assert mock_create_batch.call_count == 2
            user_call_args = mock_create_batch.mock_calls[0].args
            assert user_call_args[0] == "session-drop"
            assert user_call_args[1][0]["sender"] == "USER"
            assert user_call_args[1][0]["content"] == "drop me"

            agent_call_args = mock_create_batch.mock_calls[1].args
            assert agent_call_args[0] == "session-drop"
            assert agent_call_args[1][0]["sender"] == "AGENT"
            assert "First chunk" in agent_call_args[1][0]["content"]


@pytest.mark.asyncio
async def test_memory_manager_persists_summary_via_service_auth(monkeypatch):
    from agent.memory.manager import MemoryManager
    from agent.tools.nestjs_client import NestJSClient

    client = NestJSClient(base_url="http://localhost:3001/api", token="mock-jwt-token")
    mock_get_memory = AsyncMock(
        return_value={
            "totalMessageCount": 25,
            "recentMessages": [{"sender": "USER", "content": f"msg {i}"} for i in range(25)],
            "summary": "Existing summary",
        }
    )
    mock_create_message = AsyncMock(return_value={"id": "summary-msg-123"})
    monkeypatch.setattr(client, "get_memory", mock_get_memory)
    monkeypatch.setattr(client, "create_message", mock_create_message)

    # Mock get_chat_model
    mock_model = MagicMock()
    mock_model.ainvoke = AsyncMock(return_value=MagicMock(content="New consolidated summary"))
    monkeypatch.setattr("agent.memory.manager.get_chat_model", lambda: mock_model)

    manager = MemoryManager(window_size=20, token_budget=10)  # very low budget to trigger summary
    await manager.check_and_summarize("session-summary-test", client, total_count=25)

    mock_create_message.assert_called_once_with(
        session_id="session-summary-test",
        sender="AGENT",
        message_type="SUMMARY",
        content="New consolidated summary",
    )


@pytest.mark.asyncio
async def test_session_restart_resume_with_decrypted_history(monkeypatch):
    headers = get_auth_headers()

    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = True
    mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)

    monkeypatch.setattr("agent.middleware.rate_limit.get_redis_client", lambda: MagicMock())
    monkeypatch.setattr(
        "agent.middleware.rate_limit.ChatBudgetRepository.admit_request", AsyncMock()
    )
    monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: MagicMock())
    monkeypatch.setattr(
        "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request", AsyncMock()
    )
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.check_user_access",
        AsyncMock(return_value={"allowed": True}),
    )
    mock_get_memory = AsyncMock(
        return_value={
            "recentMessages": [
                {"sender": "USER", "content": "Book flight to Tokyo"},
                {"sender": "AGENT", "content": "I found flight VN300 to Tokyo"},
            ],
            "summary": "User requested flight to Tokyo",
        }
    )
    mock_create_batch = AsyncMock(
        return_value={
            "messages": [{"id": "msg-u2", "sender": "USER"}, {"id": "msg-a2", "sender": "AGENT"}]
        }
    )
    monkeypatch.setattr("agent.tools.nestjs_client.NestJSClient.get_memory", mock_get_memory)
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.create_message_batch", mock_create_batch
    )
    monkeypatch.setattr("agent.memory.manager.MemoryManager.check_and_summarize", AsyncMock())

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": AIMessageChunk(content="Resuming session for Tokyo flight.")},
        }

    mock_graph.astream_events = mock_astream_events

    mock_state = MagicMock()
    mock_state.next = ()
    from langchain_core.messages import HumanMessage

    mock_state.values = {"messages": [HumanMessage(content="What is the price?")]}
    mock_graph.aget_state = AsyncMock(return_value=mock_state)

    with patch("agent.streaming.sse.graph", mock_graph):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            async with ac.stream(
                "POST",
                "/chat/stream",
                json={"message": "What is the price?", "sessionId": "session-resume-123"},
                headers=headers,
            ) as response:
                assert response.status_code == 200
                lines = [line async for line in response.aiter_lines()]
                events = parse_sse(lines)

                done_events = [e for e in events if e["event"] == "done"]
                assert len(done_events) == 1
                assert done_events[0]["data"]["sessionId"] == "session-resume-123"
