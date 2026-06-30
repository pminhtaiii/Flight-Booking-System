import asyncio
import time
import jwt
import pytest
import httpx
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi.testclient import TestClient
from agent.main import app, active_streams

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

def test_stream_unauthorized():
    client = TestClient(app)
    
    # No token
    response = client.post("/chat/stream", json={"message": "hello", "sessionId": None})
    assert response.status_code == 401
    assert response.json()["detail"] == "Missing authorization header"
    
    # Invalid token
    response = client.post(
        "/chat/stream",
        json={"message": "hello", "sessionId": None},
        headers={"Authorization": "Bearer invalid.token.here"}
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid token"

def test_stream_message_too_long(monkeypatch):
    client = TestClient(app)
    headers = get_auth_headers()
    
    # Mock settings to have small MAX_MESSAGE_LENGTH
    from agent.config import get_settings
    settings = get_settings()
    monkeypatch.setattr(settings, "MAX_MESSAGE_LENGTH", 10)
    
    response = client.post(
        "/chat/stream",
        json={"message": "a" * 11, "sessionId": None},
        headers=headers
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Message exceeds maximum length" or response.json().get("code") == "MESSAGE_TOO_LONG"

def test_stream_guardrails_unavailable(monkeypatch):
    client = TestClient(app)
    headers = get_auth_headers()
    
    # Mock unhealthy/unavailable guardrail service
    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = False
    mock_guardrail.validate_message = AsyncMock(return_value=(False, "Safety check unavailable"))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)
    
    response = client.post(
        "/chat/stream",
        json={"message": "hello", "sessionId": None},
        headers=headers
    )
    assert response.status_code == 503

def test_stream_guardrails_blocked(monkeypatch):
    client = TestClient(app)
    headers = get_auth_headers()
    
    # Mock guardrails to block the message
    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = True
    mock_guardrail.validate_message = AsyncMock(return_value=(False, "safety violation: input blocked"))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)
    
    with client.stream(
        "POST",
        "/chat/stream",
        json={"message": "hello", "sessionId": None},
        headers=headers
    ) as response:
        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]
        
        lines = list(response.iter_lines())
        events = parse_sse(lines)
        
        assert len(events) == 1
        assert events[0]["event"] == "error"
        assert events[0]["data"]["code"] == "GUARDRAIL_BLOCKED"
        assert events[0]["data"]["message"] == "Your message could not be processed."
        assert events[0]["data"]["partialMessageId"] is None

def test_stream_with_valid_session_id(monkeypatch):
    client = TestClient(app)
    headers = get_auth_headers()
    
    # Mock guardrails to allow
    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = True
    mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)
    
    # Mock get_memory and create_message_batch
    mock_get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    monkeypatch.setattr("agent.tools.nestjs_client.NestJSClient.get_memory", mock_get_memory)
    
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
        yield AIMessageChunk(content="This ")
        yield AIMessageChunk(content="is ")
        yield AIMessageChunk(content="a ")
        yield AIMessageChunk(content="mock ")
        yield AIMessageChunk(content="response.")
    mock_model.astream = mock_astream
    
    import agent.streaming.sse
    monkeypatch.setattr(agent.streaming.sse, "get_chat_model", lambda: mock_model)
    
    with client.stream(
        "POST",
        "/chat/stream",
        json={"message": "hello", "sessionId": "session-123"},
        headers=headers
    ) as response:
        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]
        
        lines = list(response.iter_lines())
        events = parse_sse(lines)
        
        assert len(events) >= 2
        token_events = [e for e in events if e["event"] == "token"]
        done_events = [e for e in events if e["event"] == "done"]
        
        assert len(token_events) > 0
        assert len(done_events) == 1
        assert done_events[0]["data"]["sessionId"] == "session-123"
        assert "messageId" in done_events[0]["data"]

@pytest.mark.asyncio
async def test_stream_omitted_session_id(monkeypatch):
    headers = get_auth_headers()
    
    # Mock guardrails to allow
    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = True
    mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)
    
    # Mock get_memory and create_message_batch
    mock_get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    monkeypatch.setattr("agent.tools.nestjs_client.NestJSClient.get_memory", mock_get_memory)
    
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
        yield AIMessageChunk(content="This ")
        yield AIMessageChunk(content="is ")
        yield AIMessageChunk(content="a ")
        yield AIMessageChunk(content="mock ")
        yield AIMessageChunk(content="response.")
    mock_model.astream = mock_astream
    
    import agent.streaming.sse
    monkeypatch.setattr(agent.streaming.sse, "get_chat_model", lambda: mock_model)
    
    # Mock NestJSClient
    with patch("agent.tools.nestjs_client.NestJSClient.create_session", new_callable=AsyncMock) as mock_create_session:
        mock_create_session.return_value = {"id": "new-session-123", "title": "New Session"}
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            async with ac.stream(
                "POST",
                "/chat/stream",
                json={"message": "hello", "sessionId": None},
                headers=headers
            ) as response:
                assert response.status_code == 200
                lines = []
                async for line in response.aiter_lines():
                    lines.append(line)
                    
                events = parse_sse(lines)
                assert len(events) >= 2
                done_events = [e for e in events if e["event"] == "done"]
                assert len(done_events) == 1
                assert done_events[0]["data"]["sessionId"] == "new-session-123"
                mock_create_session.assert_called_once()

@pytest.mark.asyncio
async def test_stream_graceful_shutdown(monkeypatch):
    headers = get_auth_headers()
    
    # Mock guardrails to allow
    mock_guardrail = MagicMock()
    mock_guardrail.is_healthy.return_value = True
    mock_guardrail.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_guardrail, raising=False)
    
    # Mock get_memory and create_message_batch
    mock_get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    monkeypatch.setattr("agent.tools.nestjs_client.NestJSClient.get_memory", mock_get_memory)
    
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
        yield AIMessageChunk(content="This ")
        await asyncio.sleep(0.1)
        yield AIMessageChunk(content="is ")
        yield AIMessageChunk(content="a ")
        yield AIMessageChunk(content="mock ")
        yield AIMessageChunk(content="response.")
    mock_model.astream = mock_astream
    
    import agent.streaming.sse
    monkeypatch.setattr(agent.streaming.sse, "get_chat_model", lambda: mock_model)
    
    # Ensure we start with clean active_streams
    active_streams.clear()
    
    async def run_request():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            try:
                async with ac.stream(
                    "POST",
                    "/chat/stream",
                    json={"message": "hello", "sessionId": "session-123"},
                    headers=headers
                ) as response:
                    lines = []
                    async for line in response.aiter_lines():
                        lines.append(line)
                    return lines
            except Exception as e:
                return [f"error: {str(e)}"]
                
    task = asyncio.create_task(run_request())
    
    q = None
    for _ in range(50):
        if len(active_streams) > 0:
            q = list(active_streams)[0]
            break
        await asyncio.sleep(0.01)
        
    assert q is not None, "Active stream queue was not registered"
    
    shutdown_event = {
        "event": "error",
        "data": '{"code": "INTERNAL_ERROR", "message": "Server is shutting down. Connection closed.", "partialMessageId": null}'
    }
    q.put_nowait(shutdown_event)
    
    lines = await task
    events = parse_sse(lines)
    
    assert len(events) > 0
    error_events = [e for e in events if e["event"] == "error"]
    assert len(error_events) == 1
    assert error_events[0]["data"]["code"] == "INTERNAL_ERROR"
    assert "Server is shutting down" in error_events[0]["data"]["message"]
