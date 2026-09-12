"""Safe guardrail fixture: uses pure deterministic regex and algorithmic parsing."""

import re
from typing import Pattern


class SafeDeterministicGuardrail:
    """Guardrail layer using deterministic compiled regex checks without any model."""

    BLOCKLIST_PATTERN: Pattern[str] = re.compile(
        r"(?i)\b(system\s+prompt|ignore\s+previous|bypass|override)\b"
    )

    def validate_input(self, text: str) -> bool:
        # Compliant: Deterministic algorithmic check
        if not text or len(text) > 4000:
            return False
        match = self.BLOCKLIST_PATTERN.search(text)
        return match is None

    def sanitize_text(self, text: str) -> str:
        # Compliant: Deterministic regex substitution
        return self.BLOCKLIST_PATTERN.sub("[REDACTED]", text)
