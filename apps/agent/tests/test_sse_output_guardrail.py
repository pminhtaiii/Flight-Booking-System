import pytest
import asyncio
import httpx
import json
import time
import jwt
from unittest.mock import AsyncMock, patch, MagicMock
from langchain_core.messages import AIMessage, HumanMessage
from agent.main import app
from agent.config import get_settings
from agent.guardrails.output_pipeline import OutputGuardrailBlockedError
from tests.test_sse_integration import MockStreamingLLM, parse_sse, get_auth_headers

@pytest.fixture
def mock_nestjs_client():
    client = MagicMock()
    client.check_user_access = AsyncMock(return_value={"allowed": True})
    client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    client.create_message_batch = AsyncMock(return_value={
        "messages": [
            {"id": "msg-user-123", "sender": "USER"},
            {"id": "msg-agent-456", "sender": "AGENT"}
        ]
    })
    return client

@pytest.mark.asyncio
async def test_sse_output_guardrail_safe(mock_nestjs_client, monkeypatch):
    # Enable guardrail in settings via monkeypatch
    settings = get_settings()
    monkeypatch.setattr(settings, "OUTPUT_GUARDRAIL_ENABLED", True)

    # Enable guardrail in app state, make it validate as SAFE
    mock_gr = MagicMock()
    mock_gr.is_healthy.return_value = True
    mock_gr.validate_message = AsyncMock(return_value=(True, ""))
    mock_gr.validate_output_chunk = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)

    headers = get_auth_headers()
    # Sentence split boundary is ". " followed by capital letter
    llm = MockStreamingLLM(responses=[AIMessage(content="Hello world. This is a safe stream.")])

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "hello", "sessionId": "session-safe-og"},
                headers=headers
            )
            assert response.status_code == 200
            
            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)
            
            token_events = [e for e in events if e["event"] == "token"]
            done_events = [e for e in events if e["event"] == "done"]
            
            assert len(token_events) > 0
            assert "".join([e["data"]["content"] for e in token_events]) == "Hello world. This is a safe stream."
            assert len(done_events) == 1

@pytest.mark.asyncio
async def test_sse_output_guardrail_unsafe_blocking(mock_nestjs_client, monkeypatch):
    # Enable guardrail in settings via monkeypatch
    settings = get_settings()
    monkeypatch.setattr(settings, "OUTPUT_GUARDRAIL_ENABLED", True)

    # Enable guardrail in app state, first chunk is safe, second is UNSAFE
    mock_gr = MagicMock()
    mock_gr.is_healthy.return_value = True
    mock_gr.validate_message = AsyncMock(return_value=(True, ""))
    
    async def mock_validate_chunk(chunk: str):
        if "unsafe" in chunk.lower():
            return False, "Output safety violation."
        return True, ""
    mock_gr.validate_output_chunk = AsyncMock(side_effect=mock_validate_chunk)
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)

    headers = get_auth_headers()
    llm = MockStreamingLLM(responses=[AIMessage(content="Safe chunk. This is unsafe content.")])

    # We expect "Safe chunk. " to be validated and emitted.
    # "This is unsafe content." will cause OutputGuardrailBlockedError.
    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "trigger safety block", "sessionId": "session-unsafe-og"},
                headers=headers
            )
            assert response.status_code == 200
            
            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)
            
            token_events = [e for e in events if e["event"] == "token"]
            error_events = [e for e in events if e["event"] == "error"]
            done_events = [e for e in events if e["event"] == "done"]
            
            # The safe chunk should have been yielded
            assert len(token_events) == 1
            assert token_events[0]["data"]["content"] == "Safe chunk. "
            
            # Unsafe chunk causes error event instead of streaming, and halts done event
            assert len(error_events) == 1
            assert error_events[0]["data"]["code"] == "OUTPUT_GUARDRAIL_BLOCKED"
            assert error_events[0]["data"]["partialMessageId"] == "msg-agent-456"
            assert len(done_events) == 0
            
            # NestJSClient should have been called to persist the partial response
            mock_nestjs_client.create_message_batch.assert_called_once()
            call_args = mock_nestjs_client.create_message_batch.call_args
            payload = call_args[0][1]
            assert payload[0]["content"] == "trigger safety block"
            assert payload[1]["content"] == "Safe chunk. "

@pytest.mark.asyncio
async def test_sse_output_guardrail_disabled(mock_nestjs_client, monkeypatch):
    # Disable guardrail in settings via monkeypatch
    settings = get_settings()
    monkeypatch.setattr(settings, "OUTPUT_GUARDRAIL_ENABLED", False)

    # Mock guardrail in app state
    mock_gr = MagicMock()
    mock_gr.is_healthy.return_value = True
    mock_gr.validate_message = AsyncMock(return_value=(True, ""))
    mock_gr.validate_output_chunk = AsyncMock() # Should not be called
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)

    headers = get_auth_headers()
    llm = MockStreamingLLM(responses=[AIMessage(content="Hello world. Bypassing check.")])

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "hello", "sessionId": "session-disabled-og"},
                headers=headers
            )
            assert response.status_code == 200
            
            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)
            
            token_events = [e for e in events if e["event"] == "token"]
            done_events = [e for e in events if e["event"] == "done"]
            
            assert len(token_events) > 0
            assert "".join([e["data"]["content"] for e in token_events]) == "Hello world. Bypassing check."
            assert len(done_events) == 1
            mock_gr.validate_output_chunk.assert_not_called()
