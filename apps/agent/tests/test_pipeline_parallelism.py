import pytest
import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch
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
async def test_pipeline_parallelism_latency(enabled_config, mock_nemo_service):
    # Mock NeMo validation with a 0.2s delay to simulate API latency
    async def mock_validate(chunk):
        await asyncio.sleep(0.2)
        return True, ""
    mock_nemo_service.validate_output_chunk.side_effect = mock_validate

    pipeline = OutputGuardrailPipeline(config=enabled_config, nemo_service=mock_nemo_service)

    # We will measure the latency of retrieving the chunks.
    # Chunk 1: "Hello world. "
    # Chunk 2: "This is next. "
    # Chunk 3: "And the last."
    tokens_1 = ["Hello", " ", "world", ". "]
    tokens_2 = ["This", " ", "is", " ", "next", ". "]
    tokens_3 = ["And", " ", "the", " ", "last", "."]

    yielded_chunks = []
    timestamps = []

    start_time = time.time()

    # Feed Chunk 1
    for token in tokens_1:
        async for chunk in pipeline.process_token(token):
            yielded_chunks.append(chunk)
            timestamps.append(time.time() - start_time)

    # Feed Chunk 2 with a delay of 0.05s between tokens to simulate LLM stream
    for token in tokens_2:
        await asyncio.sleep(0.05)
        async for chunk in pipeline.process_token(token):
            yielded_chunks.append(chunk)
            timestamps.append(time.time() - start_time)

    # Feed Chunk 3 with a delay of 0.05s
    for token in tokens_3:
        await asyncio.sleep(0.05)
        async for chunk in pipeline.process_token(token):
            yielded_chunks.append(chunk)
            timestamps.append(time.time() - start_time)

    # Flush the pipeline
    async for chunk in pipeline.flush():
        yielded_chunks.append(chunk)
        timestamps.append(time.time() - start_time)

    assert "".join(yielded_chunks) == "Hello world. This is next. And the last."
    assert len(yielded_chunks) == 3

    print("Timestamps of yielded chunks:", timestamps)
    # The first chunk should have yielded after its 0.2s validation completes.
    assert timestamps[0] >= 0.2
    
    # Assert that parallel validation hid the latency:
    # Total time to process and yield 3 chunks (with 0.6s total generation and 0.6s total validation time)
    # should be less than 1.8 seconds under parallel execution, whereas sequential execution would take >1.5s.
    assert timestamps[2] < 1.8

@pytest.mark.asyncio
async def test_pipeline_parallelism_fail_lookahead(enabled_config, mock_nemo_service):
    # Mock NeMo validation: Chunk 1 is safe, Chunk 2 is UNSAFE
    async def mock_validate(chunk):
        await asyncio.sleep(0.1)
        if "unsafe" in chunk:
            return False, "Output safety violation."
        return True, ""
    mock_nemo_service.validate_output_chunk.side_effect = mock_validate

    pipeline = OutputGuardrailPipeline(config=enabled_config, nemo_service=mock_nemo_service)

    tokens_1 = ["Hello", " ", "world", ". "]
    tokens_unsafe = ["This", " ", "is", " ", "unsafe", ". "]
    tokens_3 = ["And", " ", "more", "."]

    yielded_chunks = []

    # Chunk 1 is processed and yielded
    for token in tokens_1:
        async for chunk in pipeline.process_token(token):
            yielded_chunks.append(chunk)

    # We start Chunk 2 (which is unsafe). While Chunk 2 is generating, Chunk 1 completes validation.
    # When Chunk 2 is complete, its validation task (unsafe) is started.
    # When we feed Chunk 3, we should detect that Chunk 2 failed validation and raise an exception immediately,
    # preventing any more chunks from being processed or yielded.
    
    with pytest.raises(OutputGuardrailBlockedError) as exc_info:
        for token in tokens_unsafe:
            async for chunk in pipeline.process_token(token):
                yielded_chunks.append(chunk)
        for token in tokens_3:
            async for chunk in pipeline.process_token(token):
                yielded_chunks.append(chunk)
        async for chunk in pipeline.flush():
            yielded_chunks.append(chunk)

    assert exc_info.value.partial_response == "Hello world. "
    assert str(exc_info.value) == "Output safety violation."
