# Research: Disruption & Flight-Change Management

This document resolves the technical and product unknowns identified while planning Feature 14. It is based on the current working tree, the Feature 14 grilling ADR, project context/constitution, and Duffel’s official webhook documentation.

## Decision 1 — Dedicated disruption domain module

**Decision:** Create a dedicated NestJS disruption module for the webhook receiver, inbox processor, supplier synchronization application service, reconciliation scheduler, matcher/diff/classifier domain services, traveller disruption APIs, and admin operations. Integrate BookingService only at booking reads and cancellation/completion transitions.

**Rationale:** BookingService already owns stale payment reconciliation, completion, booking reads, cancellation quotes, and supplier-first cancellation. Adding every disruption responsibility there would create a high-coupling service and make isolated testing difficult.

**Alternatives considered:** Extending BookingService was rejected because it mixes unrelated clocks, retries, and state machines. A separate deployable queue service was rejected because the transactional inbox and existing Nest scheduler meet the required scale with less infrastructure.

## Decision 2 — Official Duffel webhook contract

**Decision:** Subscribe initially to `order.airline_initiated_change_detected`. Verify the `X-Duffel-Signature` header against the exact raw body with HMAC and constant-time comparison, including timestamp replay tolerance. Deduplicate on Duffel event ID, validate the order ID from `data.object`, persist the verified event, and return success without fetching Duffel in the request.

**Rationale:** Duffel documents at-least-once, unordered delivery and signed HTTPS requests. Its receiving guide specifies the signature header and raw-byte/timestamp construction. The current Nest bootstrap already enables `rawBody: true`, so the existing Stripe webhook shape can be reused safely.

**Alternatives considered:** Trusting parsed JSON was rejected because it breaks signature verification. Using `idempotency_key` as the only deduplication identity was rejected because the event ID is the delivery identity and payload semantics can vary by event. Processing synchronously was rejected because a crash or slow supplier read would create provider retry pressure.

**Primary references:**

- https://duffel.com/docs/guides/receiving-webhooks
- https://duffel.com/docs/api/webhooks/schema
- https://duffel.com/docs/api/v2/webhook-events

## Decision 3 — Durable inbox lifecycle and complete retry schedule

**Decision:** Use `PENDING`, `PROCESSING`, `RETRY_SCHEDULED`, `PROCESSED`, `SKIPPED`, and `FAILED_NEEDS_ATTENTION`. Workers claim with a token and lease. Transient failures schedule attempt 2 at +1 minute, attempt 3 at +5 minutes, attempt 4 at +15 minutes, and attempt 5 at +15 minutes; the fifth failed execution escalates with no sixth attempt.

**Rationale:** This resolves the ADR’s mismatch between three listed delays and escalation after five failures. A capped final delay is predictable, testable, and retains the approved 1/5/15-minute policy.

**Alternatives considered:** Infinite exponential retry was rejected because persistent schema/auth/not-found failures need operations attention. A single global worker lock was rejected because it prevents safe multi-instance scaling and isolates failures poorly.

## Decision 4 — One authoritative synchronization command

**Decision:** Both inbox and reconciliation call `syncBooking(bookingId, source, correlation)`. The command claims the booking, fetches the complete Duffel order outside a database transaction, normalizes it, and commits a short atomic transaction after rechecking eligibility.

**Rationale:** Triggers are hints; only a fresh supplier read is authoritative. A single command ensures identical fingerprint, matcher, materiality, throttle, and race behavior regardless of trigger.

**Alternatives considered:** Diffing the webhook payload was rejected because it is not guaranteed to be a complete current itinerary. Separate cron/webhook pipelines were rejected because their semantics would drift.

## Decision 5 — Owned synchronization lease

**Decision:** Extend the timestamp CAS with a random lock token. Claim only confirmed, synchronizable bookings whose lock is absent or older than five minutes. Apply an upstream timeout shorter than the lease. Release/update by booking ID plus the exact token, never by booking ID alone.

**Rationale:** A timestamp-only release allows an expired worker to clear a successor’s claim. The unique `(booking_id, version)` revision constraint remains defense-in-depth, but does not replace lock ownership.

**Alternatives considered:** Holding a database transaction across Duffel was rejected because remote latency would hold locks. A distributed Redis lock was rejected because a database CAS plus unique constraint already protects the only durable write target.

## Decision 6 — Canonical fingerprint and revision semantics

**Decision:** Canonicalize slice and segment order plus stable itinerary fields and compute a versioned SHA-256 fingerprint. A successful fetch equal to the latest revision—or the original snapshot before the first revision—updates coverage and writes no revision. Every changed state writes one immutable revision. A repeated fingerprint is allowed later because an itinerary can legitimately revert to an earlier state.

**Rationale:** Polls and duplicate events must not create history noise, while a revert is still a new chronological change.

**Alternatives considered:** A unique `(booking_id, fingerprint)` constraint was rejected because it would erase legitimate A→B→A history. Storing every fetch was rejected because the ADR requires every detected change, not every observation.

## Decision 7 — Preserve original and expose current itinerary separately

**Decision:** Keep `Booking.flightSnapshot` immutable as the original. Store changed supplier states as normalized revision segments and return the newest revision as the current itinerary. If no revision exists, current equals original. Maintain derived current/next/final timing fields on Booking for list, reconciliation, and completion queries.

**Rationale:** The existing booking page/read DTO treats `flightSnapshot` as current. Overwriting it would destroy cumulative comparison; continuing to render it as current would show stale information beside a disruption alert.

**Alternatives considered:** Overwriting the JSON snapshot was rejected because it breaks audit and cumulative drift. Reconstructing next-departure eligibility from JSON in every cron query was rejected because it is not indexable and would make fair batching difficult.

## Decision 8 — Round-trip completion and reconciliation eligibility

**Decision:** Treat each Duffel slice as a journey. Store slice order on revision segments. A booking remains synchronizable while a next unflown segment exists. Completion occurs after the current final segment arrival, not the first outbound departure. Reconciliation selects confirmed bookings whose next unflown departure is greater than now and no more than 72 hours away.

**Rationale:** The current completion sweeper moves a booking to `COMPLETED` when the first departure passes, which would stop return-leg monitoring.

**Alternatives considered:** Scanning only `Booking.departureAt` was rejected as incorrect for round trips. Including all completed bookings was rejected because it creates unbounded supplier reads.

## Decision 9 — Deterministic one-to-one segment matcher

**Decision:** Consume old/new candidates exactly once using this cascade:

1. exact Duffel segment ID;
2. carrier + flight number + local departure date + departure airport;
3. origin + destination + local departure date + nearest departure instant within six hours;
4. original position only as a deterministic tie-breaker.

If fallback candidates are equally plausible or outside tolerance, keep them unmatched and classify them as removed/added. Persist match method and confidence in diff details.

**Rationale:** Position matching creates cascading false diffs after insertion/removal. The six-hour ceiling prevents pairing unrelated same-route flights while supporting moderate schedule moves. Favoring unmatched structural changes is safer than silently pairing ambiguous segments.

**Alternatives considered:** Index-only and many-to-one matching were rejected. Unbounded nearest-time matching was rejected because multiple same-day flights can be incorrectly paired.

## Decision 10 — Materiality uses either baseline

**Decision:** Evaluate the approved rules against previous→current and original→current. The revision is material when either baseline triggers. Persist the triggering baseline(s) and reasons.

**Rationale:** The ADR says incremental changes drive notification but also says retaining minor revisions prevents cumulative material drift from being lost. Materiality on incremental diff alone contradicts that rationale.

**Alternatives considered:** Incremental-only was rejected because two 40-minute earlier moves would evade the more-than-one-hour rule. Cumulative-only was rejected because it cannot accurately describe the latest change.

## Decision 11 — Exact time and journey rules

**Decision:** Compare instants for shift duration and airport-local calendar dates for date/overnight rules. Earlier is material only when greater than 60 minutes; later only when greater than 120 minutes. A connection is material below 60 minutes; exactly 60 is acceptable. Apply connection and final-arrival rules within each slice, never between an outbound and return slice. Negative/overlapping intervals are material.

**Rationale:** Explicit equality, DST, local date, and slice semantics make classification reproducible.

**Alternatives considered:** UTC date alone was rejected because a flight can cross the local date boundary without changing travel day meaning. Booking-wide final arrival was rejected because it hides outbound final-destination impact on round trips.

## Decision 12 — Revision-scoped lifecycle actions

**Decision:** Acknowledge only the active `DETECTED` revision and accept the active `DETECTED` or `ACKNOWLEDGED` revision. Same-revision retries return canonical success. A stale revision returns HTTP 409 with the current active revision. Accept is a local `TRAVELLER_ACCEPTED` resolution and performs no Duffel operation.

**Rationale:** A browser can submit after a newer event. Revision preconditions prevent acknowledging unseen changes and preserve the deferred boundary around voluntary supplier changes.

**Alternatives considered:** Booking-scoped actions without a revision were rejected as race-prone. Collapsing acknowledge and accept was rejected because the approved state machine distinguishes awareness from acceptance.

## Decision 13 — Cancellation wins the race

**Decision:** Add disruption auto-resolution to the same conditional write that records supplier-confirmed cancellation (`CANCELLED_PENDING_REFUND` in the current schema). The sync final transaction must re-read booking status and abort if it is no longer confirmed. Resolver actor derives from the authenticated cancellation command or system recovery path.

**Rationale:** Refund settlement can occur later; the itinerary ceases to be active when supplier cancellation succeeds, not when Stripe finishes.

**Alternatives considered:** Resolving only at `CANCELLED_AND_REFUNDED` was rejected because it leaves a cancelled flight disrupted while payment recovers. Independent writes were rejected because a crash could split cancellation and disruption state.

## Decision 14 — Atomic notification outbox and UTC throttle

**Decision:** Create at most one outbox row per material revision in the revision transaction. Count rows for the booking’s UTC day under the same transaction. Rows 1–2 are normal, row 3 carries `stabilizationWarning`, and row 4+ is suppressed while an independent booking attention reason/timestamp is set. No recipient PII is stored.

**Rationale:** Atomicity prevents a committed disruption without its delivery request. An independent attention field avoids overloading traveller lifecycle state.

**Alternatives considered:** Inferring messages later from revisions was rejected because delivery intent could be lost. Suppressing revisions was rejected because throttle is a communication policy, not a truth-storage rule.

## Decision 15 — Budget-aware fair reconciliation

**Decision:** Run every 30 minutes with a limit of 20. Order null/oldest sync coverage first, then next unflown departure, then booking ID. Use stable keyset progression and a failure/backoff field so one repeatedly failing row cannot monopolize all batches. Check the existing Duffel budget/rate telemetry before each claim and yield to critical booking/search traffic.

**Rationale:** Fixed settings can make up to 960 reconciliation reads/day; constitution budget thresholds and fairness must be designed, not added later.

**Alternatives considered:** Full scans and offset pagination were rejected due cost and unstable ordering. Updating `lastDuffelSyncedAt` on failure was rejected because it would falsely claim coverage.

## Decision 16 — Frontend foundation is a prerequisite, not assumed state

**Decision:** Add a Phase 0 implementation gate that verifies/restores the minimum protected booking detail/list pages, typed server-only API client, NextAuth session typing, and Playwright configuration before Feature 14 UI. Initial reads are uncached Server Component reads; client mutations refresh canonical state. No SSE/WebSocket dependency is introduced.

**Rationale:** The clean working tree has no booking/detail/admin frontend or Playwright config even though Feature 11/12 documents mark them complete. Planning modifications to absent files would be non-executable.

**Alternatives considered:** Treating documentation as source truth was rejected after filesystem verification. Deferring all UI was rejected because traveller awareness is a core Feature 14 outcome.

## Decision 17 — Admin and security boundary

**Decision:** Reuse Nest `JwtAuthGuard`, `RolesGuard`, and `@Roles('ADMIN')`. Backend authorization remains authoritative. The admin surface lists failed inbox events, notification-suppressed/aged disruptions, and data-quality gaps; supports safe retry and manual resolution with a required note. Raw payload never appears in APIs.

**Rationale:** The browser session currently lacks a typed role, and client hiding cannot be an authorization boundary.

**Alternatives considered:** Client-only admin gating was rejected. Reusing the refund admin page was rejected because it is absent from the current tree and represents a separate operational domain.

## Decision 18 — Retention, rollout, and rollback

**Decision:** Retain raw inbox payload for at most 30 days, then redact/delete it; retain revision and audit history with booking retention; retain outbox until its future consumer contract defines archival. Deploy additive schema and dormant code first, then enable webhook ingestion, canary processing, bootstrap/reporting, reconciliation, customer/admin surfacing, and outbox creation as separate flags. Rollback disables triggers/workers/UI but keeps durable rows.

**Rationale:** Supplier payloads may contain PII, while durable operational state must survive rollback. Independent flags isolate rollout risk.

**Alternatives considered:** Immediate all-at-once enablement and destructive down-migration were rejected because queued events/revisions would become unrecoverable.

## Resolved Technical Context

| Area | Resolution |
| --- | --- |
| Runtime | Node.js 20+, TypeScript 5.4, NestJS 10, Next.js 14.2.3 App Router |
| Data | PostgreSQL through Prisma (lockfile-resolved client/tooling; generate through pnpm workspace commands) |
| Scheduling | Existing `@nestjs/schedule`; all jobs remain multi-instance safe through database claims |
| External supplier | Installed Duffel SDK for complete order retrieval plus dedicated raw HMAC verifier for webhooks |
| Testing | Jest unit/API E2E + Supertest, Playwright 1.41.2 after restoring config, redacted Duffel fixtures |
| Scale | Batch 20 inbox/reconciliation work; 30-minute reconciliation; no new queue infrastructure |
| Performance | webhook ack p95 <500 ms; processed change visible p95 <2 min; local booking reads p95 <200 ms |
| Security | raw-body HMAC, replay tolerance, JWT ownership, ADMIN RBAC, PII-safe logging/API, 30-day raw payload retention |
