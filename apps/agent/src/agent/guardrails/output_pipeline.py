import tiktoken
import asyncio
import time
import logging
import json
from datetime import datetime, timezone
from typing import AsyncGenerator, Tuple
from agent.streaming.chunk_buffer import ChunkBuffer
from agent.guardrails.base import GuardrailService
from agent.sanitization.pii_scrubber import detect_pii

class OutputGuardrailBlockedError(Exception):
    """
    Raised when an output chunk fails safety validation.
    """
    def __init__(self, partial_response: str, layer: str, rule: str, message: str = "Response was blocked for safety reasons."):
        self.partial_response = partial_response
        self.layer = layer
        self.rule = rule
        super().__init__(message)

class OutputGuardrailPipeline:
    """
    Orchestrates output safety validation using a layered pipeline.
    """
    def __init__(self, config, nemo_service: GuardrailService, session_id: str = None):
        self.config = config
        self.nemo_service = nemo_service
        self.session_id = session_id
        self.buffer = ChunkBuffer(max_chunk_tokens=getattr(config, "max_chunk_tokens", 200))
        self.overlap_tokens = getattr(config, "overlap_tokens", 30)
        self.partial_response = ""
        self.pending_chunk = None
        self.pending_validation_task = None
        self.chunk_index = 0
        try:
            self.encoding = tiktoken.get_encoding("cl100k_base")
        except Exception:
            self.encoding = None

    def _log_sync_check(self, layer: str, verdict: str, latency_ms: float, chunk_index: int) -> None:
        logger = logging.getLogger("agent.guardrails")
        logger.info(json.dumps({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "session_id": self.session_id,
            "chunk_index": chunk_index,
            "layer": layer,
            "verdict": verdict,
            "latency_ms": round(latency_ms, 2)
        }))

    async def _validate_chunk_async_wrapper(self, chunk: str, chunk_index: int) -> Tuple[bool, str]:
        start_time = time.perf_counter()
        is_safe = False
        reason = "Safety check unavailable."
        try:
            is_safe, reason = await self.nemo_service.validate_output_chunk(chunk)
        except Exception as e:
            reason = f"Exception: {e}"
            raise
        finally:
            latency_ms = (time.perf_counter() - start_time) * 1000.0
            verdict = "pass" if is_safe else "fail"
            logger = logging.getLogger("agent.guardrails")
            logger.info(json.dumps({
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "session_id": self.session_id,
                "chunk_index": chunk_index,
                "layer": "nemo",
                "verdict": verdict,
                "latency_ms": round(latency_ms, 2)
            }))
        return is_safe, reason

    def _check_boundary_pii(self, chunk: str, context: str = None) -> None:
        """
        Maintains a sliding window of the last N tokens from the previous chunk
        and tests the overlap region (tail of previous + head of current) with regex.
        """
        boundary_context = context if context is not None else self.partial_response
        if not boundary_context:
            return

        # Extract tail of the previous chunk
        if self.encoding:
            try:
                prev_tokens = self.encoding.encode(boundary_context)
                tail_tokens = prev_tokens[-self.overlap_tokens:] if len(prev_tokens) > self.overlap_tokens else prev_tokens
                tail_text = self.encoding.decode(tail_tokens)
            except Exception:
                char_limit = self.overlap_tokens * 4
                tail_text = boundary_context[-char_limit:]
        else:
            char_limit = self.overlap_tokens * 4
            tail_text = boundary_context[-char_limit:]

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
                layer="boundary",
                rule="PII detection",
                message="Output safety violation: PII detected."
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
            self.chunk_index += 1
            chunk_idx = self.chunk_index

            # If we had a pending validation, await it now
            if self.pending_validation_task:
                try:
                    is_safe, reason = await self.pending_validation_task
                    if not is_safe:
                        raise OutputGuardrailBlockedError(
                            partial_response=self.partial_response,
                            layer="nemo",
                            rule=reason or "Output safety violation.",
                            message=reason or "Output safety violation."
                        )
                except OutputGuardrailBlockedError:
                    raise
                except Exception:
                    raise OutputGuardrailBlockedError(
                        partial_response=self.partial_response,
                        layer="nemo",
                        rule="Safety check unavailable.",
                        message="Safety check unavailable."
                    )
                self.partial_response += self.pending_chunk
                yield self.pending_chunk
                self.pending_validation_task = None
                self.pending_chunk = None

            # Boundary PII check (using partial_response + pending_chunk context)
            context = self.partial_response + (self.pending_chunk or "")
            start_boundary = time.perf_counter()
            boundary_passed = False
            try:
                self._check_boundary_pii(chunk, context)
                boundary_passed = True
            except OutputGuardrailBlockedError:
                raise
            finally:
                latency_boundary = (time.perf_counter() - start_boundary) * 1000.0
                self._log_sync_check(
                    layer="boundary",
                    verdict="pass" if boundary_passed else "fail",
                    latency_ms=latency_boundary,
                    chunk_index=chunk_idx
                )

            # Regex check
            start_regex = time.perf_counter()
            regex_passed = not detect_pii(chunk)
            latency_regex = (time.perf_counter() - start_regex) * 1000.0
            self._log_sync_check(
                layer="regex",
                verdict="pass" if regex_passed else "fail",
                latency_ms=latency_regex,
                chunk_index=chunk_idx
            )

            if not regex_passed:
                raise OutputGuardrailBlockedError(
                    partial_response=self.partial_response,
                    layer="regex",
                    rule="PII detection",
                    message="Output safety violation: PII detected."
                )

            if not self.nemo_service:
                raise OutputGuardrailBlockedError(
                    partial_response=self.partial_response,
                    layer="nemo",
                    rule="Safety check unavailable.",
                    message="Safety check unavailable."
                )

            # If it is the first chunk, validate it immediately (unavoidable latency)
            if not self.partial_response:
                start_nemo = time.perf_counter()
                try:
                    is_safe, reason = await self.nemo_service.validate_output_chunk(chunk)
                except Exception as e:
                    is_safe, reason = False, f"Exception: {e}"
                    raise OutputGuardrailBlockedError(
                        partial_response=self.partial_response,
                        layer="nemo",
                        rule="Safety check unavailable.",
                        message="Safety check unavailable."
                    )
                finally:
                    latency_nemo = (time.perf_counter() - start_nemo) * 1000.0
                    self._log_sync_check(
                        layer="nemo",
                        verdict="pass" if is_safe else "fail",
                        latency_ms=latency_nemo,
                        chunk_index=chunk_idx
                    )
                if not is_safe:
                    raise OutputGuardrailBlockedError(
                        partial_response=self.partial_response,
                        layer="nemo",
                        rule=reason or "Output safety violation.",
                        message=reason or "Output safety violation."
                    )
                self.partial_response += chunk
                yield chunk
            else:
                # Chunks 2+: start validation concurrently in background
                self.pending_chunk = chunk
                self.pending_validation_task = asyncio.create_task(
                    self._validate_chunk_async_wrapper(chunk, chunk_idx)
                )

    async def flush(self) -> AsyncGenerator[str, None]:
        """
        Flushes the remaining buffered tokens and validates the final chunk.
        """
        if not getattr(self.config, "enabled", True):
            return

        chunk = self.buffer.flush()
        if chunk:
            self.chunk_index += 1
            chunk_idx = self.chunk_index

            # If we had a pending validation, await it now
            if self.pending_validation_task:
                try:
                    is_safe, reason = await self.pending_validation_task
                    if not is_safe:
                        raise OutputGuardrailBlockedError(
                            partial_response=self.partial_response,
                            layer="nemo",
                            rule=reason or "Output safety violation.",
                            message=reason or "Output safety violation."
                        )
                except OutputGuardrailBlockedError:
                    raise
                except Exception:
                    raise OutputGuardrailBlockedError(
                        partial_response=self.partial_response,
                        layer="nemo",
                        rule="Safety check unavailable.",
                        message="Safety check unavailable."
                    )
                self.partial_response += self.pending_chunk
                yield self.pending_chunk
                self.pending_validation_task = None
                self.pending_chunk = None

            # Boundary PII check for the final chunk
            context = self.partial_response + (self.pending_chunk or "")
            start_boundary = time.perf_counter()
            boundary_passed = False
            try:
                self._check_boundary_pii(chunk, context)
                boundary_passed = True
            except OutputGuardrailBlockedError:
                raise
            finally:
                latency_boundary = (time.perf_counter() - start_boundary) * 1000.0
                self._log_sync_check(
                    layer="boundary",
                    verdict="pass" if boundary_passed else "fail",
                    latency_ms=latency_boundary,
                    chunk_index=chunk_idx
                )

            # Regex check
            start_regex = time.perf_counter()
            regex_passed = not detect_pii(chunk)
            latency_regex = (time.perf_counter() - start_regex) * 1000.0
            self._log_sync_check(
                layer="regex",
                verdict="pass" if regex_passed else "fail",
                latency_ms=latency_regex,
                chunk_index=chunk_idx
            )

            if not regex_passed:
                raise OutputGuardrailBlockedError(
                    partial_response=self.partial_response,
                    layer="regex",
                    rule="PII detection",
                    message="Output safety violation: PII detected."
                )

            if not self.nemo_service:
                raise OutputGuardrailBlockedError(
                    partial_response=self.partial_response,
                    layer="nemo",
                    rule="Safety check unavailable.",
                    message="Safety check unavailable."
                )

            # Final chunk must be validated immediately
            start_nemo = time.perf_counter()
            try:
                is_safe, reason = await self.nemo_service.validate_output_chunk(chunk)
            except Exception as e:
                is_safe, reason = False, f"Exception: {e}"
                raise OutputGuardrailBlockedError(
                    partial_response=self.partial_response,
                    layer="nemo",
                    rule="Safety check unavailable.",
                    message="Safety check unavailable."
                )
            finally:
                latency_nemo = (time.perf_counter() - start_nemo) * 1000.0
                self._log_sync_check(
                    layer="nemo",
                    verdict="pass" if is_safe else "fail",
                    latency_ms=latency_nemo,
                    chunk_index=chunk_idx
                )

            if not is_safe:
                raise OutputGuardrailBlockedError(
                    partial_response=self.partial_response,
                    layer="nemo",
                    rule=reason or "Output safety violation.",
                    message=reason or "Output safety violation."
                )
            self.partial_response += chunk
            yield chunk

        else:
            # If no new final chunk, but we still have a pending validation, await it
            if self.pending_validation_task:
                try:
                    is_safe, reason = await self.pending_validation_task
                    if not is_safe:
                        raise OutputGuardrailBlockedError(
                            partial_response=self.partial_response,
                            layer="nemo",
                            rule=reason or "Output safety violation.",
                            message=reason or "Output safety violation."
                        )
                except OutputGuardrailBlockedError:
                    raise
                except Exception:
                    raise OutputGuardrailBlockedError(
                        partial_response=self.partial_response,
                        layer="nemo",
                        rule="Safety check unavailable.",
                        message="Safety check unavailable."
                    )
                self.partial_response += self.pending_chunk
                yield self.pending_chunk
                self.pending_validation_task = None
                self.pending_chunk = None



