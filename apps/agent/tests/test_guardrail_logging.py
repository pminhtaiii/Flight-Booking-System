import pytest
import logging
import json
from unittest.mock import AsyncMock, MagicMock
from agent.guardrails.output_pipeline import OutputGuardrailPipeline, OutputGuardrailBlockedError
from agent.config import OutputGuardrailConfig

@pytest.fixture
def mock_nemo_service():
    service = MagicMock()
    service.validate_output_chunk = AsyncMock()
    return service

@pytest.fixture
def enabled_config():
    return OutputGuardrailConfig(
        enabled=True,
        overlap_tokens=30,
        max_chunk_tokens=200,
        nemo_timeout=2.0
    )

@pytest.mark.asyncio
async def test_guardrail_logging_safe_chunks(enabled_config, mock_nemo_service, caplog):
    mock_nemo_service.validate_output_chunk.return_value = (True, "")
    
    pipeline = OutputGuardrailPipeline(
        config=enabled_config,
        nemo_service=mock_nemo_service,
        session_id="test-session-123"
    )

    caplog.clear()
    # We want to capture INFO level logs from agent.guardrails
    with caplog.at_level(logging.INFO, logger="agent.guardrails"):
        tokens = ["Hello", " ", "world", ". ", "This", " ", "is", " ", "safe", "."]
        for token in tokens:
            async for _ in pipeline.process_token(token):
                pass
        async for _ in pipeline.flush():
            pass

    # There should be log entries for regex and nemo checks
    # Chunk 1: "Hello world. " -> boundary (skipped because no context), regex, nemo
    # Chunk 2: "This is safe." -> boundary, regex, nemo
    # Boundary check for Chunk 1: skipped (no log or pass)
    # Log entries expected:
    # Chunk 1: regex, nemo
    # Chunk 2: boundary, regex, nemo
    records = [rec for rec in caplog.records if rec.name == "agent.guardrails"]
    assert len(records) >= 3

    log_payloads = [json.loads(rec.message) for rec in records]
    
    # Check regex check log payload for chunk 1
    regex_log = next(p for p in log_payloads if p["layer"] == "regex" and p["chunk_index"] == 1)
    assert regex_log["session_id"] == "test-session-123"
    assert regex_log["verdict"] == "pass"
    assert "timestamp" in regex_log
    assert "latency_ms" in regex_log

    # Check nemo check log payload for chunk 1
    nemo_log = next(p for p in log_payloads if p["layer"] == "nemo" and p["chunk_index"] == 1)
    assert nemo_log["session_id"] == "test-session-123"
    assert nemo_log["verdict"] == "pass"

    # Check boundary check log payload for chunk 2
    boundary_log = next(p for p in log_payloads if p["layer"] == "boundary" and p["chunk_index"] == 2)
    assert boundary_log["session_id"] == "test-session-123"
    assert boundary_log["verdict"] == "pass"

    # Make sure NO log message contains the text of the chunks
    for payload in log_payloads:
        payload_str = json.dumps(payload)
        assert "Hello" not in payload_str
        assert "world" not in payload_str
        assert "safe" not in payload_str

@pytest.mark.asyncio
async def test_guardrail_logging_blocked_chunks(enabled_config, mock_nemo_service, caplog):
    # Mock NeMo validation to fail
    mock_nemo_service.validate_output_chunk.return_value = (False, "Safety check violation: harmful content.")
    
    pipeline = OutputGuardrailPipeline(
        config=enabled_config,
        nemo_service=mock_nemo_service,
        session_id="test-session-456"
    )

    caplog.clear()
    with caplog.at_level(logging.INFO, logger="agent.guardrails"):
        tokens = ["This", " ", "is", " ", "unsafe", "."]
        with pytest.raises(OutputGuardrailBlockedError):
            for token in tokens:
                async for _ in pipeline.process_token(token):
                    pass
            async for _ in pipeline.flush():
                pass

    records = [rec for rec in caplog.records if rec.name == "agent.guardrails"]
    assert len(records) >= 2 # regex pass, nemo fail
    
    log_payloads = [json.loads(rec.message) for rec in records]
    
    nemo_log = next(p for p in log_payloads if p["layer"] == "nemo")
    assert nemo_log["session_id"] == "test-session-456"
    assert nemo_log["verdict"] == "fail"

    # Make sure NO log message contains the text of the blocked chunk
    for payload in log_payloads:
        payload_str = json.dumps(payload)
        assert "unsafe" not in payload_str
        assert "This" not in payload_str
