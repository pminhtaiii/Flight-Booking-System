import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from langchain_core.messages import AIMessage

from agent.config import get_settings
from agent.main import app
from agent.models.requests import RouteDecision
from tests.test_sse_integration import MockStreamingLLM, get_auth_headers, parse_sse


@pytest.fixture
def mock_nestjs_client():
    client = MagicMock()
    client.check_user_access = AsyncMock(return_value={"allowed": True})
    client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    client.create_message_batch = AsyncMock(
        return_value={
            "messages": [
                {"id": "msg-user-123", "sender": "USER"},
                {"id": "msg-agent-456", "sender": "AGENT"},
            ]
        }
    )
    return client


@pytest.mark.asyncio
async def test_first_chunk_unsafe(mock_nestjs_client, monkeypatch):
    # Enable guardrail in settings
    settings = get_settings()
    monkeypatch.setattr(settings, "OUTPUT_GUARDRAIL_ENABLED", True)

    # Mock guardrail to return UNSAFE for everything
    mock_gr = MagicMock()
    mock_gr.is_healthy.return_value = True
    mock_gr.validate_message = AsyncMock(return_value=(True, ""))
    mock_gr.validate_output_chunk = AsyncMock(
        return_value=(False, "Safety check violation: prompt unsafe.")
    )
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)

    headers = get_auth_headers()
    llm = MockStreamingLLM(responses=[AIMessage(content="Unsafe chunk right away.")])

    # Spy on the structured "agent.guardrails" logger
    import logging

    guardrails_logger = logging.getLogger("agent.guardrails")
    log_spy = MagicMock()
    monkeypatch.setattr(guardrails_logger, "warning", log_spy)

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False),
        ),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "trigger first chunk block", "sessionId": "session-first-unsafe"},
                headers=headers,
            )
            assert response.status_code == 200

            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)

            token_events = [e for e in events if e["event"] == "token"]
            error_events = [e for e in events if e["event"] == "error"]
            done_events = [e for e in events if e["event"] == "done"]

            # Verify no token events were sent
            assert len(token_events) == 0

            # Verify done event is NOT sent
            assert len(done_events) == 0

            # Verify error event is sent with partialMessageId=None
            assert len(error_events) == 1
            assert error_events[0]["data"]["code"] == "OUTPUT_GUARDRAIL_BLOCKED"
            assert error_events[0]["data"]["partialMessageId"] is None

            # Verify the stream terminates after the error event
            assert events[-1]["event"] == "error"

            # Ensure user message is persisted but agent message is not
            assert mock_nestjs_client.create_message_batch.call_count == 1
            assert (
                mock_nestjs_client.create_message_batch.mock_calls[0].args[1][0]["sender"] == "USER"
            )

            # Verify structured JSON security warning is logged correctly
            log_spy.assert_called_once()
            log_payload = json.loads(log_spy.call_args[0][0])
            assert log_payload["event"] == "security_block"
            assert log_payload["session_id"] == "session-first-unsafe"
            assert log_payload["guardrail_layer"] == "nemo"
            assert log_payload["rule_name"] == "Safety check violation: prompt unsafe."
            assert log_payload["message"] == "LLM output blocked by guardrail"


@pytest.mark.asyncio
async def test_mid_stream_chunk_unsafe(mock_nestjs_client, monkeypatch):
    # Enable guardrail in settings
    settings = get_settings()
    monkeypatch.setattr(settings, "OUTPUT_GUARDRAIL_ENABLED", True)

    # Mock guardrail: first chunk is safe, second is UNSAFE
    mock_gr = MagicMock()
    mock_gr.is_healthy.return_value = True
    mock_gr.validate_message = AsyncMock(return_value=(True, ""))

    async def mock_validate_chunk(chunk: str):
        if "unsafe" in chunk.lower():
            return False, "Output safety violation: unsafe text."
        return True, ""

    mock_gr.validate_output_chunk = AsyncMock(side_effect=mock_validate_chunk)
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)

    headers = get_auth_headers()
    # Sentence split boundary is ". " followed by capital letter
    llm = MockStreamingLLM(responses=[AIMessage(content="Safe chunk. This is unsafe content.")])

    # Spy on the structured "agent.guardrails" logger
    import logging

    guardrails_logger = logging.getLogger("agent.guardrails")
    log_spy = MagicMock()
    monkeypatch.setattr(guardrails_logger, "warning", log_spy)

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False),
        ),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "trigger mid safety block", "sessionId": "session-mid-unsafe"},
                headers=headers,
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

            # done event is NOT sent
            assert len(done_events) == 0

            # Unsafe chunk causes error event instead of streaming, with partialMessageId populated
            assert len(error_events) == 1
            assert error_events[0]["data"]["code"] == "OUTPUT_GUARDRAIL_BLOCKED"
            assert error_events[0]["data"]["partialMessageId"] == "msg-agent-456"

            # Verify the stream terminates after the error event
            assert events[-1]["event"] == "error"

            # NestJSClient should have been called to persist the preceding safe chunks and user message
            assert mock_nestjs_client.create_message_batch.call_count == 2
            call_args = mock_nestjs_client.create_message_batch.mock_calls[1].args
            payload = call_args[1]
            assert len(payload) == 1
            assert payload[0]["content"] == "Safe chunk. "

            # Verify structured JSON security warning is logged correctly
            log_spy.assert_called_once()
            log_payload = json.loads(log_spy.call_args[0][0])
            assert log_payload["event"] == "security_block"
            assert log_payload["session_id"] == "session-mid-unsafe"
            assert log_payload["guardrail_layer"] == "nemo"
            assert log_payload["rule_name"] == "Output safety violation: unsafe text."
            assert log_payload["message"] == "LLM output blocked by guardrail"


@pytest.mark.asyncio
async def test_nestjs_persistence_fails(mock_nestjs_client, monkeypatch):
    # Enable guardrail in settings
    settings = get_settings()
    monkeypatch.setattr(settings, "OUTPUT_GUARDRAIL_ENABLED", True)

    # Mock NestJS Client to raise an exception on persistence for the agent message
    mock_nestjs_client.create_message_batch = AsyncMock(
        side_effect=[{"messages": []}, Exception("Database connection error")]
    )

    # Mock guardrail: first chunk is safe, second is UNSAFE
    mock_gr = MagicMock()
    mock_gr.is_healthy.return_value = True
    mock_gr.validate_message = AsyncMock(return_value=(True, ""))

    async def mock_validate_chunk(chunk: str):
        if "unsafe" in chunk.lower():
            return False, "Output safety violation: unsafe content."
        return True, ""

    mock_gr.validate_output_chunk = AsyncMock(side_effect=mock_validate_chunk)
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)

    headers = get_auth_headers()
    llm = MockStreamingLLM(responses=[AIMessage(content="Safe chunk. This is unsafe content.")])

    # Spy on the structured "agent.guardrails" logger
    import logging

    guardrails_logger = logging.getLogger("agent.guardrails")
    log_spy = MagicMock()
    monkeypatch.setattr(guardrails_logger, "warning", log_spy)

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.agents.chat_agent.ChatOpenAI", return_value=llm),
        patch(
            "agent.graph.graph.invoke_router",
            return_value=RouteDecision(intent="SEARCH", confidence=1.0, isCommitment=False),
        ),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={
                    "message": "trigger persistence failure",
                    "sessionId": "session-persist-fail",
                },
                headers=headers,
            )
            assert response.status_code == 200

            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)

            token_events = [e for e in events if e["event"] == "token"]
            error_events = [e for e in events if e["event"] == "error"]
            done_events = [e for e in events if e["event"] == "done"]

            # Safe token should still be yielded
            assert len(token_events) == 1
            assert token_events[0]["data"]["content"] == "Safe chunk. "

            # done event is NOT sent
            assert len(done_events) == 0

            # Verify error event is sent with partialMessageId=None
            assert len(error_events) == 1
            assert error_events[0]["data"]["code"] == "OUTPUT_GUARDRAIL_BLOCKED"
            assert error_events[0]["data"]["partialMessageId"] is None

            # Verify the stream terminates after the error event
            assert events[-1]["event"] == "error"

            # Verify structured JSON warning was still logged
            log_spy.assert_called_once()
            log_payload = json.loads(log_spy.call_args[0][0])
            assert log_payload["event"] == "security_block"
            assert log_payload["session_id"] == "session-persist-fail"
            assert log_payload["guardrail_layer"] == "nemo"
            assert log_payload["rule_name"] == "Output safety violation: unsafe content."
            assert log_payload["message"] == "LLM output blocked by guardrail"
