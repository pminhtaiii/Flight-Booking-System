"""SSE output guardrail regression coverage.

2026-09-06 user-approved replacement for secondary-model SSE probes.
"""

from types import SimpleNamespace

import pytest

from agent.guardrails.output_pipeline import OutputGuardrailBlockedError, OutputGuardrailPipeline


@pytest.mark.asyncio
async def test_split_email_is_never_released_to_sse_adapter() -> None:
    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    emitted = [chunk async for chunk in pipeline.process_token("Public prefix. ")]
    with pytest.raises(OutputGuardrailBlockedError):
        async for _ in pipeline.process_token("traveler@"):
            pass
        async for _ in pipeline.process_token("example.com"):
            pass
    assert "".join(emitted) == "Public prefix. "
