"""Deterministic PII inspection and output safety utilities."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from agent.sanitization.pii_scrubber import is_luhn_valid

_PASSPORT = re.compile(r"(?<![A-Z0-9])[A-Z][0-9]{7,10}(?![A-Z0-9])")
_PASSPORT_ADJACENT = re.compile(r"(?<![A-Z0-9])[A-Z][0-9]{7,10}(?=[A-Z0-9])")
_CARD = re.compile(r"(?<![0-9])(?:[0-9][ -]?){12,18}[0-9](?![0-9])")
_PHONE = re.compile(
    r"(?<!\d)(?<!\d-)\+?(?!\d{4}-\d{2}-\d{2})[0-9](?:[0-9]|[- .()](?!\d{4}-\d{2}-\d{2})){5,38}[0-9](?![0-9:])"
)
_EMAIL = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_EMAIL_LIKE = re.compile(r"\S{1,255}@\S+")
_CREDENTIAL = re.compile(
    r"(?:api_key[=:][ \t]{0,4}|access_token[=:][ \t]{0,4}|secret[=:][ \t]{0,4}|bearer[ \t]{1,4})\S{1,495}",
    re.I,
)
_CREDENTIAL_PREFIX = re.compile(
    r"(?:api_key[=:][ \t]{0,4}|access_token[=:][ \t]{0,4}|secret[=:][ \t]{0,4}|bearer[ \t]{0,4})\S*$",
    re.I,
)
_PASSPORT_PREFIX = re.compile(r"(?<![A-Z0-9])[A-Z][0-9]{0,10}$")
_CARD_PREFIX = re.compile(r"(?<![0-9])[0-9][0-9 -]{0,35}$")
_PHONE_PREFIX = re.compile(
    r"(?:^|(?<=\s))\+?(?!\d{4}-\d{2}-\d{2})[0-9](?:[0-9]|[- .()](?!\d{4}-\d{2}-\d{2})){0,38}$"
)
_EMAIL_PREFIX = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@?[A-Za-z0-9.-]*$")
_DATETIME = re.compile(
    r"\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b"
)
_DATE_RANGE = re.compile(
    r"^\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?"
    r"\s*(?:-|–|—|to|\/)\s*"
    r"\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\s*$"
)

_CREDENTIAL_KEYWORDS: tuple[str, ...] = ("api_key", "access_token", "secret", "bearer")


def _is_itinerary_or_date(match: re.Match[str], text: str) -> bool:
    val = match.group(0).strip()
    if _DATETIME.fullmatch(val) or _DATE_RANGE.fullmatch(val):
        return True
    start, end = match.start(), match.end()
    for dt_m in _DATETIME.finditer(text):
        if dt_m.start() <= start and end <= dt_m.end():
            return True
    return False


def deterministic_pii_match(text: str, *, include_credentials: bool = True) -> re.Match[str] | None:
    has_digits = any(c.isdigit() for c in text)
    has_at = "@" in text
    lower_text = text.lower() if include_credentials else ""
    has_cred = include_credentials and any(
        keyword in lower_text for keyword in _CREDENTIAL_KEYWORDS
    )

    if not (has_digits or has_at or has_cred):
        return None

    matches: list[re.Match[str]] = []
    if has_digits:
        matches.extend(_PASSPORT.finditer(text))
        matches.extend(_PASSPORT_ADJACENT.finditer(text))
        matches.extend(
            card_match for card_match in _CARD.finditer(text) if is_luhn_valid(card_match.group(0))
        )
        matches.extend(
            phone_match
            for phone_match in _PHONE.finditer(text)
            if sum(char.isdigit() for char in phone_match.group(0)) >= 10
            and not _is_itinerary_or_date(phone_match, text)
        )
    if has_at:
        matches.extend(_EMAIL.finditer(text))
        matches.extend(
            match
            for match in _EMAIL_LIKE.finditer(text)
            if not match.group(0).isascii() or len(match.group(0)) > 254
        )
    if has_cred:
        matches.extend(_CREDENTIAL.finditer(text))

    return min(matches, key=lambda match: match.start()) if matches else None


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
        elif conf is not None:
            if getattr(conf, "enabled", True) is False:
                return True
            og_conf = getattr(conf, "output_guardrail", None)
            if og_conf is not None and (
                (isinstance(og_conf, Mapping) and og_conf.get("enabled") is False)
                or getattr(og_conf, "enabled", True) is False
            ):
                return True
    return False


async def approved_model_content(content: Any, config: Any = None) -> bool:
    if _is_output_guardrail_disabled(config):
        return True
    return isinstance(content, str) and not deterministic_pii_match(content)


__all__ = [
    "approved_model_content",
    "deterministic_pii_match",
    "_is_output_guardrail_disabled",
    "_is_itinerary_or_date",
    "_CREDENTIAL_KEYWORDS",
    "_CREDENTIAL_PREFIX",
    "_PASSPORT_PREFIX",
    "_CARD_PREFIX",
    "_PHONE_PREFIX",
    "_EMAIL_PREFIX",
    "_PASSPORT",
    "_PASSPORT_ADJACENT",
    "_CARD",
    "_PHONE",
    "_EMAIL",
    "_EMAIL_LIKE",
    "_CREDENTIAL",
    "_DATETIME",
    "_DATE_RANGE",
]
