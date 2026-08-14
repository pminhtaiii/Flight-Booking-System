import json
import re
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from agent.models.events import HandoffEvent, DisplayInfo
from agent.sanitization.pii_scrubber import scrub_pii, detect_pii
from agent.observability.chat_observability import ChatTelemetry, TelemetryPrivacyError
from agent.tools.search_flights import project_snapshot_results, _SAFE_LLM_FIELDS
from agent.models.snapshot import TrustedSearchSnapshot

SEEDED_PRIVACY_CORPUS = [
    "chk_handoff_v1_secret_credential_12345",
    "token_hash_abc123def456",
    "local_offer_id_xyz987",
    "duffel_offer_id_duff_123",
    "booking_db_id_uuid_000",
    "PNR123456",
    "pnr_ABCDEF",
    "passenger_john_doe",
    "traveller.john@example.com",
    "+1 555-123-4567",
    "P12345678",
    "4111111111111111",
    "plaintext customer chat secret message",
]

def test_pii_scrubber_redacts_seeded_corpus():
    """Verify that pii_scrubber detects and scrubs email, phone, passport, and card."""
    sample_text = (
        "Contact me at traveller.john@example.com or +1 555-123-4567. "
        "My passport is P12345678 and card is 4111 1111 1111 1111."
    )
    assert detect_pii(sample_text) is True
    scrubbed = scrub_pii(sample_text)
    assert "traveller.john@example.com" not in scrubbed
    assert "+1 555-123-4567" not in scrubbed
    assert "P12345678" not in scrubbed
    assert "4111 1111 1111 1111" not in scrubbed
    assert "[EMAIL REDACTED]" in scrubbed
    assert "[PHONE REDACTED]" in scrubbed
    assert "[PASSPORT REDACTED]" in scrubbed
    assert "[CARD REDACTED]" in scrubbed

def test_safe_llm_fields_excludes_identifiers():
    """Verify _SAFE_LLM_FIELDS does not contain local offer IDs, Duffel offer IDs, or database IDs."""
    forbidden = {"flightOfferId", "duffelOfferId", "offerId", "bookingId", "id", "userId", "sessionId"}
    for f in _SAFE_LLM_FIELDS:
        assert f not in forbidden

def test_project_snapshot_results_excludes_identifiers():
    """Verify project_snapshot_results never returns offer IDs or provider IDs to the browser."""
    snapshot = TrustedSearchSnapshot.model_validate({
        "schemaVersion": 1,
        "snapshotVersion": 1,
        "userId": "usr_123",
        "sessionId": "ses_456",
        "createdAt": "2026-09-20T00:00:00Z",
        "expiresAt": "2026-09-20T01:00:00Z",
        "selectionAttestation": "sel_v1_mock",
        "fingerprint": "mock_fp",
        "results": [
            {
                "offerIndex": 1,
                "flightOfferId": "local-uuid-1234",
                "duffelOfferId": "duffel-offer-5678",
                "airline": "VN",
                "origin": "SGN",
                "destination": "HAN",
                "departureAt": "2026-09-20T08:00:00Z",
                "arrivalAt": "2026-09-20T10:00:00Z",
                "price": "120.00",
                "currency": "USD",
            }
        ]
    })
    projected = project_snapshot_results(snapshot)
    assert len(projected) == 1
    item = projected[0]
    assert "flightOfferId" not in item
    assert "duffelOfferId" not in item
    assert "local-uuid-1234" not in json.dumps(item)
    assert "duffel-offer-5678" not in json.dumps(item)

def test_action_handoff_event_schema_strictly_forbids_private_fields():
    """Verify HandoffEvent schema allows only strict allowlisted display fields."""
    display = DisplayInfo(
        airline="VN",
        origin="SGN",
        destination="NRT",
        departureAt="2026-09-20T02:00:00Z",
        arrivalAt="2026-09-20T08:30:00Z",
        price="420.00",
        currency="USD",
    )
    event = HandoffEvent(
        version=1,
        action="begin_checkout",
        handoffToken="chk_handoff_v1_opaque_token_value",
        expiresAt="2026-09-20T03:00:00Z",
        display=display,
    )
    event_json = event.model_dump_json()
    assert "chk_handoff_v1_opaque_token_value" in event_json
    assert "url" not in event_json
    assert "offerId" not in event_json
    assert "flightOfferId" not in event_json
    assert "duffelOfferId" not in event_json
    assert "sessionId" not in event_json
    assert "userId" not in event_json

    # Unknown fields must fail validation
    with pytest.raises(Exception):
        HandoffEvent(
            version=1,
            action="begin_checkout",
            handoffToken="chk_handoff_v1_test",
            expiresAt="2026-09-20T03:00:00Z",
            display=display,
            url="https://example.test/checkout",
        )

def test_chat_telemetry_strictly_rejects_privacy_corpus():
    """Verify telemetry rejects each value in the seeded privacy corpus."""
    telemetry = ChatTelemetry()
    for forbidden_val in SEEDED_PRIVACY_CORPUS:
        with pytest.raises(TelemetryPrivacyError, match="contains protected data"):
            telemetry.emit(
                "tool_call",
                status="failed",
                fields={"outcome": forbidden_val},
            )
