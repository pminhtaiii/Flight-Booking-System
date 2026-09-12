"""Payload-free deterministic output-boundary logging regression.

2026-09-06 user-approved migration retires NeMo per-chunk log assertions.
"""

import hashlib
import logging
from types import SimpleNamespace

import pytest

from agent.guardrails.output_pipeline import OutputGuardrailBlockedError, OutputGuardrailPipeline


@pytest.mark.asyncio
async def test_output_block_logging_omits_candidate_payload(
    caplog: pytest.LogCaptureFixture,
) -> None:
    candidate = "api_key=" + "sk_live_" + "1234567890abcdef"
    fingerprint = hashlib.sha256(candidate.encode()).hexdigest()[:12]
    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))

    with caplog.at_level(logging.INFO, logger="agent.guardrails"):
        with pytest.raises(OutputGuardrailBlockedError):
            async for _ in pipeline.process_token(candidate):
                pass

    captured = "\n".join(record.getMessage() for record in caplog.records)
    if candidate in captured:
        raise AssertionError(f"credential length={len(candidate)} fingerprint={fingerprint}")
