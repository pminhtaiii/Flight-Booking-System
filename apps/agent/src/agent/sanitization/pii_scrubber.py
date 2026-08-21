import re
from typing import Optional

PASSPORT_REGEX = re.compile(r"\b[A-Z]{1,2}\d{6,9}\b")
CARD_REGEX = re.compile(r"\b\d(?:[ -]?\d){12,18}\b")
EMAIL_REGEX = re.compile(r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b")
PHONE_REGEX = re.compile(
    r"(?<!\w)(?<!\d-)(?<!\d\.)(?<!\d\s)"
    r"(?:\+\d{1,3}[-.\s]?)?\+?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b"
    r"(?![-\s]?\d)"
)


def is_luhn_valid(card_num: str) -> bool:
    """
    Validates a credit card number using the Luhn algorithm.
    """
    digits = [int(c) for c in card_num if c.isdigit()]
    if not digits:
        return False

    checksum = 0
    reverse_digits = digits[::-1]
    for i, digit in enumerate(reverse_digits):
        if i % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        checksum += digit
    return checksum % 10 == 0


def scrub_pii(text: str) -> str:
    """
    Redacts Passport numbers, Credit card numbers (Luhn checked),
    email addresses, and phone numbers from the input text.
    """
    if not text:
        return text

    # 1. Passport numbers
    text = PASSPORT_REGEX.sub("[PASSPORT REDACTED]", text)

    # 2. Credit card numbers
    def card_replacer(match: re.Match) -> str:
        matched_str = match.group(0)
        if is_luhn_valid(matched_str):
            return "[CARD REDACTED]"
        return matched_str

    text = CARD_REGEX.sub(card_replacer, text)

    # 3. Email addresses
    text = EMAIL_REGEX.sub("[EMAIL REDACTED]", text)

    # 4. Phone numbers
    text = PHONE_REGEX.sub("[PHONE REDACTED]", text)

    return text


def detect_pii(text: Optional[str]) -> bool:
    """
    Detects if the input text contains Passport numbers, Credit card numbers (Luhn checked),
    email addresses, or phone numbers. Returns True if PII is detected, False otherwise.
    """
    if not text:
        return False

    # 1. Passport numbers
    if PASSPORT_REGEX.search(text):
        return True

    # 2. Credit card numbers
    for match in CARD_REGEX.finditer(text):
        if is_luhn_valid(match.group(0)):
            return True

    # 3. Email addresses
    if EMAIL_REGEX.search(text):
        return True

    # 4. Phone numbers
    if PHONE_REGEX.search(text):
        return True

    return False
