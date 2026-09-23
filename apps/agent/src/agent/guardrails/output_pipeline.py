"""Deterministic public model-output boundary."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, AsyncGenerator

from agent.guardrails.base import OutputGuardrailBlockedError
from agent.guardrails.pii import (
    _CARD,
    _CARD_PREFIX,
    _CREDENTIAL,
    _CREDENTIAL_KEYWORDS,
    _CREDENTIAL_PREFIX,
    _EMAIL,
    _EMAIL_PREFIX,
    _PASSPORT,
    _PASSPORT_PREFIX,
    _PHONE,
    _PHONE_PREFIX,
    _is_output_guardrail_disabled,
    approved_model_content,
    deterministic_pii_match,
)
from agent.streaming.chunk_buffer import ChunkBuffer


def payload_free_config(config: Any = None) -> dict[str, Any]:
    source = config if isinstance(config, Mapping) else {}
    incoming = source.get("configurable", {})
    configurable = incoming if isinstance(incoming, Mapping) else {}
    return {
        "callbacks": [],
        "configurable": {
            k: value
            for k, value in configurable.items()
            if k
            in (
                "trace_id",
                "user_id",
                "thread_id",
                "guardrail_gateway",
                "nestjs_client",
                "trusted_snapshot",
            )
        },
    }


class OutputGuardrailPipeline:
    def __init__(
        self, config: Any, nemo_service: Any = None, session_id: str | None = None
    ) -> None:
        self.config, self.session_id = config, session_id
        self.buffer, self.partial_response, self.closed = (
            ChunkBuffer(),
            "",
            False,
        )

    def _block(self, match: re.Match[str]) -> None:
        self.partial_response += self.buffer.release_raw_prefix(
            self.buffer.raw_index_for_normalized_index(match.start())
        )
        self.buffer.flush()
        raise OutputGuardrailBlockedError(self.partial_response, "deterministic", "PII detection")

    def _pending_candidate_start(self, normalized: str) -> int | None:
        """Find the earliest suffix which can become a supported identifier.

        Whitespace is not a release boundary: it can precede an identifier in
        a later chunk. Only text before an actual detector prefix is approved.
        """
        starts: list[int] = []
        has_digits = any(c.isdigit() for c in normalized)
        has_upper = any(c.isupper() for c in normalized)
        lower_norm = normalized.lower()

        if any(keyword in lower_norm for keyword in _CREDENTIAL_KEYWORDS):
            prefix_match = _CREDENTIAL_PREFIX.search(normalized)
            if prefix_match:
                starts.append(prefix_match.start())

        if has_upper:
            prefix_match = _PASSPORT_PREFIX.search(normalized)
            if prefix_match:
                starts.append(prefix_match.start())

        if has_digits:
            for pattern in (_CARD_PREFIX, _PHONE_PREFIX):
                prefix_match = pattern.search(normalized)
                if prefix_match:
                    starts.append(prefix_match.start())

        prefix_match = _EMAIL_PREFIX.search(normalized)
        if prefix_match:
            starts.append(prefix_match.start())

        return min(starts) if starts else None

    def _release(self) -> str:
        normalized = self.buffer.normalized
        candidate_start = self._pending_candidate_start(normalized)
        if candidate_start is not None:
            return self.buffer.release_raw_prefix(
                self.buffer.raw_index_for_normalized_index(candidate_start)
            )
        # A non-word terminator is a genuine detector boundary only after the
        # candidate-prefix scan above has ruled out a format that accepts it.
        if normalized and not normalized[-1].isalnum() and not normalized[-1].isidentifier():
            return self.buffer.release_raw_prefix(len(self.buffer.raw))
        if len(normalized) <= self.buffer.minimum_undecided_suffix_scalars:
            return ""
        boundary = self.buffer.raw_index_for_normalized_index(
            len(normalized) - self.buffer.minimum_undecided_suffix_scalars
        )
        return self.buffer.release_raw_prefix(boundary)

    async def process_token(self, token: str) -> AsyncGenerator[str, None]:
        if _is_output_guardrail_disabled(self.config):
            yield token
            return
        self.buffer.add_token(token)
        normalized = self.buffer.normalized
        match = deterministic_pii_match(normalized)
        if match:
            self._block(match)
        if self.buffer.raw_utf8_bytes > 8192:
            self.buffer.flush()
            raise OutputGuardrailBlockedError(
                self.partial_response, "deterministic", "pending output overflow"
            )
        safe = self._release()
        if safe:
            self.partial_response += safe
            yield safe

    async def flush(self) -> AsyncGenerator[str, None]:
        if _is_output_guardrail_disabled(self.config):
            return
        match = deterministic_pii_match(self.buffer.normalized)
        if match:
            self._block(match)
        if self.buffer.raw_utf8_bytes > 8192:
            self.buffer.flush()
            raise OutputGuardrailBlockedError(
                self.partial_response, "deterministic", "pending output overflow"
            )
        safe = self.buffer.flush()
        if safe:
            self.partial_response += safe
            yield safe

    async def aclose(self) -> None:
        self.closed = True
        self.buffer.flush()


__all__ = [
    "OutputGuardrailBlockedError",
    "OutputGuardrailPipeline",
    "_CARD",
    "_CREDENTIAL",
    "_EMAIL",
    "_PASSPORT",
    "_PHONE",
    "_is_output_guardrail_disabled",
    "approved_model_content",
    "deterministic_pii_match",
    "payload_free_config",
]
