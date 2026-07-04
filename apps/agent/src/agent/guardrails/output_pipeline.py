import tiktoken
from typing import AsyncGenerator
from agent.streaming.chunk_buffer import ChunkBuffer
from agent.guardrails.base import GuardrailService
from agent.sanitization.pii_scrubber import detect_pii

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
        self.overlap_tokens = getattr(config, "overlap_tokens", 30)
        self.partial_response = ""
        try:
            self.encoding = tiktoken.get_encoding("cl100k_base")
        except Exception:
            self.encoding = None

    def _check_boundary_pii(self, chunk: str) -> None:
        """
        Maintains a sliding window of the last N tokens from the previous chunk
        and tests the overlap region (tail of previous + head of current) with regex.
        """
        if not self.partial_response:
            return

        # Extract tail of the previous chunk
        if self.encoding:
            try:
                prev_tokens = self.encoding.encode(self.partial_response)
                tail_tokens = prev_tokens[-self.overlap_tokens:] if len(prev_tokens) > self.overlap_tokens else prev_tokens
                tail_text = self.encoding.decode(tail_tokens)
            except Exception:
                char_limit = self.overlap_tokens * 4
                tail_text = self.partial_response[-char_limit:]
        else:
            char_limit = self.overlap_tokens * 4
            tail_text = self.partial_response[-char_limit:]

        # Extract head of the current chunk
        if self.encoding:
            try:
                curr_tokens = self.encoding.encode(chunk)
                head_tokens = curr_tokens[:self.overlap_tokens]
                head_text = self.encoding.decode(head_tokens)
            except Exception:
                char_limit = self.overlap_tokens * 4
                head_text = chunk[:char_limit]
        else:
            char_limit = self.overlap_tokens * 4
            head_text = chunk[:char_limit]

        overlap_string = tail_text + head_text
        if detect_pii(overlap_string):
            raise OutputGuardrailBlockedError(
                partial_response=self.partial_response,
                message="Output safety violation: PII detected."
            )

    async def _validate_chunk(self, chunk: str) -> None:
        """
        Executes layered check on chunk:
        1. Regex PII scanner
        2. NeMo output rail
        """
        # Layer 1: Regex PII scanner (FR-005)
        if detect_pii(chunk):
            raise OutputGuardrailBlockedError(
                partial_response=self.partial_response,
                message="Output safety violation: PII detected."
            )

        # Layer 2: NeMo output rail (FR-005)
        if not self.nemo_service:
            raise OutputGuardrailBlockedError(
                partial_response=self.partial_response,
                message="Safety check unavailable."
            )
        is_safe, reason = await self.nemo_service.validate_output_chunk(chunk)
        if not is_safe:
            raise OutputGuardrailBlockedError(
                partial_response=self.partial_response,
                message=reason or "Output safety violation."
            )

    async def process_token(self, token: str) -> AsyncGenerator[str, None]:
        """
        Feeds a token into the pipeline, yielding any safe completed chunks.
        """
        if not getattr(self.config, "enabled", True):
            yield token
            return

        chunk = self.buffer.add_token(token)
        if chunk:
            self._check_boundary_pii(chunk)
            await self._validate_chunk(chunk)
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
            self._check_boundary_pii(chunk)
            await self._validate_chunk(chunk)
            self.partial_response += chunk
            yield chunk

