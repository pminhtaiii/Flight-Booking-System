"""Lifecycle operations and safety projections for trusted search snapshots."""

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from agent.trusted_search_snapshot.models import (
    AttestedSearchEnvelope,
    ResolvedOfferSelection,
    SafeFlightResult,
    SafeSearchResult,
    SnapshotOwner,
    TrustedSearchSnapshot,
)
from agent.trusted_search_snapshot.repository import TrustedSnapshotRepository


class TrustedSearchSnapshotLifecycle:
    """Coordinates lifecycle, selection resolution, and safe projections."""

    def __init__(self, repository: TrustedSnapshotRepository, max_ttl: int = 3600) -> None:
        """Create a lifecycle with one TTL cap for every snapshot it persists."""

        if isinstance(max_ttl, bool) or not isinstance(max_ttl, int) or max_ttl <= 0:
            raise ValueError("max_ttl must be a positive integer")
        self.repository = repository
        self.max_ttl = max_ttl

    async def next_version(self, owner: SnapshotOwner) -> int:
        """Allocate an owner-scoped version."""
        return await self.repository.next_version(owner)

    async def load_active(self, owner: SnapshotOwner) -> TrustedSearchSnapshot | None:
        """Load the active, unexpired snapshot for the owner."""
        return await self.repository.get_snapshot(owner.user_id, owner.chat_session_id)

    async def create_or_replace(
        self,
        owner: SnapshotOwner,
        envelope: AttestedSearchEnvelope,
    ) -> TrustedSearchSnapshot:
        """Create and persist an owner-scoped search snapshot."""
        now = datetime.now(timezone.utc)
        payload = envelope.model_dump()
        snapshot = TrustedSearchSnapshot(
            userId=owner.user_id,
            sessionId=owner.chat_session_id,
            createdAt=now,
            **payload,
        )
        saved = await self.repository.save_snapshot(snapshot, max_ttl=self.max_ttl)
        if not saved:
            raise ValueError("Failed to persist trusted search snapshot")
        return snapshot

    async def select(
        self, snapshot: TrustedSearchSnapshot, offer_index: int
    ) -> ResolvedOfferSelection:
        """Resolve a 1-based offer index against the active snapshot."""
        if type(offer_index) is not int or isinstance(offer_index, bool):
            raise ValueError("offer_index must be an integer")
        if snapshot.expiresAt <= datetime.now(timezone.utc):
            raise ValueError("Search snapshot has expired")

        matching = next(
            (result for result in snapshot.results if result.offerIndex == offer_index),
            None,
        )
        if matching is None:
            raise ValueError(f"Offer index {offer_index} is out of bounds")

        return ResolvedOfferSelection(
            offer_index=offer_index,
            offer=matching,
            selection_attestation=snapshot.selectionAttestation,
            expires_at=snapshot.expiresAt,
        )

    async def delete(self, owner: SnapshotOwner) -> None:
        """Remove the snapshot and version state scoped to ``owner``."""

        await self.repository.delete_snapshot(owner.user_id, owner.chat_session_id)

    def project_for_llm(self, snapshot: TrustedSearchSnapshot) -> list[SafeSearchResult]:
        """Project snapshot results into PII/secret-safe LLM view."""
        return [
            SafeSearchResult(
                index=result.offerIndex,
                airline=result.airline,
                origin=result.origin,
                destination=result.destination,
                departure_at=result.departureAt,
                arrival_at=result.arrivalAt,
                price=result.price,
                currency=result.currency,
            )
            for result in snapshot.results
        ]

    def project_for_browser(self, snapshot: TrustedSearchSnapshot) -> list[SafeFlightResult]:
        """Project snapshot results into PII/secret-safe browser SSE view."""
        return [
            SafeFlightResult(
                index=result.offerIndex,
                airline=result.airline,
                origin=result.origin,
                destination=result.destination,
                departureAt=result.departureAt,
                arrivalAt=result.arrivalAt,
                price=result.price,
                currency=result.currency,
            )
            for result in snapshot.results
        ]

    @classmethod
    def normalize_graph_state(cls, state: dict[str, Any]) -> dict[str, Any]:
        """Normalize legacy graph state keys to canonical keys."""
        key_aliases = {
            "snapshot": "trusted_snapshot",
            "version": "snapshotVersion",
            "attestation": "selectionAttestation",
            "offers": "results",
        }
        return cls._normalize_value(deepcopy(state), key_aliases)

    @classmethod
    def _normalize_value(cls, value: Any, key_aliases: dict[str, str]) -> Any:
        """Copy and normalize aliases recursively while preserving canonical values."""

        if isinstance(value, list):
            return [cls._normalize_value(item, key_aliases) for item in value]
        if not isinstance(value, dict):
            return value

        normalized = {
            key: cls._normalize_value(item, key_aliases)
            for key, item in value.items()
            if key not in key_aliases
        }
        for legacy_key, canonical_key in key_aliases.items():
            if canonical_key not in normalized and legacy_key in value:
                normalized[canonical_key] = cls._normalize_value(value[legacy_key], key_aliases)
        return normalized
