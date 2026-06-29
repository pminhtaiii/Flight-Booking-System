import os
import pytest
from pydantic import ValidationError
from agent.config import Settings

def test_config_missing_required():
    # Clear required vars from env if present
    old_jwt = os.environ.pop("JWT_SECRET", None)
    old_api = os.environ.pop("NESTJS_API_URL", None)
    
    try:
        with pytest.raises(ValidationError):
            Settings(_env_file=None)
    finally:
        if old_jwt:
            os.environ["JWT_SECRET"] = old_jwt
        if old_api:
            os.environ["NESTJS_API_URL"] = old_api

def test_config_defaults(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "testsecret")
    monkeypatch.setenv("NESTJS_API_URL", "http://localhost:3001")
    
    # Optional values should use defaults
    monkeypatch.delenv("FRONTEND_URL", raising=False)
    monkeypatch.delenv("MIMO_MODEL_NAME", raising=False)
    monkeypatch.delenv("AGENT_PORT", raising=False)
    
    settings = Settings(_env_file=None)
    assert settings.JWT_SECRET == "testsecret"
    assert settings.NESTJS_API_URL == "http://localhost:3001"
    assert settings.FRONTEND_URL == "http://localhost:3000"
    assert settings.MIMO_MODEL_NAME == "mimo"
    assert settings.AGENT_PORT == 3002
    assert settings.MAX_MESSAGE_LENGTH == 10000
    assert settings.MEMORY_WINDOW_SIZE == 20
    assert settings.MEMORY_TOKEN_BUDGET == 4000
    assert settings.QUEUE_MAX_DEPTH == 3

def test_config_custom_values(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "customsecret")
    monkeypatch.setenv("NESTJS_API_URL", "http://custom-api:3001")
    monkeypatch.setenv("FRONTEND_URL", "http://custom-front:3000")
    monkeypatch.setenv("MIMO_MODEL_NAME", "custom-mimo")
    monkeypatch.setenv("AGENT_PORT", "4000")
    monkeypatch.setenv("MAX_MESSAGE_LENGTH", "500")
    monkeypatch.setenv("MEMORY_WINDOW_SIZE", "10")
    monkeypatch.setenv("MEMORY_TOKEN_BUDGET", "2000")
    monkeypatch.setenv("QUEUE_MAX_DEPTH", "5")
    
    settings = Settings(_env_file=None)
    assert settings.JWT_SECRET == "customsecret"
    assert settings.NESTJS_API_URL == "http://custom-api:3001"
    assert settings.FRONTEND_URL == "http://custom-front:3000"
    assert settings.MIMO_MODEL_NAME == "custom-mimo"
    assert settings.AGENT_PORT == 4000
    assert settings.MAX_MESSAGE_LENGTH == 500
    assert settings.MEMORY_WINDOW_SIZE == 10
    assert settings.MEMORY_TOKEN_BUDGET == 2000
    assert settings.QUEUE_MAX_DEPTH == 5
