from datetime import datetime, timedelta, timezone
from typing import Any, Dict

import pytest
from pydantic import ValidationError

from agent.models.snapshot import TrustedSearchResult, TrustedSearchSnapshot
from agent.repositories.trusted_snapshot_repository import TrustedSnapshotRepository
from agent.tools.search_flights import project_snapshot_results


class FakeAsyncRedis:
    """In-memory async Redis double for testing snapshot persistence."""

    def __init__(self):
        self.store: Dict[str, str] = {}
        self.ttls: Dict[str, int] = {}

    async def set(self, key: str, value: str, ex: int | None = None):
        self.store[key] = value
        if ex is not None:
            self.ttls[key] = ex

    async def get(self, key: str):
        return self.store.get(key)

    async def delete(self, key: str):
        self.store.pop(key, None)
        self.ttls.pop(key, None)


def _make_valid_result_payload(offer_index: int = 1) -> Dict[str, Any]:
    return {
        "offerIndex": offer_index,
        "flightOfferId": f"flight_offer_{offer_index}",
        "duffelOfferId": f"off_duffel_{offer_index}_secret",
        "airline": "Vietnam Airlines",
        "origin": "SGN",
        "destination": "HAN",
        "departureAt": datetime(2026, 9, 1, 8, 0, 0, tzinfo=timezone.utc),
        "arrivalAt": datetime(2026, 9, 1, 10, 0, 0, tzinfo=timezone.utc),
        "price": "120.00",
        "currency": "USD",
    }


def _make_valid_snapshot_payload(**overrides) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    base = {
        "schemaVersion": 1,
        "snapshotVersion": 1,
        "userId": "user_characterization_123",
        "sessionId": "session_characterization_456",
        "createdAt": now,
        "expiresAt": now + timedelta(minutes=15),
        "fingerprint": "hmac_sha256_characterization_fingerprint",
        "selectionAttestation": "sel_attest_sig_xyz789",
        "results": [_make_valid_result_payload(1), _make_valid_result_payload(2)],
    }
    base.update(overrides)
    return base


# =========================================================================
# 1. Pydantic Model Characterization Tests
# =========================================================================


def test_trusted_search_result_validates_fields_and_forbids_extra():
    payload = _make_valid_result_payload(1)
    result = TrustedSearchResult.model_validate(payload)
    assert result.offerIndex == 1
    assert result.flightOfferId == "flight_offer_1"

    # Forbids extra fields
    extra_payload = _make_valid_result_payload(1)
    extra_payload["unauthorizedField"] = "attack"
    with pytest.raises(ValidationError):
        TrustedSearchResult.model_validate(extra_payload)


def test_trusted_snapshot_validates_contiguous_1_indexed_results():
    # Valid: 1, 2, 3
    valid_payload = _make_valid_snapshot_payload(
        results=[
            _make_valid_result_payload(1),
            _make_valid_result_payload(2),
            _make_valid_result_payload(3),
        ]
    )
    snapshot = TrustedSearchSnapshot.model_validate(valid_payload)
    assert len(snapshot.results) == 3
    assert [r.offerIndex for r in snapshot.results] == [1, 2, 3]


def test_trusted_snapshot_rejects_zero_indexed_results():
    payload = _make_valid_snapshot_payload(
        results=[
            _make_valid_result_payload(0),
            _make_valid_result_payload(1),
        ]
    )
    with pytest.raises(ValidationError) as exc_info:
        TrustedSearchSnapshot.model_validate(payload)
    assert "offerIndex" in str(exc_info.value) or "greater than 0" in str(exc_info.value)


def test_trusted_snapshot_rejects_non_contiguous_or_unordered_indexes():
    # Non-contiguous: 1, 3
    non_contiguous = _make_valid_snapshot_payload(
        results=[
            _make_valid_result_payload(1),
            _make_valid_result_payload(3),
        ]
    )
    with pytest.raises(ValidationError) as exc_info:
        TrustedSearchSnapshot.model_validate(non_contiguous)
    assert "Result indexes must be unique and contiguous from 1" in str(exc_info.value)

    # Starting from 2: 2, 3
    start_at_two = _make_valid_snapshot_payload(
        results=[
            _make_valid_result_payload(2),
            _make_valid_result_payload(3),
        ]
    )
    with pytest.raises(ValidationError) as exc_info:
        TrustedSearchSnapshot.model_validate(start_at_two)
    assert "Result indexes must be unique and contiguous from 1" in str(exc_info.value)

    # Reversed: 2, 1
    reversed_indexes = _make_valid_snapshot_payload(
        results=[
            _make_valid_result_payload(2),
            _make_valid_result_payload(1),
        ]
    )
    with pytest.raises(ValidationError) as exc_info:
        TrustedSearchSnapshot.model_validate(reversed_indexes)
    assert "Result indexes must be unique and contiguous from 1" in str(exc_info.value)


def test_trusted_snapshot_forbids_extra_fields():
    # Extra field on top-level snapshot
    extra_snapshot = _make_valid_snapshot_payload(unexpected_field="disallowed")
    with pytest.raises(ValidationError) as exc_info:
        TrustedSearchSnapshot.model_validate(extra_snapshot)
    assert "Extra inputs are not permitted" in str(exc_info.value)

    # Extra field inside result item
    res_with_extra = _make_valid_result_payload(1)
    res_with_extra["hackerInjectedField"] = "attack"
    extra_result = _make_valid_snapshot_payload(results=[res_with_extra])
    with pytest.raises(ValidationError) as exc_info:
        TrustedSearchSnapshot.model_validate(extra_result)
    assert "Extra inputs are not permitted" in str(exc_info.value)


def test_trusted_snapshot_validates_required_fields():
    required_fields = [
        "schemaVersion",
        "snapshotVersion",
        "userId",
        "sessionId",
        "createdAt",
        "expiresAt",
        "fingerprint",
        "selectionAttestation",
        "results",
    ]
    for field in required_fields:
        payload = _make_valid_snapshot_payload()
        del payload[field]
        with pytest.raises(ValidationError) as exc_info:
            TrustedSearchSnapshot.model_validate(payload)
        assert field in str(exc_info.value)


def test_trusted_snapshot_validates_results_length_bounds():
    # Empty results rejected
    empty_payload = _make_valid_snapshot_payload(results=[])
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(empty_payload)

    # More than 5 results rejected
    six_results = [_make_valid_result_payload(i) for i in range(1, 7)]
    over_limit_payload = _make_valid_snapshot_payload(results=six_results)
    with pytest.raises(ValidationError):
        TrustedSearchSnapshot.model_validate(over_limit_payload)


# =========================================================================
# 2. TrustedSnapshotRepository Characterization Tests
# =========================================================================


@pytest.mark.asyncio
async def test_repository_save_snapshot_calculates_ttl_and_stores_json():
    fake_redis = FakeAsyncRedis()
    repo = TrustedSnapshotRepository(fake_redis)

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=900)
    snapshot = TrustedSearchSnapshot.model_validate(
        _make_valid_snapshot_payload(
            userId="user_1",
            sessionId="session_1",
            createdAt=now,
            expiresAt=expires_at,
        )
    )

    await repo.save_snapshot(snapshot, max_ttl=3600)

    key = "chat:snapshot:user_1:session_1"
    stored_data = await fake_redis.get(key)
    assert stored_data is not None
    assert "user_1" in stored_data
    assert "session_1" in stored_data

    stored_ttl = fake_redis.ttls.get(key)
    assert stored_ttl is not None
    assert 890 <= stored_ttl <= 900


@pytest.mark.asyncio
async def test_repository_save_snapshot_skips_already_expired():
    fake_redis = FakeAsyncRedis()
    repo = TrustedSnapshotRepository(fake_redis)

    now = datetime.now(timezone.utc)
    expired_at = now - timedelta(seconds=10)
    snapshot = TrustedSearchSnapshot.model_validate(
        _make_valid_snapshot_payload(
            userId="user_expired",
            sessionId="session_expired",
            createdAt=now - timedelta(seconds=60),
            expiresAt=expired_at,
        )
    )

    await repo.save_snapshot(snapshot)
    key = "chat:snapshot:user_expired:session_expired"
    assert await fake_redis.get(key) is None


@pytest.mark.asyncio
async def test_repository_get_snapshot_validates_owner_and_session_match():
    fake_redis = FakeAsyncRedis()
    repo = TrustedSnapshotRepository(fake_redis)

    snapshot = TrustedSearchSnapshot.model_validate(
        _make_valid_snapshot_payload(userId="user_alice", sessionId="session_alice")
    )
    await repo.save_snapshot(snapshot)

    # Exact match returns model
    loaded = await repo.get_snapshot("user_alice", "session_alice")
    assert loaded is not None
    assert loaded.userId == "user_alice"
    assert loaded.sessionId == "session_alice"
    assert len(loaded.results) == 2

    # Different user -> returns None
    wrong_user = await repo.get_snapshot("user_bob", "session_alice")
    assert wrong_user is None

    # Different session -> returns None
    wrong_session = await repo.get_snapshot("user_alice", "session_bob")
    assert wrong_session is None

    # Missing key -> returns None
    missing = await repo.get_snapshot("user_nonexistent", "session_nonexistent")
    assert missing is None


@pytest.mark.asyncio
async def test_repository_get_snapshot_returns_none_on_corrupted_json():
    fake_redis = FakeAsyncRedis()
    repo = TrustedSnapshotRepository(fake_redis)

    key = "chat:snapshot:user_corrupt:session_corrupt"
    await fake_redis.set(key, "{ invalid json data ")

    loaded = await repo.get_snapshot("user_corrupt", "session_corrupt")
    assert loaded is None


@pytest.mark.asyncio
async def test_repository_delete_snapshot_removes_key():
    fake_redis = FakeAsyncRedis()
    repo = TrustedSnapshotRepository(fake_redis)

    snapshot = TrustedSearchSnapshot.model_validate(
        _make_valid_snapshot_payload(userId="user_del", sessionId="session_del")
    )
    await repo.save_snapshot(snapshot)

    assert await repo.get_snapshot("user_del", "session_del") is not None

    await repo.delete_snapshot("user_del", "session_del")
    assert await repo.get_snapshot("user_del", "session_del") is None
    assert await fake_redis.get("chat:snapshot:user_del:session_del") is None


@pytest.mark.asyncio
async def test_repository_atomic_replacement_overwrites_previous_snapshot():
    fake_redis = FakeAsyncRedis()
    repo = TrustedSnapshotRepository(fake_redis)

    snap_v1 = TrustedSearchSnapshot.model_validate(
        _make_valid_snapshot_payload(
            snapshotVersion=1,
            userId="user_replace",
            sessionId="session_replace",
            results=[_make_valid_result_payload(1)],
        )
    )
    await repo.save_snapshot(snap_v1)
    loaded_v1 = await repo.get_snapshot("user_replace", "session_replace")
    assert loaded_v1 is not None
    assert loaded_v1.snapshotVersion == 1
    assert len(loaded_v1.results) == 1

    snap_v2 = TrustedSearchSnapshot.model_validate(
        _make_valid_snapshot_payload(
            snapshotVersion=2,
            userId="user_replace",
            sessionId="session_replace",
            results=[_make_valid_result_payload(1), _make_valid_result_payload(2)],
        )
    )
    await repo.save_snapshot(snap_v2)
    loaded_v2 = await repo.get_snapshot("user_replace", "session_replace")
    assert loaded_v2 is not None
    assert loaded_v2.snapshotVersion == 2
    assert len(loaded_v2.results) == 2


# =========================================================================
# 3. PII-Free Projection Characterization Tests
# =========================================================================


def test_project_snapshot_results_excludes_all_pii_and_internal_ids():
    snapshot = TrustedSearchSnapshot.model_validate(
        _make_valid_snapshot_payload(
            userId="confidential_user_id_999",
            sessionId="confidential_session_id_888",
            fingerprint="confidential_hmac_fingerprint_777",
            selectionAttestation="confidential_attestation_signature_666",
            results=[
                {
                    "offerIndex": 1,
                    "flightOfferId": "raw_flight_offer_id_111",
                    "duffelOfferId": "secret_duffel_offer_id_222",
                    "airline": "Vietnam Airlines",
                    "origin": "SGN",
                    "destination": "HAN",
                    "departureAt": datetime(2026, 9, 1, 8, 30, 0, tzinfo=timezone.utc),
                    "arrivalAt": datetime(2026, 9, 1, 10, 30, 0, tzinfo=timezone.utc),
                    "price": "150.00",
                    "currency": "USD",
                }
            ],
        )
    )

    projected = project_snapshot_results(snapshot)

    assert isinstance(projected, list)
    assert len(projected) == 1
    item = projected[0]

    # Exact expected keys
    expected_keys = {
        "index",
        "airline",
        "origin",
        "destination",
        "departureAt",
        "arrivalAt",
        "price",
        "currency",
    }
    assert set(item.keys()) == expected_keys

    # Confirm sensitive / internal fields are strictly excluded
    forbidden_values = [
        "confidential_user_id_999",
        "confidential_session_id_888",
        "confidential_hmac_fingerprint_777",
        "confidential_attestation_signature_666",
        "raw_flight_offer_id_111",
        "secret_duffel_offer_id_222",
    ]
    for key, val in item.items():
        assert str(val) not in forbidden_values
        assert "duffel" not in key.lower()
        assert "attest" not in key.lower()
        assert "fingerprint" not in key.lower()
        assert "flightOfferId" not in key
        assert "userId" not in key

    assert item["index"] == 1
    assert item["airline"] == "Vietnam Airlines"
    assert item["origin"] == "SGN"
    assert item["destination"] == "HAN"
    assert item["price"] == "150.00"
    assert item["currency"] == "USD"
    assert item["departureAt"] == "2026-09-01T08:30:00+00:00"
    assert item["arrivalAt"] == "2026-09-01T10:30:00+00:00"
