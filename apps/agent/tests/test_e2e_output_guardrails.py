import pytest
import httpx
import json
import jwt
from unittest.mock import AsyncMock, patch, MagicMock
from langchain_core.messages import AIMessage
from agent.main import app
from agent.config import get_settings
from tests.test_sse_integration import MockStreamingLLM, parse_sse, get_auth_headers

@pytest.fixture
def mock_nestjs_client():
    client = MagicMock()
    client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    client.create_message_batch = AsyncMock(return_value={
        "messages": [
            {"id": "msg-user-111", "sender": "USER"},
            {"id": "msg-agent-222", "sender": "AGENT"}
        ]
    })
    return client

@pytest.mark.asyncio
async def test_e2e_output_guardrail_pipeline_validation(mock_nestjs_client, monkeypatch):
    # Enable output guardrail in config
    settings = get_settings()
    monkeypatch.setattr(settings, "OUTPUT_GUARDRAIL_ENABLED", True)

    # Setup mocked NeMo guardrail service
    mock_gr = MagicMock()
    mock_gr.is_healthy.return_value = True
    mock_gr.validate_message = AsyncMock(return_value=(True, ""))
    
    # First chunk is safe, second is UNSAFE (contains "unsafe" or PII)
    async def mock_validate_chunk(chunk: str):
        if "unsafe" in chunk.lower():
            return False, "Output safety violation: unsafe text."
        return True, ""
    mock_gr.validate_output_chunk = AsyncMock(side_effect=mock_validate_chunk)
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)

    headers = get_auth_headers()
    llm = MockStreamingLLM(responses=[AIMessage(content="Chunk number one is safe. Chunk number two is unsafe.")])

    # Run the E2E stream request
    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "run e2e guardrail check", "sessionId": "session-e2e-og"},
                headers=headers
            )
            assert response.status_code == 200
            
            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)
            
            token_events = [e for e in events if e["event"] == "token"]
            error_events = [e for e in events if e["event"] == "error"]
            done_events = [e for e in events if e["event"] == "done"]
            
            # The safe chunk must be streamed
            assert len(token_events) == 1
            assert token_events[0]["data"]["content"] == "Chunk number one is safe. "
            
            # The unsafe chunk must cause an OUTPUT_GUARDRAIL_BLOCKED error
            assert len(error_events) == 1
            assert error_events[0]["data"]["code"] == "OUTPUT_GUARDRAIL_BLOCKED"
            assert error_events[0]["data"]["partialMessageId"] == "msg-agent-222"
            assert len(done_events) == 0

            # Verify NestJS Client was called to persist only the safe chunk
            mock_nestjs_client.create_message_batch.assert_called_once()
            call_args = mock_nestjs_client.create_message_batch.call_args
            payload = call_args[0][1]
            assert payload[0]["content"] == "run e2e guardrail check"
            assert payload[1]["content"] == "Chunk number one is safe. "
