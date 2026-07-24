# Flight Booking System

Core domain language and glossary for the Flight Booking System.

## Language

**Cancellation**:
The process of terminating a confirmed flight booking. Must ALWAYS be executed Supplier-First (Duffel API) to secure the release of the PNR before any financial reimbursement (Stripe) is attempted.
_Avoid_: Revocation, Undo

**Cancellation Pending**:
A transient claim state where a process has atomically claimed a booking for cancellation (via CAS update), but the supplier cancellation has not yet been attempted or confirmed. Exists to prevent concurrent cancellation attempts from racing.
_Avoid_: Cancelling, Cancel Queued

**Refund Pending**:
A transient state (`CANCELLED_PENDING_REFUND`) where the flight has been successfully cancelled with the supplier, but the financial reimbursement has not yet been confirmed by the payment gateway.

**Refund Escalation**:
The hybrid process of attempting a Stripe refund with inline retries, falling back to a cron-based background worker with exponential backoff, and finally escalating to manual admin review (`REFUND_FAILED_NEEDS_ATTENTION`) if all retries are exhausted or the idempotency key expires.

**Cancellation Deadline**:
The fare-specific cutoff time before which a booking may be cancelled for a refund. Derived from Duffel's fare conditions at booking time and stored on the Booking row. Not a system-wide constant — varies by fare class.
_Avoid_: Cancellation Window, Refund Deadline

**Supplier Synchronization**:
The single, idempotent process that fetches the supplier-authoritative itinerary and compares it with the latest itinerary revision. Duffel webhooks are the primary trigger; scheduled reconciliation is a backup. Both converge on the same pipeline. Supplier events and scheduled verification are triggers only, never the authoritative data source.
_Avoid_: Ticket refresh, Airline polling

**Reconciliation Cron**:
A backup sync trigger that runs every 30 minutes, scanning CONFIRMED bookings with departure within 72 hours, ordered by `lastDuffelSyncedAt ASC, departureAt ASC` (stalest-then-soonest priority). Processes 20 bookings per run via cursor. Exists solely to catch changes that webhooks missed — not a primary sync mechanism. Updates `lastDuffelSyncedAt` on each processed booking.
_Avoid_: Primary sync, Full-table scan

**Duffel Webhook Inbox**:
A lightweight durable event table (`duffel_webhook_events`) that receives verified Duffel webhook payloads. The webhook endpoint verifies the signature, inserts one small row (event ID, order ID, event type, status, attempts, raw payload), and returns 200 immediately. A DuffelEvent processor polls pending events in small batches and runs the supplier synchronization pipeline for each. On Duffel fetch failure: increment attempts, set RETRY_SCHEDULED with exponential backoff (1m, 5m, 15m); after 5 failures escalate to FAILED_NEEDS_ATTENTION. Cron-triggered syncs need no explicit retry — `lastDuffelSyncedAt` staleness keeps failed bookings at the top of the priority queue. This is the transactional inbox pattern — the receiving-side mirror of the Notification Outbox.
_Avoid_: Fire-and-forget, Heavy queue infrastructure

**Itinerary Revision**:
An immutable, supplier-authoritative version of a confirmed booking's flight itinerary captured after an airline-initiated change.
_Avoid_: Ticket update, Flight overwrite

**Segment Matching**:
A confidence-based cascade used by the diff engine to pair segments between two itinerary states. Primary: stable Duffel segment ID. Secondary: carrier + flightNumber + departureDate (optionally + departure airport). Fallback: origin + destination IATA pair + departureDate + time proximity. Position-based matching is a weak tie-breaker only, never a normal fallback. Unmatched old segments are classified as removed; unmatched new segments as added. Itinerary-level patterns (e.g. routing changed, segment replaced by connection) are derived from the aggregate segment-level diff results.
_Avoid_: Index-based matching, Position-only comparison

**Material Disruption**:
An airline-initiated itinerary revision requiring traveller attention. Classified by a deterministic ruleset applied to each revision's segment-level diff. Binary rules (always material): segment removed/cancelled, replacement segment added, departure or arrival airport changed, segment date changed, overnight connection introduced, connection time below Minimum Connection Time. Threshold rules (system-wide constants): departure moved earlier by >1 hour, departure moved later by >2 hours, final destination arrival shifted by the same thresholds. The 3rd material notification per booking per day carries a stabilization warning; beyond that, the booking is flagged for manual review.
_Avoid_: Routine update, Minor revision

**Minimum Connection Time (MCT)**:
A system-wide constant (60 minutes) representing the minimum acceptable duration between consecutive segments' arrival and departure. If an itinerary revision causes the connection time to drop below MCT, the change is classified as a Material Disruption. Not airport-specific or fare-specific — a single global floor.
_Avoid_: Airport-specific MCT, Dynamic connection threshold

**Notification Outbox**:
A durable record written in the same transaction as an itinerary revision and disruption classification. Represents a pending notification request that a future notification delivery service will consume, replay, and mark as delivered. Never inferred retroactively from itinerary diffs.
_Avoid_: Notification queue, Alert log

**Disruption Status**:
An orthogonal field on Booking (separate from BookingStatus) that tracks the lifecycle of a detected disruption: NONE → DETECTED → ACKNOWLEDGED → RESOLVED. Carries only the state — the cause and details live on the associated Itinerary Revision. Scoped to a specific revision via `activeDisruptionRevisionId`; when a new material revision arrives, the status resets to DETECTED with the new revision ID. Transitions: DETECTED via material revision; ACKNOWLEDGED via explicit traveller click; RESOLVED via traveller acceptance, departure passing, admin action, or booking cancellation. DETECTED also auto-resolves on departure to prevent stale unacknowledged records. The cycle can repeat — a RESOLVED booking returns to DETECTED if a new material revision arrives. Resolution is auditable: `resolvedReason` (TRAVELLER_ACCEPTED, DEPARTURE_PASSED, ADMIN_RESOLVED, BOOKING_CANCELLED), `resolvedAt`, and `resolvedBy` (traveller/system/admin) are captured on every RESOLVED transition. Cancellation and disruption are independent — travellers may cancel during a disruption, and cancellation auto-resolves the disruption. Disruptions do not affect cancellation deadlines.
_Avoid_: Disruption reason, Disrupted booking status

**Sync Claim**:
A two-layer concurrency guard for the supplier synchronization pipeline. Primary: a CAS (compare-and-swap) update on a `syncLockedAt` timestamp field on Booking — first caller wins, stale locks self-expire. Fallback: a UNIQUE constraint on (booking_id, version) on Itinerary Revision — if two pipelines race past the CAS, the database rejects the second insert. The loser catches the unique violation and exits cleanly.
_Avoid_: Distributed lock, Queue-based serialization

**Notification Throttle**:
A per-booking daily cap (3 material notifications/day) on outbox writes. The 3rd notification carries a stabilization warning informing the traveller that frequent changes are being monitored. Beyond the cap, no further outbox records are created and the booking is flagged for manual admin review. Revisions and materiality classification continue unconditionally regardless of the throttle.
_Avoid_: Silent suppression, Batched digest
