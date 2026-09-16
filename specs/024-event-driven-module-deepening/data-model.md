# Data model

## Persistent changes

| Entity | Change | Invariant |
|---|---|---|
| Booking / `bookings` | `version Int @default(1)`, nonnull | Atomic increment for each applied business-state or itinerary mutation; no bump on rejected/no-op/replay or listed bookkeeping writes |
| BookingAgentProjection / `booking_agent_projections` | `sourceVersion Int @default(0)`, nonnull | Represents the exact hydrated source snapshot; writes replace only a lower version |
| Existing IdempotencyKey | No planned schema addition | Preserve request binding, owner/lease fencing, existing JSON checkpoint data and replay response; terminal checkpoint plus replay completion use one fenced atomic update |
| Payment, Refund, CancellationRefundObligation, LedgerEntry | No schema change | Existing locked synchronous financial transactions and ledger uniqueness remain |

Do not rename the projection table or its private booking FK. Preserve all agent references and current cascade deletion. Integer versions are independent of ItineraryRevision.version: itinerary revision changes advance Booking.version, but booking cancellation/refund can advance without a new itinerary revision. No per-event table, outbox, queue, dead-letter store or saga framework.

## Version migration

Add columns with Booking default 1 and projection default 0. Historical projection rows deliberately start stale even if their old contents look current. Existing bookings with no projection stay eligible when extractable data exists. Do not initialize historical projection versions to booking versions without rebuilding, since prior refund changes could already be missing.

Stop legacy API writers before the one-step nonproduction cutover. Apply additive migration, deploy complete event producers/listener/reconciliation, and observe a full repair traversal. Keep columns during application rollback. Legacy application may write without advancing Booking.version; before reactivation, stop writers and reset projection.sourceVersion to 0 in a reviewed maintenance operation, then reconcile. This resets only derived freshness markers, never booking/payment/refund state or references.

## Source mutation semantics

The complete mutation and exclusion table is in [booking-events.md](contracts/booking-events.md). Creation initializes version 1. Each successful transition atomically increments alongside state. Changes bundled into one supplier revision transaction constitute one aggregate mutation, including revision pointer and timing fields. Cancellation state claims, refund success/failure/manual retry and disruption acknowledge/accept are included. Version is not an optimistic command lock; existing guards/locks keep their semantics.

FAILED remains protected from ordinary retries/stale mutation, while existing authoritative captured-payment-plus-order confirmation can recover FAILED to CONFIRMED. Do not redefine it as universally immutable or relax authoritative evidence. Confirmed/completed/cancelled records remain protected from stale failure outcomes.

## Derived snapshot

Hydration obtains booking.version/status and latest itinerary revision/ordered segments in one consistent snapshot. Extraction preserves current latest revision preference and flightSnapshot fallback, with explicit safe-field construction. The stored version comes from hydration, not event metadata. Concurrent repository upsert condition is `existing.sourceVersion < incoming.sourceVersion`; equal/older data cannot replace newer data. Reference is inserted once and remains unchanged on all updates, including insertion races.

If extraction cannot form a valid current safe projection, missing rows remain absent and existing rows remain unchanged/stale. FlightSnapshot fallback is allowed only when no authoritative itinerary revision exists; malformed/empty latest revisions fail visibly. Do not stamp the new version onto retained old itinerary fields. Persisting current sourceVersion asserts a complete usable derivation, not merely successful status lookup.

## Ephemeral data

Domain event contains only bookingId, eventId, sourceVersion and timestamp; it is API-internal and behavior-free. Lifecycle owns booking fact construction; outer transaction owner dispatches after commit. Settlement owns the separate refund.settled fact; projection listens only to booking transitions so settlement does not double-trigger it. See [event ownership contract](contracts/booking-events.md).

Transaction event collectors are scoped to one transaction attempt and discarded after rollback/flush. Hydration promise caches are scoped to one event processing cycle and released in finally. Neither is durable state or a booking-global cache.

## Drift query and bounds

Repository joins bookings to projections and selects every missing or lower-version projection in booking-ID order beyond an in-memory keyset cursor. Each minute considers at most 100 candidates with five concurrent repairs and no local overlapping pass. Cursor advances over skipped/failed rows and wraps at range end, preventing malformed rows from starving later bookings. Rows without snapshot/revision stay in that bounded scan and produce skipped/no-source-data telemetry. Reconciliation never writes canonical booking state. Backfill shares the guarded writer.

## Validation evidence required at implementation

Migration fixtures prove historical rows start 1/0, references survive, missing rows are discoverable and rollback/reactivation freshness reset works. Real database tests prove guarded writes cannot regress and a coherent hydrated version matches the selected itinerary. Reconciliation fixtures exceed 100 rows and include low-ID malformed rows, concurrent live updates and absent projections. Existing privacy/owner-scoped DTO tests must pass without exposing new internal version or event fields. No runtime checks have been executed by this planning artifact.
