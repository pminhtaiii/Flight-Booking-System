"""End-to-end deterministic output-boundary regression coverage.

2026-09-06 user-approved replacement for output NeMo integration tests.
"""

from types import SimpleNamespace

import pytest

from agent.guardrails.output_pipeline import OutputGuardrailBlockedError, OutputGuardrailPipeline


@pytest.mark.asyncio
async def test_safe_completion_flushes_after_deterministic_inspection() -> None:
    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    emitted = [chunk async for chunk in pipeline.process_token("A safe itinerary update.")]
    emitted.extend([chunk async for chunk in pipeline.flush()])
    assert "".join(emitted) == "A safe itinerary update."


@pytest.mark.asyncio
async def test_detected_card_raises_hard_stop() -> None:
    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    with pytest.raises(OutputGuardrailBlockedError):
        async for _ in pipeline.process_token("4111-1111-1111-1111"):
            pass
