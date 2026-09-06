import pytest

from agent.config import OutputGuardrailConfig
from agent.guardrails.output_pipeline import OutputGuardrailPipeline


@pytest.mark.asyncio
async def test_output_pipeline_does_not_call_removed_secondary_guardrail():
    pipeline = OutputGuardrailPipeline(config=OutputGuardrailConfig(enabled=True))
    emitted = []
    async for chunk in pipeline.process_token("A deterministic response."):
        emitted.append(chunk)
    async for chunk in pipeline.flush():
        emitted.append(chunk)
    assert "".join(emitted) == "A deterministic response."
