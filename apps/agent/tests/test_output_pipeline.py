import pytest
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

@pytest.fixture
def disabled_config():
    return OutputGuardrailConfig(
        enabled=False,
        overlap_tokens=30,
        max_chunk_tokens=200,
        nemo_timeout=2.0
    )

@pytest.mark.asyncio
async def test_pipeline_streaming_safe(enabled_config, mock_nemo_service):
    # Setup mock validation to return SAFE
    mock_nemo_service.validate_output_chunk.return_value = (True, "")
    
    pipeline = OutputGuardrailPipeline(config=enabled_config, nemo_service=mock_nemo_service)
    
    # We feed tokens that will trigger a sentence boundary split on ". "
    # "Hello world. " has a sentence boundary because next char is Uppercase (let's feed "This is")
    yielded_chunks = []
    
    # Feed tokens
    tokens = ["Hello", " ", "world", ". ", "This", " ", "is", " ", "safe", "."]
    for token in tokens:
        async for chunk in pipeline.process_token(token):
            yielded_chunks.append(chunk)
            
    # Flush remaining
    async for chunk in pipeline.flush():
        yielded_chunks.append(chunk)
        
    # Verify chunks are yielded and correct
    # "Hello world. " gets yielded because the boundary is ". " and "T" is uppercase.
    # The remainder "This is safe." is yielded on flush.
    assert len(yielded_chunks) >= 2
    assert "".join(yielded_chunks) == "Hello world. This is safe."
    assert mock_nemo_service.validate_output_chunk.call_count == 2
    
    # Verify exact calls
    mock_nemo_service.validate_output_chunk.assert_any_call("Hello world. ")
    mock_nemo_service.validate_output_chunk.assert_any_call("This is safe.")

@pytest.mark.asyncio
async def test_pipeline_blocking_nemo_unsafe(enabled_config, mock_nemo_service):
    # First chunk is safe, second chunk is unsafe
    async def mock_validate(chunk):
        if "unsafe" in chunk:
            return False, "Output safety violation."
        return True, ""
        
    mock_nemo_service.validate_output_chunk.side_effect = mock_validate
    
    pipeline = OutputGuardrailPipeline(config=enabled_config, nemo_service=mock_nemo_service)
    
    yielded_chunks = []
    
    # Feed safe sentence first
    tokens_safe = ["Safe", " ", "sentence", ". ", "This"]
    for token in tokens_safe:
        async for chunk in pipeline.process_token(token):
            yielded_chunks.append(chunk)
            
    assert len(yielded_chunks) == 1
    assert yielded_chunks[0] == "Safe sentence. "
    
    # Feed unsafe sentence
    tokens_unsafe = [" ", "is", " ", "unsafe", "."]
    
    with pytest.raises(OutputGuardrailBlockedError) as exc_info:
        for token in tokens_unsafe:
            async for chunk in pipeline.process_token(token):
                yielded_chunks.append(chunk)
        async for chunk in pipeline.flush():
            yielded_chunks.append(chunk)
            
    # Assert that the error contains the correct partial response
    assert exc_info.value.partial_response == "Safe sentence. "
    assert str(exc_info.value) == "Output safety violation."

@pytest.mark.asyncio
async def test_pipeline_disabled_passthrough(disabled_config, mock_nemo_service):
    pipeline = OutputGuardrailPipeline(config=disabled_config, nemo_service=mock_nemo_service)
    
    yielded_chunks = []
    tokens = ["Hello", " ", "world", ".", " ", "Test"]
    for token in tokens:
        async for chunk in pipeline.process_token(token):
            yielded_chunks.append(chunk)
            
    async for chunk in pipeline.flush():
        yielded_chunks.append(chunk)
        
    # In disabled mode, tokens must be passed through immediately (without chunk buffering/validation)
    assert yielded_chunks == tokens
    mock_nemo_service.validate_output_chunk.assert_not_called()
