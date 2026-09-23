import pytest

from agent.config import OutputGuardrailConfig
from agent.guardrails.output_pipeline import OutputGuardrailPipeline

try:
    from agent.guardrails.base import OutputGuardrailBlockedError
except ImportError:
    from agent.guardrails.output_pipeline import OutputGuardrailBlockedError


@pytest.mark.asyncio
async def test_output_pipeline_does_not_call_removed_secondary_guardrail():
    pipeline = OutputGuardrailPipeline(config=OutputGuardrailConfig(enabled=True))
    emitted = []
    async for chunk in pipeline.process_token("A deterministic response."):
        emitted.append(chunk)
    async for chunk in pipeline.flush():
        emitted.append(chunk)
    assert "".join(emitted) == "A deterministic response."


@pytest.mark.asyncio
async def test_output_pipeline_blocks_credentials_with_output_guardrail_blocked_error():
    pipeline = OutputGuardrailPipeline(config=OutputGuardrailConfig(enabled=True))
    with pytest.raises(OutputGuardrailBlockedError):
        async for _ in pipeline.process_token("bearer secret-token"):
            pass
