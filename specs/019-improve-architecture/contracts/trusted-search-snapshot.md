# Trusted Search Snapshot Lifecycle Contract

```python
class TrustedSearchSnapshotLifecycle:
    async def next_version(self, owner: SnapshotOwner) -> int: ...
    async def create_or_replace(
        self,
        owner: SnapshotOwner,
        envelope: AttestedSearchEnvelope,
    ) -> TrustedSearchSnapshot: ...
    async def load_active(
        self,
        owner: SnapshotOwner,
    ) -> TrustedSearchSnapshot | None: ...
    async def select(
        self,
        snapshot: TrustedSearchSnapshot,
        offer_index: int,
    ) -> ResolvedOfferSelection: ...
    def project_for_llm(
        self,
        snapshot: TrustedSearchSnapshot,
    ) -> list[SafeSearchResult]: ...
    def project_for_browser(
        self,
        snapshot: TrustedSearchSnapshot,
    ) -> list[SafeFlightResult]: ...
    async def delete(self, owner: SnapshotOwner) -> None: ...
```

## Guarantees

- Snapshot owner, version, expiry, contiguous one-based indices, envelope shape, and selection consistency are validated centrally.
- Replacement is atomic and cannot overwrite a newer version with an older one.
- Redis TTL never exceeds offer freshness or the established cap.
- LLM/browser projections contain no local offer IDs, Duffel IDs, attestation, fingerprint, owner, or session identity.
- `ResolvedOfferSelection` is internal and non-serializable to those projections.
- Missing security fields fail closed outside explicit test fixtures.

## Boundary rule

Legacy aliases are normalized once when importing old graph state. All lifecycle callers use canonical models. NestJS remains the sole cryptographic verifier and handoff-token issuer.
