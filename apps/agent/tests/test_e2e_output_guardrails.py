"""End-to-end deterministic output-boundary regression coverage.

2026-09-06 user-approved replacement for output NeMo integration tests.
"""

from types import SimpleNamespace

import pytest

from agent.guardrails.output_pipeline import OutputGuardrailBlockedError, OutputGuardrailPipeline


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
    from agent.guardrails.output_pipeline import (
        _PHONE,
        approved_model_content,
        deterministic_pii_match,
    )

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
    from agent.guardrails.output_pipeline import deterministic_pii_match

    text = "Your flight is on 2026-09-10 10:30. Call support at +1 415 555 2671."
    match = deterministic_pii_match(text)
    assert match is not None
    assert "+1 415 555 2671" in match.group(0)

    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True))
    with pytest.raises(OutputGuardrailBlockedError):
        async for _ in pipeline.process_token(text):
            pass


@pytest.mark.asyncio
async def test_approved_model_content_and_pipeline_respect_disabled_config() -> None:
    from agent.guardrails.output_pipeline import approved_model_content

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
