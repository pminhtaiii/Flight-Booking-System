import pytest
from agent.sanitization.pii_scrubber import detect_pii

def test_detect_pii_clean_text():
    assert detect_pii("Hello world, how are you?") is False
    assert detect_pii("") is False
    assert detect_pii(None) is False

def test_detect_pii_email():
    assert detect_pii("My email is john@example.com") is True
    assert detect_pii("john.doe+filter@sub.domain.co") is True
    assert detect_pii("not-an-email") is False
    assert detect_pii("user@domain") is False

def test_detect_pii_passport():
    assert detect_pii("Passport number: AB1234567") is True
    assert detect_pii("Z999999999") is True
    assert detect_pii("A12345") is False  # Too short

def test_detect_pii_credit_card():
    # Luhn valid card
    assert detect_pii("Check card 4012-8888-8888-1881") is True
    assert detect_pii("4012888888881881") is True
    # Luhn invalid card should not be detected as PII
    assert detect_pii("Check card 4012-8888-8888-1882") is False

def test_detect_pii_phone():
    assert detect_pii("My phone number is +84 123 4567") is True
    assert detect_pii("Call (028) 333-4444") is True
    assert detect_pii("Is 12345 a phone number?") is False

def test_detect_pii_multiple():
    assert detect_pii("Email john@example.com and passport AB1234567") is True
