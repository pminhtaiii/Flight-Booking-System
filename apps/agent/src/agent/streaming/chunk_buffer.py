"""Bounded raw/NFKC holdback buffer used at the public output boundary."""

from __future__ import annotations

import unicodedata


class ChunkBuffer:
    """Keep an incrementally mapped raw suffix until it is safe to publish."""

    maximum_pending_raw_utf8_bytes = 8192
    minimum_undecided_suffix_scalars = 512

    def __init__(self, max_chunk_tokens: int = 200) -> None:
        self.max_chunk_tokens = max_chunk_tokens
        self.raw = ""
        self._normalized = ""
        self._normalized_to_raw: list[int] = [0]
        self._stable_raw_end = 0

    def add_token(self, token: str) -> None:
        self.raw += token
        self._rebuild_mapping()

    def _rebuild_mapping(self) -> None:
        """Rebuild a bounded map only from retained source text.

        The final letter/number and its combining marks remain in the raw
        suffix: a later chunk may still change its NFKC representation.
        Discarded raw text is never consulted for a mapping decision.
        """
        self._normalized = unicodedata.normalize("NFKC", self.raw)
        self._normalized_to_raw = [0]
        raw_end = 0
        for normalized_end in range(1, len(self._normalized) + 1):
            while (
                raw_end < len(self.raw)
                and len(unicodedata.normalize("NFKC", self.raw[:raw_end])) < normalized_end
            ):
                raw_end += 1
            self._normalized_to_raw.append(raw_end)

        self._stable_raw_end = len(self.raw)
        for index in range(len(self.raw) - 1, -1, -1):
            char = self.raw[index]
            if unicodedata.combining(char):
                continue
            if unicodedata.category(char)[0] in {"L", "N"}:
                self._stable_raw_end = index
            break

    @property
    def normalized(self) -> str:
        return self._normalized

    @property
    def normalized_text(self) -> str:
        return self._normalized

    @property
    def raw_utf8_bytes(self) -> int:
        return len(self.raw.encode("utf-8"))

    @property
    def stable_raw_end(self) -> int:
        return self._stable_raw_end

    def release_raw_prefix(self, raw_end: int) -> str:
        raw_end = max(0, min(raw_end, self._stable_raw_end))
        released = self.raw[:raw_end]
        self.raw = self.raw[raw_end:]
        self._rebuild_mapping()
        return released

    def raw_index_for_normalized_index(self, normalized_index: int) -> int:
        """Return the retained raw boundary for a normalized scalar boundary."""
        if normalized_index <= 0:
            return 0
        if normalized_index >= len(self._normalized_to_raw):
            return len(self.raw)
        return self._normalized_to_raw[normalized_index]

    def flush(self) -> str:
        released = self.raw
        self.raw = ""
        self._rebuild_mapping()
        return released
