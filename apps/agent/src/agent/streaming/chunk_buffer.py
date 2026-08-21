import logging
from typing import Optional

import tiktoken

logger = logging.getLogger("agent.guardrails")


class ChunkBuffer:
    def __init__(self, max_chunk_tokens: int = 200):
        self.max_chunk_tokens = max_chunk_tokens
        self.buffer = ""
        try:
            self.encoding = tiktoken.get_encoding("cl100k_base")
        except Exception as e:
            logger.error(
                f"Failed to load tiktoken encoding for ChunkBuffer: {e!s}. Falling back to character approximation."
            )
            self.encoding = None

    def add_token(self, token: str) -> Optional[str]:
        """
        Adds a token to the buffer and checks for a sentence boundary or max token limit.
        Returns the completed chunk if a split occurs, otherwise None.
        """
        self.buffer += token

        # Check if we have a sentence boundary
        split_idx = self._find_boundary()
        if split_idx is not None:
            chunk = self.buffer[:split_idx]
            self.buffer = self.buffer[split_idx:]
            return chunk

        # Check if we exceeded the token limit
        if self._exceeds_token_limit():
            return self._force_split()

        return None

    def flush(self) -> Optional[str]:
        """
        Flushes the remaining buffer. Returns the content if not empty, otherwise None.
        """
        if not self.buffer:
            return None
        chunk = self.buffer
        self.buffer = ""
        return chunk

    def _find_boundary(self) -> Optional[int]:
        """
        Finds the first sentence boundary index in self.buffer.
        Returns the index where the next chunk should start (i.e. start of next sentence),
        or None if no boundary is found.
        """
        text = self.buffer
        inside_code_block = False
        i = 0
        n = len(text)

        # Common abbreviations to skip
        ABBREVIATIONS = {
            "mr",
            "dr",
            "st",
            "mrs",
            "ms",
            "jr",
            "sr",
            "prof",
            "vs",
            "inc",
            "co",
            "corp",
            "am",
            "pm",
        }

        while i < n:
            # Check for code fence block start/end
            if text[i : i + 3] == "```":
                inside_code_block = not inside_code_block
                i += 3
                continue

            if inside_code_block:
                i += 1
                continue

            c = text[i]
            # Potential split character: '.', '!', '?', or '\n'
            if c in (".", "!", "?", "\n"):
                # Find the next non-whitespace character
                j = i + 1
                while j < n and text[j] in (" ", "\t", "\n", "\r"):
                    j += 1

                # If next non-whitespace character exists and is uppercase:
                if j < n and text[j].isupper():
                    if c == ".":
                        # Check abbreviation heuristics:

                        # 1. Single uppercase letter or common abbreviation
                        w_start = i - 1
                        while w_start >= 0 and text[w_start].isalpha():
                            w_start -= 1
                        prev_word = text[w_start + 1 : i]

                        if len(prev_word) == 1 and prev_word.isupper():
                            i += 1
                            continue

                        # Check for compound abbreviations like a.m. / p.m.
                        is_ampm = False
                        if i >= 3:
                            last_3 = text[i - 3 : i].lower()
                            if last_3 in ("a.m", "p.m"):
                                is_ampm = True

                        if prev_word.lower() in ABBREVIATIONS or is_ampm:
                            i += 1
                            continue

                        # 2. Decimal numbers: dot preceded by only digits and followed by a digit
                        if i + 1 < n and text[i + 1].isdigit():
                            is_num_preceded = False
                            p = i - 1
                            if p >= 0 and text[p].isdigit():
                                is_num_preceded = True
                                while p >= 0:
                                    if text[p].isalpha():
                                        is_num_preceded = False
                                        break
                                    if text[p].isspace():
                                        break
                                    p -= 1
                            if is_num_preceded:
                                i += 1
                                continue

                    # If it's a valid split point, return the start index of the next chunk (j)
                    return j
            i += 1
        return None

    def _exceeds_token_limit(self) -> bool:
        """
        Check if the current buffer exceeds the maximum token limit.
        """
        if self.encoding:
            try:
                tokens = self.encoding.encode(self.buffer)
                return len(tokens) > self.max_chunk_tokens
            except Exception as e:  # noqa: BLE001
                logger.warning(f"tiktoken encode failed, falling back to char approximation: {e!s}")
        # Fallback to character approximation
        return len(self.buffer) > self.max_chunk_tokens * 4

    def _force_split(self) -> str:
        """
        Force-splits the buffer at max_chunk_tokens.
        Returns the prefix of length max_chunk_tokens, updating the buffer to the rest.
        """
        if self.encoding:
            try:
                tokens = self.encoding.encode(self.buffer)
                prefix_tokens = tokens[: self.max_chunk_tokens]
                suffix_tokens = tokens[self.max_chunk_tokens :]

                prefix = self.encoding.decode(prefix_tokens)
                suffix = self.encoding.decode(suffix_tokens)

                self.buffer = suffix
                return prefix
            except Exception as e:  # noqa: BLE001
                logger.warning(f"tiktoken split failed, falling back to char approximation: {e!s}")

        # Fallback to character split
        char_limit = self.max_chunk_tokens * 4
        prefix = self.buffer[:char_limit]
        self.buffer = self.buffer[char_limit:]
        return prefix
