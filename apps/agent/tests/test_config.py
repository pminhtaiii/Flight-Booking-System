import os
import pytest
from pydantic import ValidationError
from unittest.mock import AsyncMock, patch
# Assuming we will create this
from agent.config import Settings
from agent.graph.nodes import create_handoff_token
from agent.graph.state import AgentState

def test_agent_config_defaults():
    # Will fail until we implement the actual Settings with defaults
    settings = Settings()
    
    assert settings.FEATURE_FLAG_CHAT_MULTI_AGENT is False
    assert settings.REDIS_URL is not None
    assert settings.CHAT_QUOTA_DAILY > 0
    assert settings.CHAT_QUOTA_BURST > 0

def test_agent_config_rejects_issue_true_accept_false():
    with pytest.raises(ValidationError):
        Settings(
            FEATURE_FLAG_CHAT_HANDOFF_ISSUE=True,
            FEATURE_FLAG_CHAT_HANDOFF_ACCEPT=False
        )


@pytest.mark.asyncio
async def test_agent_does_not_invoke_handoff_create_when_issue_is_disabled():
    state = AgentState(
        signal={"offer_index": 1},
        trusted_snapshot={
            "version": 1,
            "attestation": "test_attestation",
            "fingerprint": "test_fingerprint",
        },
    )
    client = AsyncMock()

    with (
        patch("agent.graph.nodes.get_settings") as get_settings,
        patch("agent.graph.nodes.get_nestjs_client", return_value=client),
    ):
        get_settings.return_value.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = False
        result = await create_handoff_token(state, None)

    client.create_handoff.assert_not_awaited()
    assert result == {"action": {"error": "Chat handoff issuance is disabled."}}
