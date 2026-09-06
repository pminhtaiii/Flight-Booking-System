import pytest

from agent.config import OutputGuardrailConfig
from agent.guardrails.output_pipeline import OutputGuardrailBlockedError, OutputGuardrailPipeline


@pytest.mark.asyncio
async def test_pipeline_blocks_credentials_without_secondary_model():
    pipeline = OutputGuardrailPipeline(config=OutputGuardrailConfig(enabled=True))
    with pytest.raises(OutputGuardrailBlockedError):
        async for _ in pipeline.process_token("secret=secret-value"):
            pass
        async for _ in pipeline.flush():
            pass
