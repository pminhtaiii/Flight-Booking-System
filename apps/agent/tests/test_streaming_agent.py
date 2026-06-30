import asyncio
import time
import jwt
import pytest
import httpx
from unittest.mock import AsyncMock, patch, MagicMock
from langchain_core.messages import AIMessageChunk
from agent.main import app, active_streams
from agent.config import get_settings

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
    
    # 2. Mock NestJSClient methods
    mock_get_memory = AsyncMock(return_value={
        "recentMessages": [
            {"sender": "USER", "content": "hello agent"},
            {"sender": "AGENT", "content": "hello user"}
        ],
        "summary": "Previous travel plans summarized"
    })
    mock_create_batch = AsyncMock(return_value={
        "messages": [
            {"id": "user-msg-123", "sender": "USER"},
            {"id": "agent-msg-456", "sender": "AGENT"}
        ]
    })
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.get_memory",
        mock_get_memory
    )
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.create_message_batch",
        mock_create_batch
    )
    
    # 3. Mock ChatOpenAI astream
    mock_model = MagicMock()
    async def mock_astream(*args, **kwargs):
        yield AIMessageChunk(content="Hello ")
        yield AIMessageChunk(content="there ")
        yield AIMessageChunk(content="human!")
        
    mock_model.astream = mock_astream
    
    with patch("agent.streaming.sse.get_chat_model", return_value=mock_model):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            async with ac.stream(
                "POST",
                "/chat/stream",
                json={"message": "how are you?", "sessionId": "session-123"},
                headers=headers
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
                assert mock_get_memory.call_count == 2
                for call_args in mock_get_memory.call_args_list:
                    assert call_args[0][0] == "session-123"
                    assert call_args[1]["recent_count"] == settings.MEMORY_WINDOW_SIZE
                mock_create_batch.assert_called_once_with("session-123", [
                    {"sender": "USER", "type": "STANDARD", "content": "how are you?"},
                    {"sender": "AGENT", "type": "STANDARD", "content": "Hello there human!"}
                ])

@pytest.mark.asyncio
async def test_stream_llm_error_path(monkeypatch):
    headers = get_auth_headers()
    
    # 1. Mock guardrails to allow
    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = True
    mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)
    
    # 2. Mock NestJSClient methods
    mock_get_memory = AsyncMock(return_value={
        "recentMessages": [],
        "summary": None
    })
    mock_create_batch = AsyncMock(return_value={
        "messages": [
            {"id": "user-msg-err-123", "sender": "USER"},
            {"id": "agent-partial-msg-456", "sender": "AGENT"}
        ]
    })
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.get_memory",
        mock_get_memory
    )
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.create_message_batch",
        mock_create_batch
    )
    
    # 3. Mock ChatOpenAI astream to raise exception mid-stream
    mock_model = MagicMock()
    async def mock_astream_error(*args, **kwargs):
        yield AIMessageChunk(content="Partial answer...")
        raise ValueError("Simulated LLM connection error")
        
    mock_model.astream = mock_astream_error
    
    with patch("agent.streaming.sse.get_chat_model", return_value=mock_model):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            async with ac.stream(
                "POST",
                "/chat/stream",
                json={"message": "fail for me", "sessionId": "session-456"},
                headers=headers
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
                mock_get_memory.assert_called_once_with("session-456", recent_count=settings.MEMORY_WINDOW_SIZE)
                mock_create_batch.assert_called_once_with("session-456", [
                    {"sender": "USER", "type": "STANDARD", "content": "fail for me"},
                    {"sender": "AGENT", "type": "STANDARD", "content": "Partial answer..."}
                ])

@pytest.mark.asyncio
async def test_stream_connection_drop_path(monkeypatch):
    headers = get_auth_headers()
    
    # 1. Mock guardrails to allow
    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = True
    mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)
    
    # 2. Mock NestJSClient methods
    mock_get_memory = AsyncMock(return_value={
        "recentMessages": [],
        "summary": None
    })
    
    call_event = asyncio.Event()
    async def mock_create_batch_side_effect(*args, **kwargs):
        call_event.set()
        return {
            "messages": [
                {"id": "dropped-user-id", "sender": "USER"},
                {"id": "dropped-agent-id", "sender": "AGENT"}
            ]
        }
    
    mock_create_batch = AsyncMock(side_effect=mock_create_batch_side_effect)
    
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.get_memory",
        mock_get_memory
    )
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.create_message_batch",
        mock_create_batch
    )
    
    # 3. Mock ChatOpenAI astream to stream slowly
    mock_model = MagicMock()
    async def mock_astream_slow(*args, **kwargs):
        yield AIMessageChunk(content="First chunk")
        await asyncio.sleep(0.5)
        yield AIMessageChunk(content="Second chunk")
        
    mock_model.astream = mock_astream_slow
    
    # Clear active streams
    active_streams.clear()
    
    with patch("agent.streaming.sse.get_chat_model", return_value=mock_model):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            # We open the stream, read one line, and then close the connection (exit the block)
            async with ac.stream(
                "POST",
                "/chat/stream",
                json={"message": "drop me", "sessionId": "session-drop"},
                headers=headers
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
            assert mock_create_batch.call_count == 1
            call_args = mock_create_batch.call_args
            assert call_args is not None
            assert call_args[0][0] == "session-drop"
            messages_sent = call_args[0][1]
            assert messages_sent[0]["sender"] == "USER"
            assert messages_sent[0]["content"] == "drop me"
            assert messages_sent[1]["sender"] == "AGENT"
            assert "First chunk" in messages_sent[1]["content"]
