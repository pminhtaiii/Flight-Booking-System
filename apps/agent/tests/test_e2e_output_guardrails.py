"""End-to-end deterministic output-boundary regression coverage.

2026-09-06 user-approved replacement for output NeMo integration tests.
"""

from __future__ import annotations

import ast
import importlib
from pathlib import Path
from types import SimpleNamespace

import pytest

try:
    from agent.guardrails.base import OutputGuardrailBlockedError
except ImportError:
    from agent.guardrails.output_pipeline import OutputGuardrailBlockedError

from agent.guardrails.output_pipeline import OutputGuardrailPipeline

try:
    from agent.guardrails.pii import (
        _is_output_guardrail_disabled,
        approved_model_content,
        deterministic_pii_match,
    )
except ImportError:
    from agent.guardrails.output_pipeline import (
        _is_output_guardrail_disabled,
        approved_model_content,
        deterministic_pii_match,
    )


@pytest.mark.asyncio
async def test_safe_completion_flushes_after_deterministic_inspection() -> None:
    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    emitted = [chunk async for chunk in pipeline.process_token("A safe itinerary update.")]
    emitted.extend([chunk async for chunk in pipeline.flush()])
    assert "".join(emitted) == "A safe itinerary update."


@pytest.mark.asyncio
async def test_detected_card_raises_hard_stop() -> None:
    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    with pytest.raises(OutputGuardrailBlockedError):
        async for _ in pipeline.process_token("4111-1111-1111-1111"):
            pass


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text",
    [
        "Your flight is confirmed for 2026-09-10 10:30.",
        "Departure: 2026-09-10 10:30, Arrival: 2026-09-10 14:00.",
        "Trip dates: 2026-09-10 - 2026-09-15.",
        "Flight at 2026-09-10 10:30:00 departing on 2026-09-10.",
        "ISO timestamp 2026-09-10T10:30:00Z confirmed.",
    ],
)
async def test_itinerary_timestamps_not_blocked_by_guardrail(text: str) -> None:
    try:
        from agent.guardrails.pii import _PHONE
    except (ImportError, AttributeError):
        from agent.guardrails.output_pipeline import _PHONE

    # Neither _PHONE nor deterministic_pii_match should falsely flag itinerary dates/times
    phone_matches = [m for m in _PHONE.finditer(text) if sum(c.isdigit() for c in m.group(0)) >= 10]
    assert phone_matches == []
    assert deterministic_pii_match(text) is None
    assert await approved_model_content(text) is True

    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    emitted = [chunk async for chunk in pipeline.process_token(text)]
    emitted.extend([chunk async for chunk in pipeline.flush()])
    assert "".join(emitted) == text


@pytest.mark.asyncio
async def test_real_phone_with_itinerary_timestamp_is_blocked() -> None:
    text = "Your flight is on 2026-09-10 10:30. Call support at +1 415 555 2671."
    match = deterministic_pii_match(text)
    assert match is not None
    assert "+1 415 555 2671" in match.group(0)

    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    with pytest.raises(OutputGuardrailBlockedError):
        async for _ in pipeline.process_token(text):
            pass


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text",
    [
        "2026-09-10 415-555-2671",
        "415-555-2671 2026-09-10",
        "Flight 2026-09-10 415-555-2671 confirmed",
        "Call 415-555-2671 before 2026-09-10",
    ],
)
async def test_adjacent_date_phone_numbers_are_blocked(text: str) -> None:
    match = deterministic_pii_match(text)
    assert match is not None, f"Expected phone number in {text!r} to be matched as PII"
    assert "415-555-2671" in match.group(0) or "415" in match.group(0)

    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    with pytest.raises(OutputGuardrailBlockedError):
        async for _ in pipeline.process_token(text):
            pass
        async for _ in pipeline.flush():
            pass


@pytest.mark.asyncio
async def test_approved_model_content_and_pipeline_respect_disabled_config() -> None:
    unsafe_content = "Contact traveler at +1 415 555 2671 or card 4111-1111-1111-1111"

    # Default/enabled blocks unsafe content
    assert await approved_model_content(unsafe_content) is False
    assert await approved_model_content(unsafe_content, SimpleNamespace(enabled=True)) is False

    # Disabled configs approve without blocking
    assert await approved_model_content(unsafe_content, SimpleNamespace(enabled=False)) is True
    assert (
        await approved_model_content(
            unsafe_content,
            SimpleNamespace(output_guardrail=SimpleNamespace(enabled=False)),
        )
        is True
    )
    assert await approved_model_content(unsafe_content, {"enabled": False}) is True
    assert (
        await approved_model_content(unsafe_content, {"output_guardrail": {"enabled": False}})
        is True
    )
    assert (
        await approved_model_content(
            unsafe_content,
            {"configurable": {"output_guardrail": {"enabled": False}}},
        )
        is True
    )

    # Pipeline with disabled config allows content through without error
    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=False))
    emitted = [chunk async for chunk in pipeline.process_token(unsafe_content)]
    emitted.extend([chunk async for chunk in pipeline.flush()])
    assert "".join(emitted) == unsafe_content


# ===========================================================================
# Comprehensive test coverage for agent.guardrails.pii
# ===========================================================================


@pytest.mark.parametrize(
    ("card_text", "should_match"),
    [
        ("4111-1111-1111-1111", True),
        ("4111 1111 1111 1111", True),
        ("4111111111111111", True),
        ("378282246310005", True),  # Amex Luhn valid
        ("Card ending in 1234", False),
        ("Flight UA 12345 confirmed", False),
        ("Order reference #987654", False),
    ],
)
def test_deterministic_pii_match_credit_card(card_text: str, should_match: bool) -> None:
    match = deterministic_pii_match(card_text)
    if should_match:
        assert match is not None, f"Expected credit card match in {card_text!r}"
    else:
        assert match is None, f"Expected no credit card match in {card_text!r}"


def test_deterministic_pii_match_credit_card_luhn_enforcement() -> None:
    from agent.sanitization.pii_scrubber import is_luhn_valid

    assert is_luhn_valid("4111-1111-1111-1111") is True
    assert is_luhn_valid("4111-1111-1111-1112") is False
    assert is_luhn_valid("0000-0000-0000-0001") is False


@pytest.mark.parametrize(
    ("phone_text", "should_match"),
    [
        ("+1 415 555 2671", True),
        ("415-555-2671", True),
        ("(415) 555-2671", True),
        ("+44 20 7946 0991", True),
        ("415.555.2671", True),
        ("1-800-555-0199", True),
        ("Departure at 2026-09-10 10:30", False),
        ("2026-09-10T10:30:00Z", False),
        ("2026-09-10 - 2026-09-15", False),
        ("123-45", False),  # too short
    ],
)
def test_deterministic_pii_match_phone(phone_text: str, should_match: bool) -> None:
    match = deterministic_pii_match(phone_text)
    if should_match:
        assert match is not None, f"Expected phone match in {phone_text!r}"
    else:
        assert match is None, f"Expected no phone match in {phone_text!r}"


@pytest.mark.parametrize(
    ("email_text", "should_match"),
    [
        ("user@example.com", True),
        ("first.last+flight@sub.domain.co.uk", True),
        ("passenger_123@airline-booking.org", True),
        ("Plain greeting text without email", False),
        ("@notanemail", False),
    ],
)
def test_deterministic_pii_match_email(email_text: str, should_match: bool) -> None:
    match = deterministic_pii_match(email_text)
    if should_match:
        assert match is not None, f"Expected email match in {email_text!r}"
    else:
        assert match is None, f"Expected no email match in {email_text!r}"


@pytest.mark.parametrize(
    "credential_text",
    [
        "api_key=sk-live-secretkeytoken",
        "api_key: super_secret_token",
        "access_token=ghp_tokensecretval",
        "access_token: tok_test_secret",
        "secret=production_master_secret",
        "secret: verysecretvalue",
        "bearer eyJhbGciOiJIUzI1NiIsInR5cCI",
    ],
)
def test_deterministic_pii_match_credentials(credential_text: str) -> None:
    # With credentials included (default)
    match = deterministic_pii_match(credential_text, include_credentials=True)
    assert match is not None, f"Expected credential match in {credential_text!r}"

    # With credentials excluded
    excluded_match = deterministic_pii_match(credential_text, include_credentials=False)
    assert excluded_match is None, (
        f"Expected no credential match when include_credentials=False in {credential_text!r}"
    )


@pytest.mark.parametrize(
    ("passport_text", "should_match"),
    [
        ("Passport A12345678", True),
        ("Passport Z9876543210", True),
        ("Doc C00123456 confirmed", True),
        ("Flight B777 confirmed", False),  # Only 3 digits, passport requires 7-10
        ("a12345678", False),  # lowercase not passport format
        ("AB12345678", False),  # two letters
    ],
)
def test_deterministic_pii_match_passport(passport_text: str, should_match: bool) -> None:
    match = deterministic_pii_match(passport_text)
    if should_match:
        assert match is not None, f"Expected passport match in {passport_text!r}"
    else:
        assert match is None, f"Expected no passport match in {passport_text!r}"


def test_deterministic_pii_match_safe_and_edge_content() -> None:
    assert deterministic_pii_match("") is None
    assert deterministic_pii_match("   ") is None
    assert deterministic_pii_match("Hello! How can I help you today?") is None
    assert deterministic_pii_match("Flight UA240 departing SFO gate 42.") is None
    assert deterministic_pii_match("12345") is None


@pytest.mark.asyncio
async def test_deterministic_pii_match_cross_token_buffering() -> None:
    # 1. Credit card split across chunks
    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    card_chunks = ["Your card ending in: ", "4111-", "1111-", "1111-", "1111", " was charged."]
    with pytest.raises(OutputGuardrailBlockedError) as exc_info:
        for chunk in card_chunks:
            async for _ in pipeline.process_token(chunk):
                pass
        async for _ in pipeline.flush():
            pass
    assert exc_info.value.layer == "deterministic"
    assert exc_info.value.rule == "PII detection"

    # 2. Email split across chunks
    pipeline_email = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    email_chunks = ["Send confirmation to ", "traveler", "@", "booking-system", ".com"]
    with pytest.raises(OutputGuardrailBlockedError):
        for chunk in email_chunks:
            async for _ in pipeline_email.process_token(chunk):
                pass
        async for _ in pipeline_email.flush():
            pass

    # 3. Phone split across chunks
    pipeline_phone = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    phone_chunks = ["Call agent at ", "+1 ", "415", "-555-", "2671"]
    with pytest.raises(OutputGuardrailBlockedError):
        for chunk in phone_chunks:
            async for _ in pipeline_phone.process_token(chunk):
                pass
        async for _ in pipeline_phone.flush():
            pass

    # 4. Credential split across chunks
    pipeline_cred = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    cred_chunks = ["Internal auth: ", "bearer ", "sec_token_99999"]
    with pytest.raises(OutputGuardrailBlockedError):
        for chunk in cred_chunks:
            async for _ in pipeline_cred.process_token(chunk):
                pass
        async for _ in pipeline_cred.flush():
            pass

    # 5. Passport split across chunks
    pipeline_pass = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    pass_chunks = ["Passenger document: ", "A", "12345678"]
    with pytest.raises(OutputGuardrailBlockedError):
        for chunk in pass_chunks:
            async for _ in pipeline_pass.process_token(chunk):
                pass
        async for _ in pipeline_pass.flush():
            pass


def test_is_output_guardrail_disabled_all_five_shapes() -> None:
    # Shape 1: Top-level object .enabled = False
    assert _is_output_guardrail_disabled(SimpleNamespace(enabled=False)) is True
    assert _is_output_guardrail_disabled(SimpleNamespace(enabled=True)) is False

    # Shape 2: Nested object .output_guardrail.enabled = False
    assert (
        _is_output_guardrail_disabled(
            SimpleNamespace(output_guardrail=SimpleNamespace(enabled=False))
        )
        is True
    )
    assert (
        _is_output_guardrail_disabled(
            SimpleNamespace(output_guardrail=SimpleNamespace(enabled=True))
        )
        is False
    )

    # Shape 3: Mapping {"enabled": False}
    assert _is_output_guardrail_disabled({"enabled": False}) is True
    assert _is_output_guardrail_disabled({"enabled": True}) is False

    # Shape 4: Mapping {"output_guardrail": {"enabled": False}}
    assert _is_output_guardrail_disabled({"output_guardrail": {"enabled": False}}) is True
    assert (
        _is_output_guardrail_disabled({"output_guardrail": SimpleNamespace(enabled=False)}) is True
    )
    assert _is_output_guardrail_disabled({"output_guardrail": {"enabled": True}}) is False

    # Shape 5: Mapping {"configurable": {"enabled": False}} or {"configurable": {"output_guardrail": ...}}
    assert _is_output_guardrail_disabled({"configurable": {"enabled": False}}) is True
    assert (
        _is_output_guardrail_disabled({"configurable": {"output_guardrail": {"enabled": False}}})
        is True
    )
    assert (
        _is_output_guardrail_disabled(
            {"configurable": {"output_guardrail": SimpleNamespace(enabled=False)}}
        )
        is True
    )
    assert _is_output_guardrail_disabled({"configurable": {"enabled": True}}) is False
    assert (
        _is_output_guardrail_disabled({"configurable": {"output_guardrail": {"enabled": True}}})
        is False
    )

    # Defaults / edge cases
    assert _is_output_guardrail_disabled(None) is False
    assert _is_output_guardrail_disabled({}) is False
    assert _is_output_guardrail_disabled(SimpleNamespace()) is False
    assert _is_output_guardrail_disabled("non-mapping-or-object") is False
    assert _is_output_guardrail_disabled(12345) is False


@pytest.mark.asyncio
async def test_approved_model_content_filtering_and_non_string() -> None:
    assert await approved_model_content("Your flight to JFK is confirmed.") is True
    assert await approved_model_content("Departure: 2026-09-10 10:30.") is True

    assert await approved_model_content("Card 4111-1111-1111-1111") is False
    assert await approved_model_content("Call +1 415 555 2671") is False
    assert await approved_model_content("Contact traveler@airline.com") is False
    assert await approved_model_content("Key api_key=secret123") is False
    assert await approved_model_content("Passport A12345678") is False

    assert await approved_model_content(None) is False
    assert await approved_model_content(123) is False
    assert await approved_model_content(45.67) is False
    assert await approved_model_content(["Safe list"]) is False
    assert await approved_model_content({"message": "Safe dict"}) is False
    assert await approved_model_content(b"Safe bytes") is False


@pytest.mark.asyncio
async def test_approved_model_content_disabled_passthrough() -> None:
    unsafe_content = "Card 4111-1111-1111-1111 and phone +1 415 555 2671"

    assert await approved_model_content(unsafe_content, SimpleNamespace(enabled=False)) is True
    assert (
        await approved_model_content(
            unsafe_content,
            SimpleNamespace(output_guardrail=SimpleNamespace(enabled=False)),
        )
        is True
    )
    assert await approved_model_content(unsafe_content, {"enabled": False}) is True
    assert (
        await approved_model_content(unsafe_content, {"output_guardrail": {"enabled": False}})
        is True
    )
    assert (
        await approved_model_content(
            unsafe_content,
            {"configurable": {"output_guardrail": {"enabled": False}}},
        )
        is True
    )

    # Disabled configs also pass non-string content
    assert await approved_model_content(None, {"enabled": False}) is True
    assert await approved_model_content(12345, SimpleNamespace(enabled=False)) is True
    assert await approved_model_content({"data": "payload"}, {"enabled": False}) is True


@pytest.mark.asyncio
async def test_pipeline_approved_prefix_extraction_on_block() -> None:
    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    prefix = "Booking confirmed for Jane Doe. Your flight is confirmed. "
    unsafe_suffix = "4111-1111-1111-1111 is your card."
    full_text = prefix + unsafe_suffix

    with pytest.raises(OutputGuardrailBlockedError) as exc_info:
        async for _ in pipeline.process_token(full_text):
            pass

    # Approved prefix prior to the match must be preserved in partial_response
    assert exc_info.value.partial_response == prefix
    assert exc_info.value.layer == "deterministic"
    assert exc_info.value.rule == "PII detection"


def test_ast_single_definition_and_no_circular_dependencies() -> None:
    """Verify exactly one definition exists across guardrails and no circular imports."""
    guardrails_dir = Path(__file__).resolve().parent.parent / "src" / "agent" / "guardrails"
    assert guardrails_dir.is_dir(), f"Expected directory {guardrails_dir} to exist"

    target_functions = {
        "deterministic_pii_match",
        "_is_output_guardrail_disabled",
        "approved_model_content",
    }
    definitions: dict[str, list[str]] = {fn: [] for fn in target_functions}

    for py_file in guardrails_dir.glob("*.py"):
        tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name in target_functions:
                    definitions[node.name].append(py_file.name)

    for fn_name, files in definitions.items():
        assert len(files) == 1, (
            f"Expected exactly one definition of '{fn_name}', but found in: {files}"
        )
        assert files[0] in ("pii.py", "output_pipeline.py"), (
            f"'{fn_name}' defined in unexpected file: {files[0]}"
        )

    # If pii.py exists, verify it does not import output_pipeline (acyclic dependency)
    pii_path = guardrails_dir / "pii.py"
    if pii_path.exists():
        pii_tree = ast.parse(pii_path.read_text(encoding="utf-8"), filename=str(pii_path))
        for node in ast.walk(pii_tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert "output_pipeline" not in alias.name, (
                        f"Circular dependency: pii.py imports {alias.name}"
                    )
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                assert "output_pipeline" not in module, (
                    f"Circular dependency: pii.py imports from {module}"
                )

    # Verify importing output_pipeline does not raise circular import errors
    importlib.invalidate_caches()
    importlib.import_module("agent.guardrails.output_pipeline")
