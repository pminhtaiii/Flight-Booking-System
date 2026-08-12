import pytest
from unittest.mock import AsyncMock, patch

from agent.graph.state import AgentState
from agent.graph.nodes import validate_handoff, create_handoff_token
from agent.tools.nestjs_client import NestJSClient

@pytest.fixture
def mock_nestjs_client():
    client = AsyncMock(spec=NestJSClient)
    return client

@pytest.mark.asyncio
async def test_validate_handoff_no_signal():
    state = AgentState(signal=None)
    result = await validate_handoff(state, None)
    assert "error" in result["action"]

@pytest.mark.asyncio
async def test_validate_handoff_invalid_snapshot():
    state = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot=None
    )
    result = await validate_handoff(state, None)
    assert "error" in result["action"]

@pytest.mark.asyncio
async def test_validate_handoff_success():
    state = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot={"version": 1, "attestation": "valid", "offers": ["offer1", "offer2"]}
    )
    result = await validate_handoff(state, None)
    assert result == {}  # Assuming no state update on success, just passes through

@pytest.mark.asyncio
async def test_create_handoff_token():
    state = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot={
            "version": 1,
            "attestation": "test_attestation"
        }
    )
    
    mock_client = AsyncMock()
    mock_client.create_handoff.return_value = {
        "handoffToken": "test_token",
        "expiresAt": "2026-08-07T12:00:00Z"
    }

    with (
        patch("agent.graph.nodes.get_settings") as get_settings,
        patch("agent.graph.nodes.get_nestjs_client", return_value=mock_client),
    ):
        get_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        result = await create_handoff_token(state, None)
        
    assert "action" in result
    assert result["action"]["action"] == "begin_checkout"
    assert result["action"]["handoffToken"] == "test_token"


# User approved T093 security regression coverage on 2026-08-10.
@pytest.mark.asyncio
async def test_create_handoff_token_redacts_upstream_failure_details():
    state = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot={
            "version": 1,
            "attestation": "test_attestation",
        },
    )
    mock_client = AsyncMock()
    mock_client.create_handoff.side_effect = RuntimeError(
        "request failed for https://supplier.invalid/off_sensitive"
    )

    with (
        patch("agent.graph.nodes.get_settings") as get_settings,
        patch("agent.graph.nodes.get_nestjs_client", return_value=mock_client),
    ):
        get_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = True
        result = await create_handoff_token(state, None)

    assert result == {
        "action": {"error": "Checkout handoff could not be created."}
    }
    assert "supplier.invalid" not in str(result)
    assert "off_sensitive" not in str(result)

@pytest.mark.asyncio
async def test_create_handoff_token_client_not_exposed():
    from agent.tools.registry import get_tools
    tools = get_tools()
    tool_names = [t.name for t in tools]
    assert "create_handoff_token" not in tool_names
    assert "validate_handoff" not in tool_names
