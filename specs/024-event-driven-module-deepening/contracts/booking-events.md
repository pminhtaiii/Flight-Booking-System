# Booking events and projection contract

Planning contract for FR-006–FR-013. All paths below are under `apps/api/` unless qualified. These are internal facts; public HTTP/agent DTOs do not change.

## Passive envelope and owners

`domain-events/domain-event.base.ts` defines the behavior-free envelope `{ bookingId: string, eventId: string, sourceVersion: number, timestamp: Date }`. `sourceVersion` is the committed booking version produced by the mutation. Use this field consistently in logging; the source session's `aggregateVersion` example is an alias error. Generate an event ID once per successful mutation attempt. No passenger/provider data, hydration method, callback, Prisma client or aggregate instance belongs in an event.

`BookingLifecycleService` is the sole producer of booking facts, including delegated cancellation/refund/recovery state changes. `BookingStateModule` registers that service with Prisma and DomainEventsModule. Existing BookingLifecycleModule imports/re-exports BookingStateModule and retains BookingRecoveryService, Stripe, Duffel and refund dependencies. RefundSettlementModule imports BookingStateModule, never BookingLifecycleModule: the latter already imports settlement for recovery. Cancellation and disruption likewise depend on BookingStateModule. No new `forwardRef`.

| Event name | Meaning and producer |
|---|---|
| `booking.created` | Lifecycle created PROCESSING row; no event on idempotent replay |
| `booking.confirmed` | Lifecycle applied verified confirmation |
| `booking.failed` | Lifecycle applied an eligible failure |
| `booking.completed` | Lifecycle completed an eligible arrived booking |
| `booking.recovery.resolved` | Lifecycle applied a recovery outcome requested by RecoveryService; replaces confirm/fail event for that mutation |
| `booking.cancellation.pending` | Lifecycle acquired the cancellation business-state claim |
| `booking.cancelled` | Lifecycle finalized supplier cancellation into pending-refund/no-refund status |
| `booking.disruption.synced` | Lifecycle records committed supplier revision/timing mutation in the existing supplier transaction |
| `booking.disruption.acknowledged` | Lifecycle applies traveler acknowledgement |
| `booking.disruption.accepted` | Lifecycle applies traveler resolution |
| `booking.refund.updated` | Lifecycle changes booking status after settlement success/failure or manual retry |
| `refund.settled` | SettlementService produces a verified terminal refund fact, once on its existing nonreplay settlement branch |

The projection listener subscribes to **booking events only**. `refund.settled` remains a separate settlement-owned fact and has no projection subscription; its associated booking mutation produces `booking.refund.updated`. This deliberately resolves the historical catalog's double ownership: settlement knows financial facts, lifecycle knows booking changes, and a single booking transition causes one projection trigger. A successful refund with no booking-state change can produce `refund.settled` without a booking event/version bump. A refund with no linked booking produces no booking-envelope event; do not fabricate bookingId. Existing financial audit records remain authoritative. The exact terminal success/failure semantics come from settlement's existing verified-outcome branches, not from a new listener.

## Commit protocol

1. A standalone lifecycle operation owns a short Prisma transaction. A caller-owned operation receives explicit `{ tx, events }` context and never dispatches.
2. Preserve existing conditional status/claim guards and payment/refund lock ordering. When an eligible write changes business state, increment version atomically with that write and construct one event using the resulting version. A zero-count/rejected/replayed transition produces neither version increment nor event.
3. The outermost transaction returns its command result and collected events. Dispatch only after its promise resolves successfully. Discard all collected events on rollback. Every supplier transaction retry allocates a fresh collector.
4. Saga calls lifecycle with context; it never constructs booking events. Settlement/cancellation keep their current atomic financial/audit bundles. Recovery keeps direct Stripe/Duffel access and delegates only canonical mutation/event production.
5. Publisher invokes in-process EventEmitter2 and isolates dispatch errors. Listener catches its own async failures. Neither error may reject a committed command, trigger compensation, or alter the HTTP response.

CancellationService, SupplierSyncService, DisruptionService acknowledge/accept, RefundSettlementService, PaymentRefundService manual retry, BookingRecoveryService and the saga each own the postcommit publisher invocation for transactions they open. Their service tests must assert no publish while the transaction is unresolved, none after rollback, and one committed batch after resolution. Supplier retries discard earlier batches. If a caller receives an existing context instead, it returns collected facts to that context's outer owner and does not publish them itself.

Use one EventEmitterModule registration at AppModule. Listeners must be registered before commands are accepted; integration applications call initialization first. Events remain nondurable. A process crash after commit is repaired by reconciliation, not by replaying financial effects.

## Complete mutation inventory

Line references are research anchors at planning time; re-inventory before implementation.

| Existing source path | Mutation and integration requirement |
|---|---|
| `src/booking-lifecycle/booking-lifecycle.service.ts:47` | Creation starts version 1 and produces created after commit; repeated creation returns existing row without another fact |
| Same file, 113 / 144 / 281 | Confirm, fail and complete preserve their status/date guards; replace three projection calls with collected facts |
| `src/booking-lifecycle/booking-recovery.service.ts:175,231,277,306` | Four recovery fail/confirm branches call lifecycle with recovery semantics; replace four direct projection calls; preserve provider evidence and existing conditional PROCESSING guards |
| `src/cancellation/cancellation.service.ts:344` | CANCELLATION_PENDING acquisition/reacquisition: increment only actual business transition, not refreshing a stale claim already pending |
| Same file, 406 | Final cancellation plus obligation/disruption audit transaction delegates state mutation; dispatch after complete outer transaction; replace one projection call |
| `src/disruption/sync/supplier-sync.service.ts:482` | All created revisions, material or nonmaterial, advance version once within revision/timing transaction; lifecycle creates synced fact only after successful guarded mutation; active revision link belongs to same atomic change; replace one projection call |
| `src/disruption/api/disruption.service.ts:142,234` | Acknowledge/accept domain state advances version with guarded transaction; preserve idempotent already-applied responses |
| `src/refund-settlement/refund-settlement.service.ts:294,349` | Successful cumulative refund state and failure-needs-attention state delegate lifecycle inside existing locked financial transaction; no change means no booking event |
| `src/payment/payment-refund.service.ts:628` | Manual RETRY_WITH_FRESH_KEY switches failed booking to CANCELLED_PENDING_REFUND through lifecycle within retry/key transaction |

There are **nine current external projection calls**, not the session's historical twelve. Coverage follows this inventory rather than that count.

Bookkeeping exclusions: lifecycle paymentId attachment (68/89); cancellation quote lock/finalize/release (196/275/307); SyncClaimService acquisition/release (24/57); supplier sync timestamp, lease cleanup, unchanged fingerprint and failed-sync cleanup (218/238/256/279/540); disruption reconciliation backoff/lease maintenance (207). These do not change projected/business state and need no version bump/event. Supplier row-lock touch is not a second business mutation. If re-inventory finds an excluded write also changes domain state, split/classify that state change explicitly rather than excluding the entire write.

FAILED is terminal for ordinary failure/replay behavior, **not irrevocable under authoritative payment evidence**. Preserve existing confirmation eligibility from PROCESSING or FAILED when captured payment plus airline order is verified. Recovery's current PROCESSING-only guards remain unless the existing authoritative confirmation path is invoked. Never widen failed-to-confirmed eligibility using an ambiguous provider outcome. CONFIRMED/completed/cancelled states are protected from stale failures. A recovery event indicates the actual applied transition, not mere completion of a reconciliation attempt.

Recovery currently pairs booking failure/confirmation with a subsequent payment status update in two branches. Make each existing pair atomic with version/event collection; do not publish between those writes. The no-payment timeout changes only booking; captured-without-order changes booking then triggers the existing automated refund outside the transaction. Do not manufacture new PaymentEvent/BookingIntent/LedgerEntry mutations in recovery branches that currently leave them untouched. Regression fixtures assert those records remain unchanged on rollback and that existing financial facts are not duplicated. Saga financial finalization retains its separate complete canonical bundle.

## Hydration and projection

BookingEventHydrator reads booking status/version and the latest itinerary revision with segments ordered by globalOrder from a coherent database snapshot: one SQL statement or a short RepeatableRead read transaction. Preserve latest-revision-before-flightSnapshot extraction and current public fields. A cached in-flight promise belongs to one event processing cycle, keyed by event ID; parallel consumers share it, and finally cleanup releases it. A later delivery/reconciliation has a fresh cycle, even for the same booking. Never cache by booking ID indefinitely.

Early stale-event check may skip when event.sourceVersion is already covered. Otherwise persist the **hydrated source version**, which may be newer than the event. Repository performs atomic insert-or-update conditioned on stored sourceVersion being lower than incoming hydrated version. A separate read/check followed by unconditional upsert is insufficient. Equal/lower versions skip. Preserve the concurrent insertion winner's agentReference and never modify it on update. This is a database stale-write predicate, not an optimistic-lock retry framework.

Projection remains an explicit allowlist: status, airline, origin/destination, departure/arrival, duration/stops, flight number, baggage summary, nullable refundable/changeable, stable reference, private booking relation, timestamps/version. Never spread booking/provider objects. Logs contain eventId, bookingId, sourceVersion and classified safe error code; metrics have bounded labels and no identifiers. Do not log raw thrown objects/snapshots.

When current source cannot yield usable itinerary data, do not create an invented projection. Missing projection is skipped/observed. Existing projection remains unchanged and **stale**, including its sourceVersion; no status-only update may mark old itinerary fully repaired. Use flightSnapshot fallback only when no authoritative itinerary revision exists. If the latest revision exists but is malformed or empty, report extraction failure rather than stamping an older flightSnapshot current. This is a deliberate freshness safeguard for corrupted revision data. Do not expose hydrated private data through a fallback read.

## Reconciliation and backfill

Once per minute, with local overlap protection, select at most 100 missing/stale candidates; repair with concurrency at most five. Repository uses LEFT JOIN semantics for every missing row and `Booking.version > projection.sourceVersion` for drift. Do not exclude missing rows without flight data from the candidate query: include them in the same bounded cursor traversal and record skipped/no-source-data. Include existing projections even when current source is malformed. Missing source data is observable, not counted as repaired.

Maintain a deterministic booking-ID keyset cursor across passes. Advance after each selected candidate regardless of success; reset only at end of range. Thus permanently bad low IDs do not starve later rows. New rows below cursor are considered after wrap. Multiple replicas may duplicate work safely through guarded writes; distributed leasing is deferred. Each repair uses the same snapshot hydrator and repository as live events. Existing `prisma/scripts/backfill-booking-agent-projections.ts` must delegate to that writer, replacing duplicated extraction/unconditional upsert.

The repository contract is `findStaleBookingIds({ limit: 100, afterBookingId: string | null }): Promise<{ bookingIds: string[]; nextCursor: string | null; reachedEnd: boolean }>`. Order by booking ID ascending and use a strict greater-than predicate when cursor exists. Select at most limit; a short/empty page means reachedEnd. A full page returns its last ID and reachedEnd=false; if that was the final full page, the following empty pass discovers the end. The coordinator advances to nextCursor after all selected outcomes settle, including failures/skips; on reachedEnd reset to null for the next scheduled pass. Never scan a second page in the same pass. An empty result never leaves a nonnull cursor stuck forever.

Record `booking_projection.failure` and `projection_reconciliation.{stale_found,repaired,failed,duration}`; distinguish current/skipped from repaired. No provider calls, generic retry, financial writes, queue or outbox. Missing-event repair is the accepted durability boundary.

## Required contract tests

Unit tests cover envelope privacy, outcome routing, no-op count, fresh retry collectors, failure isolation and missing-data policy. PostgreSQL integration proves rollback suppression, outer commit timing, coherent snapshot/version, reversed hydration completion, concurrent insert/stable reference, duplicate deliveries, migration drift, missing projection and fair >100-row traversal. Boot the real module graph without new cycles.

Adapt `src/agent-gateway/booking-agent-projection.service.spec.ts` into projection tests and update lifecycle/recovery/cancellation/supplier-sync/refund-settlement/payment-refund service specs. Preserve `src/agent-gateway/safe-booking-read/safe-booking-read.service.spec.ts`, `test/booking-agent-projection-privacy.e2e-spec.ts`, `test/booking-projection-backfill.e2e-spec.ts`, `test/chat-persistence-migration.e2e-spec.ts`, `test/characterization/booking-characterization.e2e-spec.ts`, `test/characterization/refund-characterization.e2e-spec.ts`, `test/refund-settlement.e2e-spec.ts` and existing disruption database suites. Eventual-consistency assertions use bounded waits, not synchronous projection assumptions.
