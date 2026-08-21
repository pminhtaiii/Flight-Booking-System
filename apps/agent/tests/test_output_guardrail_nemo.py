from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from agent.guardrails.nemo import NemoGuardrailService


@pytest.fixture
def guardrail_service():
    with patch("agent.guardrails.nemo.get_settings") as mock_settings:
        mock_set = MagicMock()
        mock_set.MAX_MESSAGE_LENGTH = 1000
        mock_set.MIMO_API_URL = "http://mockmimo"
        mock_set.MIMO_API_KEY = "mockkey"
        mock_set.MIMO_MODEL_NAME = "mimo"
        mock_set.OUTPUT_GUARDRAIL_NEMO_TIMEOUT = 3.5
        mock_settings.return_value = mock_set

        service = NemoGuardrailService()
        yield service


@pytest.mark.asyncio
async def test_validate_output_chunk_safe(guardrail_service):
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_response = httpx.Response(
            200,
            json={"choices": [{"message": {"content": "SAFE"}}]},
            request=httpx.Request("POST", "http://mockmimo"),
        )
        mock_post.return_value = mock_response

        is_allowed, reason = await guardrail_service.validate_output_chunk(
            "This is a safe response chunk."
        )
        assert is_allowed is True
        assert reason == ""
        assert guardrail_service.is_healthy() is True

        # Verify the call parameters, including timeout and system prompt
        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args[1]
        assert call_kwargs.get("timeout") == 3.5

        # Verify output-specific system prompt is used
        payload = call_kwargs.get("json")
        messages = payload.get("messages", [])
        assert len(messages) == 2
        assert messages[0]["role"] == "system"
        assert "AI assistant output" in messages[0]["content"]
        assert messages[1]["role"] == "user"
        assert messages[1]["content"] == "This is a safe response chunk."


@pytest.mark.asyncio
async def test_validate_output_chunk_unsafe(guardrail_service):
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_response = httpx.Response(
            200,
            json={"choices": [{"message": {"content": "UNSAFE"}}]},
            request=httpx.Request("POST", "http://mockmimo"),
        )
        mock_post.return_value = mock_response

        is_allowed, reason = await guardrail_service.validate_output_chunk("This is unsafe output.")
        assert is_allowed is False
        assert reason == "Output safety violation."
        assert guardrail_service.is_healthy() is True


@pytest.mark.asyncio
async def test_validate_output_chunk_timeout(guardrail_service):
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = httpx.TimeoutException("API connection timed out")

        is_allowed, reason = await guardrail_service.validate_output_chunk("Chunk content")
        assert is_allowed is False
        assert reason == "Safety check unavailable."
        assert guardrail_service.is_healthy() is False


@pytest.mark.asyncio
async def test_validate_output_chunk_unexpected_response(guardrail_service):
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        # Unexpected response format or content
        mock_response = httpx.Response(
            200,
            json={"choices": [{"message": {"content": "SOMETHING_ELSE"}}]},
            request=httpx.Request("POST", "http://mockmimo"),
        )
        mock_post.return_value = mock_response

        is_allowed, reason = await guardrail_service.validate_output_chunk("Chunk content")
        assert is_allowed is False
        assert reason == "Output safety violation."
        assert guardrail_service.is_healthy() is False
