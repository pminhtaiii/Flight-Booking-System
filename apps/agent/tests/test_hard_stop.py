"""Deterministic hard-stop regression coverage.

2026-09-06 user-approved replacement for NeMo output-classifier integration.
"""

from types import SimpleNamespace

import pytest

from agent.guardrails.output_pipeline import OutputGuardrailBlockedError, OutputGuardrailPipeline


@pytest.mark.asyncio
async def test_detected_credential_stops_before_any_public_chunk() -> None:
    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    with pytest.raises(OutputGuardrailBlockedError) as blocked:
        async for _ in pipeline.process_token("bearer secret"):
            pass
    assert blocked.value.partial_response == ""
