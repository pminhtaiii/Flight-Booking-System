"""Public regression tests for deterministic output protection.

2026-09-06 user-approved Feature 023 migration replaced obsolete NeMo and
ChunkBuffer-internal expectations with the public deterministic boundary.
"""

import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.guardrails.output_pipeline import OutputGuardrailBlockedError, OutputGuardrailPipeline


# 2026-09-06: user-approved correction of legacy deterministic-boundary tests.
def _fixture_ref(label: str, candidate: str) -> str:
    return f"{label} length={len(candidate)} fingerprint={hashlib.sha256(candidate.encode()).hexdigest()[:12]}"


def _pipeline(enabled: bool = True) -> tuple[OutputGuardrailPipeline, MagicMock]:
    secondary = MagicMock()
    secondary.validate_output_chunk = AsyncMock()
    return OutputGuardrailPipeline(SimpleNamespace(enabled=enabled), secondary), secondary


@pytest.mark.asyncio
async def test_safe_stream_is_preserved_without_secondary_model() -> None:
    pipeline, secondary = _pipeline()
    chunks = []
    for token in ("Hello ", "world. ", "Safe text."):
        chunks.extend([item async for item in pipeline.process_token(token)])
    chunks.extend([item async for item in pipeline.flush()])
    assert "".join(chunks) == "Hello world. Safe text."
    secondary.validate_output_chunk.assert_not_awaited()


@pytest.mark.asyncio
async def test_cross_token_pii_preserves_approved_prefix_only() -> None:
    pipeline, secondary = _pipeline()
    chunks = [item async for item in pipeline.process_token("Safe prefix. ")]
    with pytest.raises(OutputGuardrailBlockedError) as error:
        async for _ in pipeline.process_token("traveler@"):
            pass
        async for _ in pipeline.process_token("example.com"):
            pass
    assert "".join(chunks) == "Safe prefix. "
    assert error.value.partial_response == "Safe prefix. "
    secondary.validate_output_chunk.assert_not_awaited()


@pytest.mark.asyncio
async def test_disabled_pipeline_is_passthrough() -> None:
    pipeline, _ = _pipeline(False)
    assert [item async for item in pipeline.process_token("safe")] == ["safe"]


@pytest.mark.asyncio
async def test_overflow_fails_closed_and_cleanup_discards_pending() -> None:
    pipeline, secondary = _pipeline()
    with pytest.raises(OutputGuardrailBlockedError):
        async for _ in pipeline.process_token("x" * 8193):
            pass
    await pipeline.aclose()
    assert pipeline.buffer.raw == ""
    secondary.validate_output_chunk.assert_not_awaited()
