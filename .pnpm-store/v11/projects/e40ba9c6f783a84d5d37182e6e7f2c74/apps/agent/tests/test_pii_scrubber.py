from agent.sanitization.pii_scrubber import scrub_pii, is_luhn_valid

def test_luhn_validator():
    # Valid credit card numbers
    assert is_luhn_valid("4012888888881881")
    assert is_luhn_valid("4012-8888-8888-1881")
    assert is_luhn_valid("4012 8888 8888 1881")
    
    # Invalid credit card numbers
    assert not is_luhn_valid("4012888888881882")
    assert not is_luhn_valid("1234567890123")

def test_scrub_passport():
    assert scrub_pii("My passport number is AB1234567.") == "My passport number is [PASSPORT REDACTED]."
    assert scrub_pii("Passport: Z999999999") == "Passport: [PASSPORT REDACTED]"
    # Too short passport or invalid characters should not match
    assert scrub_pii("Passport: A12345") == "Passport: A12345"

def test_scrub_credit_card():
    # Valid Luhn card
    assert scrub_pii("My card is 4012-8888-8888-1881.") == "My card is [CARD REDACTED]."
    # Invalid Luhn card should not be scrubbed
    assert scrub_pii("My card is 4012-8888-8888-1882.") == "My card is 4012-8888-8888-1882."

def test_scrub_email():
    assert scrub_pii("Contact me at test.user+abc@domain.co.uk") == "Contact me at [EMAIL REDACTED]"
    assert scrub_pii("my email is info@test.com!") == "my email is [EMAIL REDACTED]!"

def test_scrub_phone():
    assert scrub_pii("Call +84 123 4567") == "Call [PHONE REDACTED]"
    assert scrub_pii("My number is (028) 333-4444") == "My number is [PHONE REDACTED]"
    assert scrub_pii("No phone here") == "No phone here"

def test_scrub_multiple_pii():
    text = "Hello, my email is john.doe@example.com and phone is +1-555-555-5555. My passport is US123456789."
    expected = "Hello, my email is [EMAIL REDACTED] and phone is [PHONE REDACTED]. My passport is [PASSPORT REDACTED]."
    assert scrub_pii(text) == expected
