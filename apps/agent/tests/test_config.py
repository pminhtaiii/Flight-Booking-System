import os
import pytest
from pydantic import ValidationError
# Assuming we will create this
from agent.config import Settings

def test_agent_config_defaults():
    # Will fail until we implement the actual Settings with defaults
    settings = Settings()
    
    assert settings.FEATURE_FLAG_CHAT_MULTI_AGENT is False
    assert settings.FEATURE_FLAG_CHAT_DIRECT_STREAM is False
    assert settings.REDIS_URL is not None
    assert settings.CHAT_QUOTA_DAILY > 0
    assert settings.CHAT_QUOTA_BURST > 0

def test_agent_config_rejects_issue_true_accept_false():
    with pytest.raises(ValidationError):
        Settings(
            FEATURE_FLAG_CHAT_HANDOFF_ISSUE=True,
            FEATURE_FLAG_CHAT_HANDOFF_ACCEPT=False
        )
