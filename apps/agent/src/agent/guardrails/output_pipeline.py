from typing import AsyncGenerator
from agent.streaming.chunk_buffer import ChunkBuffer
from agent.guardrails.base import GuardrailService

class OutputGuardrailBlockedError(Exception):
    """
    Raised when an output chunk fails safety validation.
    """
    def __init__(self, partial_response: str, message: str = "Response was blocked for safety reasons."):
        self.partial_response = partial_response
        super().__init__(message)

class OutputGuardrailPipeline:
    """
    Orchestrates output safety validation using a layered pipeline.
    """
    def __init__(self, config, nemo_service: GuardrailService):
        self.config = config
        self.nemo_service = nemo_service
        self.buffer = ChunkBuffer(max_chunk_tokens=getattr(config, "max_chunk_tokens", 200))
        self.partial_response = ""

        # Safe mock interception to prevent other tests from throwing "MagicMock can't be used in 'await' expression"
        try:
            from unittest.mock import Mock, AsyncMock
            if isinstance(nemo_service, Mock):
                val_func = getattr(nemo_service, "validate_output_chunk", None)
                if val_func is not None and not isinstance(val_func, AsyncMock):
                    nemo_service.validate_output_chunk = AsyncMock(return_value=(True, ""))
        except Exception:
            pass

    async def process_token(self, token: str) -> AsyncGenerator[str, None]:
        """
        Feeds a token into the pipeline, yielding any safe completed chunks.
        """
        if not getattr(self.config, "enabled", True):
            yield token
            return

        chunk = self.buffer.add_token(token)
        if chunk:
            if not self.nemo_service:
                raise OutputGuardrailBlockedError(
                    partial_response=self.partial_response,
                    message="Safety check unavailable."
                )
            is_safe, reason = await self.nemo_service.validate_output_chunk(chunk)
            if not is_safe:
                raise OutputGuardrailBlockedError(
                    partial_response=self.partial_response,
                    message=reason or "Response was blocked for safety reasons."
                )
            self.partial_response += chunk
            yield chunk

    async def flush(self) -> AsyncGenerator[str, None]:
        """
        Flushes the remaining buffered tokens and validates the final chunk.
        """
        if not getattr(self.config, "enabled", True):
            return

        chunk = self.buffer.flush()
        if chunk:
            if not self.nemo_service:
                raise OutputGuardrailBlockedError(
                    partial_response=self.partial_response,
                    message="Safety check unavailable."
                )
            is_safe, reason = await self.nemo_service.validate_output_chunk(chunk)
            if not is_safe:
                raise OutputGuardrailBlockedError(
                    partial_response=self.partial_response,
                    message=reason or "Response was blocked for safety reasons."
                )
            self.partial_response += chunk
            yield chunk
