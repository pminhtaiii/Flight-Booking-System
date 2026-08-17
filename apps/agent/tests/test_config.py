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

def test_agent_config_flag_matrix_combinations():
    # Combination 1: ISSUE=False, ACCEPT=False (valid)
    cfg1 = Settings(
        FEATURE_FLAG_CHAT_HANDOFF_ISSUE=False,
        FEATURE_FLAG_CHAT_HANDOFF_ACCEPT=False,
    )
    assert cfg1.FEATURE_FLAG_CHAT_HANDOFF_ISSUE is False
    assert cfg1.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT is False

    # Combination 2: ISSUE=False, ACCEPT=True (valid)
    cfg2 = Settings(
        FEATURE_FLAG_CHAT_HANDOFF_ISSUE=False,
        FEATURE_FLAG_CHAT_HANDOFF_ACCEPT=True,
    )
    assert cfg2.FEATURE_FLAG_CHAT_HANDOFF_ISSUE is False
    assert cfg2.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT is True

    # Combination 3: ISSUE=True, ACCEPT=False (invalid - rejected)
    with pytest.raises(ValidationError) as exc_info:
        Settings(
            FEATURE_FLAG_CHAT_HANDOFF_ISSUE=True,
            FEATURE_FLAG_CHAT_HANDOFF_ACCEPT=False,
        )
    assert "Invalid config: ISSUE=true but ACCEPT=false" in str(exc_info.value)

    # Combination 4: ISSUE=True, ACCEPT=True (valid)
    cfg4 = Settings(
        FEATURE_FLAG_CHAT_HANDOFF_ISSUE=True,
        FEATURE_FLAG_CHAT_HANDOFF_ACCEPT=True,
    )
    assert cfg4.FEATURE_FLAG_CHAT_HANDOFF_ISSUE is True
    assert cfg4.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT is True


def test_agent_config_rejects_legacy_proxy_transport():
    # Passed as kwarg FEATURE_FLAG_CHAT_DIRECT_STREAM=False
    with pytest.raises(ValidationError) as exc_info:
        Settings(FEATURE_FLAG_CHAT_DIRECT_STREAM=False)
    assert "Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory." in str(exc_info.value)

    # Passed as kwarg ENABLE_DIRECT_AGENT_STREAM=False
    with pytest.raises(ValidationError) as exc_info:
        Settings(ENABLE_DIRECT_AGENT_STREAM=False)
    assert "Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory." in str(exc_info.value)

    # Passed as kwarg CHAT_STREAM_TRANSPORT='proxy'
    with pytest.raises(ValidationError) as exc_info:
        Settings(CHAT_STREAM_TRANSPORT="proxy")
    assert "Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory." in str(exc_info.value)

    # Set via environment variable
    with patch.dict(os.environ, {"FEATURE_FLAG_CHAT_DIRECT_STREAM": "false"}):
        with pytest.raises(ValidationError) as exc_info:
            Settings()
        assert "Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory." in str(exc_info.value)

    with patch.dict(os.environ, {"ENABLE_DIRECT_AGENT_STREAM": "false"}):
        with pytest.raises(ValidationError) as exc_info:
            Settings()
        assert "Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory." in str(exc_info.value)

    with patch.dict(os.environ, {"CHAT_STREAM_TRANSPORT": "proxy"}):
        with pytest.raises(ValidationError) as exc_info:
            Settings()
        assert "Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory." in str(exc_info.value)


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
