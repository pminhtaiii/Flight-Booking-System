from agent.config import OutputGuardrailConfig, Settings


def test_output_guardrail_config_defaults(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "testsecret")
    monkeypatch.setenv("NESTJS_API_URL", "http://localhost:3001")
    monkeypatch.setenv("AGENT_SERVICE_API_KEY", "testkey")
    monkeypatch.setenv("CLAIM_TOKEN_SECRET", "testsecret")

    # Ensure no env variables override the defaults
    monkeypatch.delenv("OUTPUT_GUARDRAIL_ENABLED", raising=False)
    monkeypatch.delenv("OUTPUT_GUARDRAIL_OVERLAP_TOKENS", raising=False)
    monkeypatch.delenv("OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS", raising=False)
    monkeypatch.delenv("OUTPUT_GUARDRAIL_NEMO_TIMEOUT", raising=False)

    settings = Settings(_env_file=None)

    # Assert settings have the flat properties
    assert settings.OUTPUT_GUARDRAIL_ENABLED is True
    assert settings.OUTPUT_GUARDRAIL_OVERLAP_TOKENS == 30
    assert settings.OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS == 200
    assert settings.OUTPUT_GUARDRAIL_NEMO_TIMEOUT == 2.0

    # Assert settings has output_guardrail property yielding OutputGuardrailConfig
    cfg = settings.output_guardrail
    assert isinstance(cfg, OutputGuardrailConfig)
    assert cfg.enabled is True
    assert cfg.overlap_tokens == 30
    assert cfg.max_chunk_tokens == 200
    assert cfg.nemo_timeout == 2.0


def test_output_guardrail_config_custom(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "testsecret")
    monkeypatch.setenv("NESTJS_API_URL", "http://localhost:3001")
    monkeypatch.setenv("AGENT_SERVICE_API_KEY", "testkey")
    monkeypatch.setenv("CLAIM_TOKEN_SECRET", "testsecret")

    monkeypatch.setenv("OUTPUT_GUARDRAIL_ENABLED", "false")
    monkeypatch.setenv("OUTPUT_GUARDRAIL_OVERLAP_TOKENS", "50")
    monkeypatch.setenv("OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS", "150")
    monkeypatch.setenv("OUTPUT_GUARDRAIL_NEMO_TIMEOUT", "3.5")

    settings = Settings(_env_file=None)

    assert settings.OUTPUT_GUARDRAIL_ENABLED is False
    assert settings.OUTPUT_GUARDRAIL_OVERLAP_TOKENS == 50
    assert settings.OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS == 150
    assert settings.OUTPUT_GUARDRAIL_NEMO_TIMEOUT == 3.5

    cfg = settings.output_guardrail
    assert cfg.enabled is False
    assert cfg.overlap_tokens == 50
    assert cfg.max_chunk_tokens == 150
    assert cfg.nemo_timeout == 3.5


def test_session_lock_timing_defaults_and_override(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "testsecret")
    monkeypatch.setenv("NESTJS_API_URL", "http://localhost:3001")
    monkeypatch.setenv("AGENT_SERVICE_API_KEY", "testkey")
    monkeypatch.setenv("CLAIM_TOKEN_SECRET", "testsecret")
    monkeypatch.delenv("SESSION_LOCK_TTL_MS", raising=False)
    monkeypatch.delenv("SESSION_LOCK_REFRESH_INTERVAL_SECONDS", raising=False)

    defaults = Settings(_env_file=None)
    assert defaults.SESSION_LOCK_TTL_MS == 10000
    assert defaults.SESSION_LOCK_REFRESH_INTERVAL_SECONDS == 3.0

    monkeypatch.setenv("SESSION_LOCK_TTL_MS", "120000")
    monkeypatch.setenv("SESSION_LOCK_REFRESH_INTERVAL_SECONDS", "1.0")
    overridden = Settings(_env_file=None)
    assert overridden.SESSION_LOCK_TTL_MS == 120000
    assert overridden.SESSION_LOCK_REFRESH_INTERVAL_SECONDS == 1.0
