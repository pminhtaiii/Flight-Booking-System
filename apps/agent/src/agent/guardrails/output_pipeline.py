"""Deterministic public model-output boundary."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, AsyncGenerator

from agent.sanitization.pii_scrubber import is_luhn_valid
from agent.streaming.chunk_buffer import ChunkBuffer


class OutputGuardrailBlockedError(Exception):
    def __init__(
        self,
        partial_response: str,
        layer: str,
        rule: str,
        message: str = "Response was blocked for safety reasons.",
    ) -> None:
        self.partial_response, self.layer, self.rule = partial_response, layer, rule
        super().__init__(message)


_PASSPORT = re.compile(r"(?<![A-Z0-9])[A-Z][0-9]{7,10}(?![A-Z0-9])")
_PASSPORT_ADJACENT = re.compile(r"(?<![A-Z0-9])[A-Z][0-9]{7,10}(?=[A-Z0-9])")
_CARD = re.compile(r"(?<![0-9])(?:[0-9][ -]?){12,18}[0-9](?![0-9])")
_PHONE = re.compile(
    r"(?<![0-9])\+?(?![\d ().-]*\d{4}-\d{2}-\d{2})[0-9][0-9 ().-]{5,38}[0-9](?![0-9:])"
)
_EMAIL = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_EMAIL_LIKE = re.compile(r"\S{1,255}@\S+")
_CREDENTIAL = re.compile(r"(?:api_key=|access_token=|secret=|bearer )\S{1,505}", re.I)
_CREDENTIAL_PREFIX = re.compile(r"(?:api_key=|access_token=|secret=|bearer )\S*$", re.I)
_PASSPORT_PREFIX = re.compile(r"(?<![A-Z0-9])[A-Z][0-9]{0,10}$")
_CARD_PREFIX = re.compile(r"(?<![0-9])[0-9][0-9 -]{0,35}$")
_PHONE_PREFIX = re.compile(r"(?:^|(?<=\s))\+?(?![\d ().-]*\d{4}-\d{2}-\d{2})[0-9][0-9 ().-]{0,38}$")
_EMAIL_PREFIX = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@?[A-Za-z0-9.-]*$")
_DATETIME = re.compile(
    r"\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b"
)


def _is_itinerary_or_date(match: re.Match[str], text: str) -> bool:
    val = match.group(0)
    if re.search(r"\b\d{4}-\d{2}-\d{2}\b", val):
        return True
    end = match.end()
    if end < len(text) and text[end] == ":":
        return True
    start = match.start()
    for dt_m in _DATETIME.finditer(text):
        if max(start, dt_m.start()) < min(end, dt_m.end()):
            return True
    return False


def deterministic_pii_match(text: str, *, include_credentials: bool = True) -> re.Match[str] | None:
    matches = (
        list(_PASSPORT.finditer(text))
        + list(_PASSPORT_ADJACENT.finditer(text))
        + [m for m in _CARD.finditer(text) if is_luhn_valid(m.group(0))]
        + [
            m
            for m in _PHONE.finditer(text)
            if sum(char.isdigit() for char in m.group(0)) >= 10
            and not _is_itinerary_or_date(m, text)
        ]
        + list(_EMAIL.finditer(text))
        + (list(_CREDENTIAL.finditer(text)) if include_credentials else [])
    )
    # Any non-ASCII or overlong email-like identifier is unsupported and must
    # fail closed rather than being released as a near-miss.
    matches += [
        match
        for match in _EMAIL_LIKE.finditer(text)
        if not match.group(0).isascii() or len(match.group(0)) > 254
    ]
    return min(matches, key=lambda match: match.start()) if matches else None


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


def _is_output_guardrail_disabled(config: Any) -> bool:
    if config is None:
        return False
    if getattr(config, "enabled", True) is False:
        return True
    og = getattr(config, "output_guardrail", None)
    if og is not None and getattr(og, "enabled", True) is False:
        return True
    if isinstance(config, Mapping):
        if config.get("enabled") is False:
            return True
        og_dict = config.get("output_guardrail")
        if isinstance(og_dict, Mapping) and og_dict.get("enabled") is False:
            return True
        if og_dict is not None and getattr(og_dict, "enabled", True) is False:
            return True
        conf = config.get("configurable")
        if isinstance(conf, Mapping):
            if conf.get("enabled") is False:
                return True
            og_conf = conf.get("output_guardrail")
            if isinstance(og_conf, Mapping) and og_conf.get("enabled") is False:
                return True
            if og_conf is not None and getattr(og_conf, "enabled", True) is False:
                return True
    return False


async def approved_model_content(content: Any, config: Any = None) -> bool:
    if _is_output_guardrail_disabled(config):
        return True
    return isinstance(content, str) and not deterministic_pii_match(content)


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
        starts = []
        for pattern in (
            _CREDENTIAL_PREFIX,
            _PASSPORT_PREFIX,
            _CARD_PREFIX,
            _PHONE_PREFIX,
            _EMAIL_PREFIX,
        ):
            match = pattern.search(normalized)
            if match:
                starts.append(match.start())
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
