"""
agent.guardrails.layers.input
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Deterministic input guardrail layers enforcing length bounds, PII sanitization
with reviewed travel exceptions, compiled injection detection, and travel domain
topic adherence.
"""

import re
from typing import Any, ClassVar, Literal

from agent.guardrails.base import (
    GUARDRAIL_INPUT_INJECTION,
    GUARDRAIL_INPUT_LENGTH,
    GUARDRAIL_INPUT_PII,
    GUARDRAIL_INPUT_TOPIC,
    AdmissionContext,
    BaseGuardrailLayer,
    PipelineDecision,
    TurnCapabilities,
    ValidatedInput,
)
from agent.guardrails.layers.injection import InjectionSignatureEngine
from agent.guardrails.normalization import safe_regex_match
from agent.sanitization.pii_scrubber import (
    CARD_REGEX,
    EMAIL_REGEX,
    PASSPORT_REGEX,
    PHONE_REGEX,
    is_luhn_valid,
)


class LengthValidator(BaseGuardrailLayer):
    """
    Enforces maximum Unicode scalar length and UTF-8 byte length limits
    to prevent context exhaustion, buffer saturation, and memory overflow attacks.
    """

    key: ClassVar[str] = "input.length"
    stage: ClassVar[Literal["input"]] = "input"
    prerequisites: ClassVar[tuple[str, ...]] = ()

    def __init__(
        self,
        max_characters: int = 4000,
        max_bytes: int = 16384,
        key: str | None = None,
        stage: Literal["input", "tool", "output"] | None = None,
        prerequisites: tuple[str, ...] | None = None,
    ) -> None:
        super().__init__(key=key, stage=stage, prerequisites=prerequisites)
        self.max_characters = max_characters
        self.max_bytes = max_bytes

    async def check(
        self,
        context: AdmissionContext | TurnCapabilities,
        data: Any,
    ) -> PipelineDecision[ValidatedInput]:
        content = data if isinstance(data, str) else getattr(data, "content", str(data))

        # Unicode scalar count
        if len(content) > self.max_characters:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_LENGTH,
                reason=f"Input exceeds maximum character length {self.max_characters}",
                validated_data=None,
            )

        # UTF-8 encoded byte count
        if len(content.encode("utf-8")) > self.max_bytes:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_LENGTH,
                reason=f"Input exceeds maximum byte length {self.max_bytes}",
                validated_data=None,
            )

        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content=content),
        )


def _contains_sensitive_pii(text: str) -> bool:
    """
    Detects credit cards (with Luhn validation), passport numbers, email addresses,
    and phone numbers in raw user input, allowing reviewed travel exceptions.
    """
    if not text:
        return False

    # 1. Credit card numbers with Luhn validation
    for match in CARD_REGEX.finditer(text):
        if is_luhn_valid(match.group(0)):
            return True

    # 2. Email addresses
    if EMAIL_REGEX.search(text):
        return True

    # 3. Phone numbers
    if PHONE_REGEX.search(text):
        return True

    # 4. Passport numbers ([A-Z]{1,2}\d{6,9})
    # Travel Exception: flight numbers (e.g. VN123456 preceded by flight/flt) are allowed
    for match in PASSPORT_REGEX.finditer(text):
        start = match.start()
        prefix = text[:start].rstrip().lower()
        if any(
            prefix.endswith(p)
            for p in ("flight", "flight no", "flight no.", "flight number", "flt", "flt.")
        ):
            continue
        return True

    return False


class PIIDetector(BaseGuardrailLayer):
    """
    Scans raw user input for sensitive credentials and identity markers (credit cards,
    passports, emails, phone numbers) while permitting benign travel entities (passenger
    names, IATA airport codes, flight dates/numbers).
    """

    key: ClassVar[str] = "input.pii"
    stage: ClassVar[Literal["input"]] = "input"
    prerequisites: ClassVar[tuple[str, ...]] = ("input.length",)

    async def check(
        self,
        context: AdmissionContext | TurnCapabilities,
        data: Any,
    ) -> PipelineDecision[ValidatedInput]:
        content = data if isinstance(data, str) else getattr(data, "content", str(data))

        if _contains_sensitive_pii(content):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_PII,
                reason=(
                    "Input contains sensitive personal information (PII). "
                    "Please remove credit card, passport, or contact details before continuing."
                ),
                validated_data=None,
            )

        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content=content),
        )


class InjectionDetector(BaseGuardrailLayer):
    """
    High-performance prompt injection detection layer delegating to InjectionSignatureEngine
    for multi-round unmasking, base64 payload extraction, and ReDoS-safe signature matching.
    """

    key: ClassVar[str] = "input.injection"
    stage: ClassVar[Literal["input"]] = "input"
    prerequisites: ClassVar[tuple[str, ...]] = ("input.length",)

    def __init__(
        self,
        engine: InjectionSignatureEngine | None = None,
        key: str | None = None,
        stage: Literal["input", "tool", "output"] | None = None,
        prerequisites: tuple[str, ...] | None = None,
    ) -> None:
        super().__init__(key=key, stage=stage, prerequisites=prerequisites)
        self.engine = engine or InjectionSignatureEngine()

    async def check(
        self,
        context: AdmissionContext | TurnCapabilities,
        data: Any,
    ) -> PipelineDecision[ValidatedInput]:
        content = data if isinstance(data, str) else getattr(data, "content", str(data))

        is_injection, _ = self.engine.scan(content)
        if is_injection:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_INJECTION,
                reason="Prompt injection detected",
                validated_data=None,
            )

        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content=content),
        )


# Comprehensive patterns identifying queries outside the flight booking domain
OUT_OF_DOMAIN_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Coding and scripting requests
    re.compile(r"\bpython\s+script\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+code\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+some\s+code\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+script\b", re.IGNORECASE),
    re.compile(r"\bhow\s+to\s+code\b", re.IGNORECASE),
    re.compile(r"\bcode\s+in\s+typescript\b", re.IGNORECASE),
    re.compile(r"\bcode\s+in\s+python\b", re.IGNORECASE),
    re.compile(r"\bcode\s+in\s+javascript\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+program\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+an\s+algorithm\b", re.IGNORECASE),
    re.compile(r"\bdebug\s+this\s+code\b", re.IGNORECASE),
    re.compile(r"\bdebug\s+my\s+code\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+function\b", re.IGNORECASE),
    # Creative writing (essays, stories, poems, lyrics)
    re.compile(r"\bwrite\s+an\s+essay\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+essay\b", re.IGNORECASE),
    re.compile(r"\btell\s+me\s+a\s+story\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+story\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+poem\b", re.IGNORECASE),
    re.compile(r"\bcompose\s+a\s+poem\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+a\s+song\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+lyrics\b", re.IGNORECASE),
    # Medical advice
    re.compile(r"\bmedical\s+advice\b", re.IGNORECASE),
    re.compile(r"\bwhat\s+medicine\s+should\s+i\s+take\b", re.IGNORECASE),
    re.compile(r"\bdiagnose\s+my\b", re.IGNORECASE),
    re.compile(r"\bprescribe\s+me\b", re.IGNORECASE),
    re.compile(r"\bmedical\s+diagnosis\b", re.IGNORECASE),
    re.compile(r"\btreatment\s+for\s+cancer\b", re.IGNORECASE),
    # Legal advice & lawsuits
    re.compile(r"\blegal\s+advice\b", re.IGNORECASE),
    re.compile(r"\blegal\s+counsel\b", re.IGNORECASE),
    re.compile(r"\bhow\s+to\s+sue\b", re.IGNORECASE),
    re.compile(r"\bfile\s+a\s+lawsuit\b", re.IGNORECASE),
    # Finance & investments
    re.compile(r"\bfinancial\s+advice\b", re.IGNORECASE),
    re.compile(r"\binvest\s+in\s+bitcoin\b", re.IGNORECASE),
    re.compile(r"\binvest\s+in\s+crypto\b", re.IGNORECASE),
    re.compile(r"\bbuy\s+crypto\b", re.IGNORECASE),
    re.compile(r"\bbuy\s+stocks\b", re.IGNORECASE),
    re.compile(r"\bstock\s+market\s+tips\b", re.IGNORECASE),
    re.compile(r"\bforex\s+trading\b", re.IGNORECASE),
    # Generic hacking & exploits
    re.compile(r"\bhow\s+to\s+hack\b", re.IGNORECASE),
    re.compile(r"\bddos\s+attack\b", re.IGNORECASE),
    re.compile(r"\bexploit\s+vulnerability\b", re.IGNORECASE),
    re.compile(r"\bcrack\s+this\s+password\b", re.IGNORECASE),
    re.compile(r"\bcreate\s+a\s+virus\b", re.IGNORECASE),
    re.compile(r"\bmalware\s+script\b", re.IGNORECASE),
)


class TopicBoundary(BaseGuardrailLayer):
    """
    Enforces conversation topic adherence strictly to the travel and flight booking domain,
    blocking out-of-domain requests (programming, medicine, law, finance, hacking, creative writing)
    while allowing legitimate flight searches, bookings, baggage inquiries, and status queries.
    """

    key: ClassVar[str] = "input.topic"
    stage: ClassVar[Literal["input"]] = "input"
    prerequisites: ClassVar[tuple[str, ...]] = ("input.length",)

    def __init__(
        self,
        key: str | None = None,
        stage: Literal["input", "tool", "output"] | None = None,
        prerequisites: tuple[str, ...] | None = None,
    ) -> None:
        super().__init__(key=key, stage=stage, prerequisites=prerequisites)

    async def check(
        self,
        context: AdmissionContext | TurnCapabilities,
        data: Any,
    ) -> PipelineDecision[ValidatedInput]:
        content = data if isinstance(data, str) else getattr(data, "content", str(data))

        for pattern in OUT_OF_DOMAIN_PATTERNS:
            if safe_regex_match(pattern, content):
                return PipelineDecision(
                    status="BLOCK",
                    response_key=GUARDRAIL_INPUT_TOPIC,
                    reason=(
                        "Your message appears to be outside our flight booking scope. "
                        "How can I help with your flights, baggage, or airline reservations?"
                    ),
                    validated_data=None,
                )

        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content=content),
        )


__all__ = [
    "LengthValidator",
    "PIIDetector",
    "InjectionDetector",
    "TopicBoundary",
    "OUT_OF_DOMAIN_PATTERNS",
]
