"""
agent.guardrails.normalization
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Input normalization and sanitization utilities for deterministic guardrail evaluation.
Provides bounded Unicode, zero-width stripping, nested URL decoding, base64 payload
detection, homoglyph translation, and ReDoS-resistant regex execution.
"""

import base64
import re
import unicodedata
import urllib.parse
from typing import Any, Literal

try:
    import re._constants as sre_constants
    import re._parser as sre_parse
except ImportError:
    import sre_constants  # type: ignore[no-redef]
    import sre_parse  # type: ignore[no-redef]

# Zero-width, invisible formatting, and directional override characters
# U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ), U+FEFF (BOM/ZWNBSP),
# U+200E (LRM), U+200F (RLM), U+00AD (soft hyphen), U+2060 (word joiner),
# U+2061-U+2064 (invisible math operators), U+206A-U+206F (format controls),
# U+180E (Mongolian vowel separator), U+202A-U+202E (Bidi controls),
# U+2066-U+2069 (Bidi isolates).
ZERO_WIDTH_PATTERN: re.Pattern[str] = re.compile(
    r"[\u200b-\u200f\ufeff\u00ad\u2060-\u206f\u180e\u202a-\u202e]"
)

# Common Cyrillic, Greek, and phonetic homoglyphs mapping to Latin equivalents
HOMOGLYPH_MAPPINGS: dict[str, str] = {
    # Cyrillic lowercase
    "\u0430": "a",
    "\u0435": "e",
    "\u043e": "o",
    "\u0440": "p",
    "\u0441": "c",
    "\u0443": "y",
    "\u0445": "x",
    "\u0456": "i",
    "\u0458": "j",
    # Cyrillic uppercase
    "\u0410": "A",
    "\u0412": "B",
    "\u0415": "E",
    "\u041a": "K",
    "\u041c": "M",
    "\u041d": "H",
    "\u041e": "O",
    "\u0420": "P",
    "\u0421": "C",
    "\u0422": "T",
    "\u0425": "X",
    # Greek lowercase
    "\u03b1": "a",
    "\u03bf": "o",
    "\u03c1": "p",
    # Greek uppercase
    "\u0391": "A",
    "\u0392": "B",
    "\u0395": "E",
    "\u0397": "H",
    "\u0399": "I",
    "\u039a": "K",
    "\u039c": "M",
    "\u039d": "N",
    "\u039f": "O",
    "\u03a1": "P",
    "\u03a4": "T",
    "\u03a7": "X",
    "\u03a5": "Y",
    "\u0396": "Z",
    # Phonetic / Latin script lookalikes
    "\u0261": "g",  # Latin script small letter script g
    "\u0131": "i",  # Latin small letter dotless i
    "\u0237": "j",  # Latin small letter dotless j
    "\u0142": "l",  # Latin small letter l with stroke
    "\u0141": "L",  # Latin capital letter L with stroke
}

_HOMOGLYPH_TABLE = str.maketrans(HOMOGLYPH_MAPPINGS)

# Base64 candidate regex: blocks of valid base64 chars with optional padding, min 8 chars
_BASE64_PATTERN: re.Pattern[str] = re.compile(
    r"(?:[A-Za-z0-9+/]{4}){2,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?"
)

# Bounds for regex scanning and ReDoS safety
_MAX_CATASTROPHIC_INPUT_LEN: int = 30
_MAX_REGEX_SCAN_LENGTH: int = 8192


def normalize_unicode(
    text: str,
    form: Literal["NFC", "NFD", "NFKC", "NFKD"] = "NFKC",
) -> str:
    """
    Normalizes Unicode text into canonical or compatibility forms (NFC, NFD, NFKC, NFKD).
    Defaults to NFKC for security normalization.
    """
    if form not in ("NFC", "NFD", "NFKC", "NFKD"):
        raise ValueError(
            f"Invalid Unicode normalization form '{form}'. Must be NFC, NFD, NFKC, or NFKD."
        )
    return unicodedata.normalize(form, text)


def strip_zero_width(text: str) -> str:
    """
    Safely removes zero-width, invisible format, and directional control characters.
    """
    return ZERO_WIDTH_PATTERN.sub("", text)


def normalize_homoglyphs(text: str) -> str:
    """
    Normalizes common Cyrillic, Greek, and phonetic homoglyphs to their Latin equivalents.
    """
    return text.translate(_HOMOGLYPH_TABLE)


def decode_nested_url(
    text: str,
    max_rounds: int = 3,
    max_length: int = 65536,
) -> str:
    """
    Decodes URL percent-encoding recursively up to max_rounds, stopping if no change
    occurs or if payload expands past max_length.
    """
    current = text
    for _ in range(max_rounds):
        if "%" not in current:
            break
        unquoted = urllib.parse.unquote(current)
        if unquoted == current:
            break
        if len(unquoted) > max_length:
            break
        current = unquoted
    return current


def detect_base64_payloads(text: str) -> list[str]:
    """
    Identifies base64-encoded substrings in text and returns decoded ASCII/UTF-8 candidates.
    Filters out binary fragments and arbitrary plain words by checking canonical re-encoding.
    """
    results: list[str] = []
    seen: set[str] = set()

    for match in _BASE64_PATTERN.finditer(text):
        candidate = match.group(0)
        try:
            padded = candidate + "=" * ((4 - len(candidate) % 4) % 4)
            raw = base64.b64decode(padded, validate=True)
            reencoded = base64.b64encode(raw).decode("ascii").rstrip("=")
            if candidate.rstrip("=") != reencoded:
                continue
            decoded = raw.decode("utf-8")
            if len(decoded.strip()) >= 3 and all(
                c.isprintable() or c in "\r\n\t " for c in decoded
            ):
                if decoded not in seen:
                    seen.add(decoded)
                    results.append(decoded)
        except Exception:
            continue

    return results


def bounded_normalize(
    text: str,
    max_rounds: int = 3,
    normalize_homoglyphs_flag: bool = True,
) -> str:
    """
    Composite security normalization pipeline:
    1. Strips zero-width and invisible format characters
    2. Normalizes Unicode NFKC
    3. Recursively decodes nested URL encodings up to max_rounds
    4. Strips zero-width characters revealed by URL decoding
    5. Normalizes Unicode NFKC again
    6. Normalizes homoglyphs (Cyrillic, Greek, IPA lookalikes) if enabled
    """
    cleaned = strip_zero_width(text)
    cleaned = normalize_unicode(cleaned, "NFKC")
    cleaned = decode_nested_url(cleaned, max_rounds=max_rounds)
    cleaned = strip_zero_width(cleaned)
    cleaned = normalize_unicode(cleaned, "NFKC")
    if normalize_homoglyphs_flag:
        cleaned = normalize_homoglyphs(cleaned)
    return cleaned


def is_catastrophic_regex(pattern_str: str) -> bool:
    """
    Statically inspects regex AST to detect nested quantifiers or branch alternations inside
    quantified repetitions that produce catastrophic exponential backtracking (ReDoS).
    """
    try:
        parsed = sre_parse.parse(pattern_str)
    except Exception:
        return True

    def _check(items: Any, inside_repeat: bool = False) -> bool:
        for op, av in items:
            if op in (sre_constants.MAX_REPEAT, sre_constants.MIN_REPEAT):
                if inside_repeat:
                    return True
                sub = av[2]
                if _check(sub, inside_repeat=True):
                    return True
            elif op == sre_constants.SUBPATTERN:
                sub = av[-1]
                if _check(sub, inside_repeat=inside_repeat):
                    return True
            elif op == sre_constants.BRANCH:
                if inside_repeat:
                    return True
                for branch in av[1]:
                    if _check(branch, inside_repeat=inside_repeat):
                        return True
        return False

    return _check(parsed.data)


def safe_regex_match(
    pattern: re.Pattern[str] | str,
    text: str,
    timeout_seconds: float = 0.05,
) -> bool:
    """
    ReDoS-resistant regex matcher with bounded execution timeout or bounded input length.
    Detects catastrophic backtracking patterns via AST inspection and bounds input length
    to guarantee termination within bounded time limits.
    """
    pattern_str = pattern.pattern if isinstance(pattern, re.Pattern) else pattern
    compiled = pattern if isinstance(pattern, re.Pattern) else re.compile(pattern_str)

    if is_catastrophic_regex(pattern_str):
        if len(text) > _MAX_CATASTROPHIC_INPUT_LEN:
            return False

    bounded_text = text[:_MAX_REGEX_SCAN_LENGTH]
    return compiled.search(bounded_text) is not None


__all__ = [
    "ZERO_WIDTH_PATTERN",
    "HOMOGLYPH_MAPPINGS",
    "normalize_unicode",
    "strip_zero_width",
    "normalize_homoglyphs",
    "decode_nested_url",
    "detect_base64_payloads",
    "bounded_normalize",
    "is_catastrophic_regex",
    "safe_regex_match",
]
