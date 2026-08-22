# Architecture

## Stack

| Layer              | Tool                         | Purpose                                                                               |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------- |
| Language           | TypeScript & Python 3.11+    | TS for web/API, Python for agent service                                              |
| Backend Framework  | NestJS                       | Deterministic backend services (booking, payments, auth)                              |
| Frontend Framework | Next.js (App Router)         | SSR, SEO, Server Components for the user-facing UI                                    |
| Database           | PostgreSQL                   | Primary transactional store (users, bookings, payments)                               |
| ORM                | Prisma                       | Type-safe queries, declarative schema, versioned migrations                           |
| Cache / Rate Limit | Redis                        | Search result caching, seat map caching (60s TTL), rate limiting, API budget tracking |
| Authentication     | NextAuth.js (Auth.js) + JWT  | Email/password for v1. Social login deferred                                          |
| Payment            | Stripe (Payment Intents)     | PCI-DSS compliant payment processing                                                  |
| Flight Data        | Duffel API                   | Flight search, pricing, seat maps, ancillary services, PNR creation, ticketing        |
| AI Model           | Mimo (OpenAI-compatible URL) | Advisory agents — search assistance, recommendations                                  |
| AI Framework       | LangChain (JS/Python)        | Agent chains, tool calling, conversation memory                                       |
| AI Observability   | LangSmith                    | Agent run tracing, tool call auditing                                                 |
| Code Review        | CodeRabbit                   | Automated PR review for security and code quality                                     |

---

## Project Structure (Current)

```
/
├── AGENTS.md                          → Agent rules and procedural guidance
├── PROJECT.md                         → Project high-level definition
├── TEST_INFRA.md                      → E2E testing infrastructure docs
├── TEST_READY.md                      → E2E test coverage and runbook
├── pnpm-workspace.yaml                → pnpm workspace config
├── package.json                       → Monorepo dependencies and workspaces
├── tsconfig.json                      → Base TypeScript compiler options
├── .gitignore
├── skills-lock.json
│
├── apps/
│   ├── api/                           → NestJS backend API service
│   │   ├── prisma/                    → Prisma database schemas & migrations
│   │   ├── src/                       → NestJS source code (auth, health, audit, etc.)
│   │   └── test/                      → API E2E spec tests
│   ├── agent/                         → Python/FastAPI agent service (NEW)
│   │   ├── src/                       → FastAPI source code (middlewares, endpoints, config)
│   │   └── tests/                     → pytest unit and integration tests
│   └── web/                           → Next.js frontend UI service
│       ├── app/                       → Next.js App Router pages and API routes
│       ├── components/                → React UI components
│       └── tests/                     → Playwright UI browser tests
│
├── packages/
│   └── shared/                        → Shared library for types and constants
│       └── src/                       → Shared TypeScript validation contracts
│
├── docs/
│   ├── adr/                           → Architectural Decision Records
│   └── runbooks/                      → Operational runbooks (booking-readiness.md, chatbot-handoff.md)
│
├── context/
│   ├── architecture.md                → This file
│   ├── code-standards.md              → General coding rules and conventions
│   ├── library-docs.md                → Usage guide for third-party libraries
│   ├── progress-checker.md            → Detailed progress status tracker
│   ├── project-overview.md            → High-level system requirements and flow
│   └── workflow.md                    → The step-by-step development process
│
├── research/
│   ├── decision-boundaries.md         → Architecture decisions from grilling
│   └── tech-stack-decisions.md        → Tech stack decisions from grilling
│
├── .agents/
│   └── skills/                        → Project-level agent skills
│
└── .specify/
    ├── memory/
    │   └── constitution.md            → Project constitution (v2.0.0)
    ├── templates/                     → Spec Kit templates (spec, plan, tasks, etc.)
    ├── extensions/                    → Spec Kit extensions (agent-context)
    ├── integrations/                  → Integration manifests
    ├── scripts/                       → Setup and prerequisite scripts
    ├── workflows/                     → Workflow definitions
    ├── extensions.yml
    ├── init-options.json
    └── integration.json
```

## Build and Runtime Output

The root TypeScript configuration is type-check-only and sets `noEmit: true`. Package build configurations override that setting where runtime JavaScript is required: the API emits `apps/api/dist/main.js` for NestJS startup, and the shared package emits `packages/shared/dist` for the API's workspace imports. The API development command builds shared types first and then runs `nest start --watch`; inheriting the root `noEmit` setting prevents the API entrypoint from being created and causes a `dist/main` module-resolution failure.

---

## Data Flow

### Flight Search (Deterministic Path)

```
User enters search criteria (origin, destination, dates, adults, children, infants, cabinClass)
        ↓
Next.js → POST /api/flights/search
        ↓
NestJS flights.controller validates input
        ↓
cache.service checks Redis for matching cached results
        ├── Cache HIT → return cached results immediately
        └── Cache MISS ↓
            cache.service checks rate limit + API budget counter
                ├── Budget exceeded → return 429 with friendly message
                └── Budget OK ↓
                    duffel.service calls Duffel API (offerRequests.create)
                        ↓
                    Response cached in Redis (TTL: 15 min)
                        ↓
                    API budget counter incremented (Redis INCR)
                        ↓
                    Results returned to frontend
```

### Airport & Map Integration (Deterministic Path)

```
User visits search results page or homepage map
        ↓
Next.js client-side map calls GET /airports/search, GET /airports/nearby, or GET /airports/all
        ↓
NestJS airports.controller validates query parameters (via DTOs)
        ↓
cache.service checks Redis for cached query response
        ├── Cache HIT → return cached JSON immediately
        └── Cache MISS ↓
            airports.service executes Prisma query against PostgreSQL database
                ├── Standard search/lookup -> SELECT/findUnique/findMany
                └── Proximity search (GET /nearby) -> PostgreSQL clamped Haversine raw SQL query
            ↓
            Response cached in Redis (TTL: 24h for search/all/details, 1h for nearby)
            ↓
            Results returned to frontend
```

### Booking Flow (Deterministic Path — No AI)

```
User selects flight + enters passenger details
        ↓
Next.js → POST /api/bookings/create
        ↓
NestJS bookings.controller validates passenger data
        ↓
bookings.service calls Amadeus Flight Price (confirm pricing)
        ↓
bookings.service calls Amadeus Flight Order (create PNR)
        ↓
Prisma writes booking record to PostgreSQL
        ↓
Returns booking ID + PNR reference to frontend
        ↓
User proceeds to payment
```

### Ancillary Services Flow (Feature 15; Deterministic Path — No AI)

```
User completes passenger details → owned BookingIntent → Ancillaries page
        ↓
Next.js → GET /api/bookings/intent/:intentId/ancillaries
        ↓
API authenticates owner, loads intent, then cache.service checks Redis for seatmap:{offerId}
        ├── Cache HIT (TTL > 3s remaining) → return supplier-native catalog
        └── Cache MISS or TTL ≤ 3s (early expiry buffer) ↓
            duffel.service calls Duffel Seat Maps API (duffel.seatMaps.get)
                ↓
            Response cached in Redis (TTL: 60s)
                ↓
            Supplier-native catalog returned (cabins, rows, elements, available_services with per-seat pricing)
        ↓
API maps Duffel passenger IDs to this intent's passengers in request scope
        ↓
Frontend renders custom seat map + baggage selector
        ↓
Client-side price tracker aggregates: Total = Base Fare + Σ(Seat Prices) + Σ(Baggage Prices)
        ↓
User selects seats (tab-based stepper: one passenger at a time, segment tabs above)
        ↓
User selects baggage (same page, switchable section, per-segment with journey-wide options)
        ↓
User clicks "Continue" → server appends a versioned snapshot to BookingIntent + client writes minimal localStorage recovery record
        ↓
Review page renders read-only summary with [Edit seats] / [Edit baggage] links
        ↓
User clicks "Continue to Payment" → server-side validation pipeline:
    1. CAS-freeze the current snapshot/version, then release DB locks
    2. Re-price exact offer + services with Duffel
    3. CAS-persist authoritative totals on that snapshot and bind it to Payment
    4. Create single Stripe PaymentIntent (manual capture) for full amount
    5. Customer authorizes → Verify requires_capture
    6. Create Duffel order with the Payment-bound services[] array
    7. Duffel confirmed → Capture Stripe | Duffel failed → Cancel authorization
```

- **Seat Map Rendering**: Custom-built renderer (not Duffel `@duffel/components`). Uses semantic/non-color seat states, distinct "selected by your group" indicators, and automatic exit-row age filtering.
- **Multi-Segment**: Segment tabs above passenger stepper. Each segment loads its own seat map. Missing seat maps degrade gracefully with airline-assigned message.
- **Data Schema**: Phase 1 implements additive Prisma models and migration for append-only, versioned `AncillarySelection` snapshots keyed by stable service/passenger/segment identities. `BookingIntent` points to the current version; `Payment` can reference the immutable snapshot it priced for recovery with `ON DELETE RESTRICT`. Newly created intent passengers persist their Duffel passenger ID through deterministic type-and-ordinal matching.
- **Security**: JWT + BookingIntent ownership validation, intent-scoped supplier-to-local passenger mapping, service ID verification, Duffel as final availability arbiter, and idempotency for double-click/retry prevention.
- **Owned Ancillary API**: `GET`/`PUT /bookings/intent/:intentId/ancillaries` load the owned active intent before calling the offer-scoped `seatmap:{offerId}` cache. The cache remains supplier-native; passenger projections are derived only per authenticated request. `PUT` validates authoritative service scopes and currency, appends a snapshot plus child rows, and advances the current pointer through an optimistic version CAS without payment or order side effects.
- **Checkout Foundation**: Protects check-out steps via `protectCheckoutRoute` server helper and `NEXT_PUBLIC_FEATURE_FLAG_CHECKOUT` flag. Resolves owner and active validation for `[intentId]` endpoints, surfacing granular error layouts (Not Found 404, Forbidden 403, Expired 410, Service Unavailable 500). Gathers passengers dynamically, applying profile prefilling, date validations, and conditional passport assertions (mandatory on international segments, optional on domestic). Mocks E2E flows using Playwright route interception and custom `mock-scenario` cookies.
- **Review, Recovery, and Cancellation**: Phase 6 introduces read-only review with targeted edit routing, versioned and PII-safe localStorage recovery, conflict-based re-routing back to selections on payment failure, minimal post-purchase confirmed summaries, and supplier-authoritative cancellation/refund quote fields (`refundTo`, `nonRefundableAncillaryAmount`, `nonRefundableAncillaryCurrency`) serialized/parsed inside the `duffelCancellationQuoteId` DB column to avoid database schema migrations.

### Traveler Profile & Pure Booking Readiness

- **Pure evaluator boundary**: `BookingReadinessEvaluator` lives under `apps/api/src/booking-intent/` and accepts normalized passengers, itinerary country data, trip completion, supported document types, an advisory buffer, and an injected reference date. It performs no database, HTTP, Redis, airport, supplier, agent, LLM, or logging work and does not mutate inputs.
- **Deterministic scope and readiness**: Scope is derived from every normalized segment as `DOMESTIC`, `INTERNATIONAL`, or blocking `UNKNOWN`. Domestic checks require identity/contact fields; international adds the atomic travel-document section. Passport expiry uses date-only comparisons against explicit trip completion and a bounded advisory buffer. Deferred entry eligibility is represented as a non-blocking unknown unless a safe normalized result is already available.
- **Integration boundary**: Later readiness and intent services own profile/source loading, airport-country resolution, persistence, and HTTP mapping. They reuse the evaluator rather than duplicating its rules; missing country reference data remains a domain `UNKNOWN` result rather than an evaluator infrastructure error.
- **Advisory readiness endpoint**: Authenticated `POST /api/bookings/intents/readiness` is a read-only boundary. It gates on `FEATURE_FLAG_BOOKING_READINESS`, loads the local `FlightOffer`, resolves only the authenticated user's profile through `ProfileService`, normalizes every stored segment, batches airport-country reference lookup, and delegates to `BookingReadinessEvaluator`. It returns the shared safe readiness result with `Cache-Control: no-store, private`, never calls Duffel, and never writes intents, passenger snapshots, profiles, or audit rows.
- **Passenger source boundary**: Canonical intent passengers use a nested discriminated `source` union (`traveler_profile` with `travelerProfileId` plus `expectedProfileRevision`, or complete `inline` identity/contact data). `PassengerSourceResolverService` owner-scopes profile reads by `{id,userId}`, rejects stale revisions with `PROFILE_CHANGED`, supports both live user-bound and established backfill-bound expiry ciphertext during migration, returns detached normalized values with provenance, and performs no writes, audits, supplier calls, or profile mutations. The legacy flat shape remains a compatibility path; canonical source payloads reject flat fields and `useProfile + source` conflicts.
- **Immutable passenger snapshots**: `PassengerSnapshotService` preallocates existing zero-based positions before building `BookingIntentPassengerCreateManyInput` rows. It validates complete identity/contact data and atomic international document groups, preserves date-only values and Duffel IDs, encrypts passport number/expiry with existing versioned AES-GCM AAD `{snapshotVersion,intentId,position,fieldName}`, retains only nullable profile provenance, and returns masked summaries that exclude passport, expiry, email, phone, raw sources, and profile IDs. The canonical nested-source path in `BookingIntentService` now resolves and persists these snapshots transactionally; the legacy flat path remains for compatibility until the remaining Phase 8 route/client migration is complete.
- **Observability boundary**: Advisory outcomes emit structured API events with sanitized trace/correlation identifiers and allowlisted aggregate metadata only; observability failures cannot change the endpoint result.
- **Phase 8 canonical intent boundary**: First-party checkout uses `POST /api/bookings/intents/readiness` followed by `POST /api/bookings/intents`; every passenger source is resolved and authoritatively evaluated before a short transaction creates the intent, immutable snapshots, and audit record. The singular `/api/bookings/intent` routes remain deprecated compatibility aliases, and create/get responses expose only masked passenger/document/contact summaries with legacy passport keys set to `null`.
- **Checkout source integrity**: Canonical profile sources carry `expectedProfileRevision`; the server rechecks revisions immediately before persistence and rejects stale profiles without writes. Inline sources carry complete identity/contact data, while browser checkout submits server-provided offer passenger IDs and never derives itinerary scope locally.
- **Phase 12C Final Passenger Safety & Supplier Order Protection**: `BookingPassengerFinalValidatorService` sits immediately before `DuffelService.createOrder()` inside `PaymentService.executeConfirmPayment` step 2 (`stripe_authorized` recovery point). It enforces:
  - Cryptographically bound AES-256-GCM decryption with context `{ snapshotVersion, intentId, position, fieldName }`. Swapped positions or tampered ciphertext fail closed immediately with `SNAPSHOT_INTEGRITY_FAILURE`.
  - Decrypt-then-expiry strict ordering: ciphertext MAC checked prior to date parsing.
  - Live clock and trip completion date revalidation against document expiry (`DOCUMENT_EXPIRED`) and offer expiry (`OFFER_EXPIRED` 409).
  - Ephemeral Duffel passenger DTO generated in memory only for the active payment claim owner.
  - Fail-closed boundary: On validation failure, Stripe authorization hold is automatically voided/cancelled, payment marked `CANCELLED`, booking `FAILED`, durable PII-safe audit log `final_passenger_validation_failed` recorded, and exactly ZERO calls made to Duffel.
  - Zero Plaintext Invariant: Decrypted PII never logged, never persisted, and never returned in API error responses.

### Booking Management Read Model (Deterministic Path — No AI)

```
The payment-confirmation pipeline creates a PROCESSING Booking before Stripe and Duffel work.
        ↓
Prisma transitions it to CONFIRMED (snapshot + PNR) or FAILED (reason + available snapshot).
        ↓
/bookings/[bookingId] renders the status-specific snapshot without a Duffel read.
        ↓
/bookings server-renders GET /api/bookings for the authenticated user.
        ↓
The client list component changes Upcoming/Past tabs and pagination through URL query parameters.
        â†“
Unique bookingIntentId and status-conditional writes make duplicate submit and stale recovery operations converge on one canonical booking. A captured Stripe payment paired with a Duffel order is authoritative and recovers a stale failed booking to CONFIRMED; completed records remain immutable.
```

### Payment Flow (Deterministic Path — No AI)

```
User triggers payment with Idempotency-Key
        ↓
Next.js → POST /api/payments/create
        ↓
PaymentIdempotencyService.acquireOrReplay checks key and request hash
        ├── Key exists & same hash -> Replay cached response
        ├── Key exists & different hash -> Throw 422 UnprocessableEntity
        └── New key -> Lock key and return acquired status
                ↓
StripeService.createPaymentIntent creates Stripe PaymentIntent (capture_method: 'manual')
        ↓
Prisma writes Payment record (status: CREATED) and logs PaymentEvent
        ↓
Next.js confirms PaymentIntent client-side using Stripe Elements
        ↓
Next.js → POST /api/payments/confirm
        ↓
PaymentIdempotencyService checks key and runs pipeline:
        1. Authorize Stripe PaymentIntent
        2. Call Duffel API to create PNR
        3. Capture Stripe PaymentIntent
        ↓
Prisma updates Payment status (SUCCEEDED) using PaymentStateMachine to enforce transitions
        ↓
Prisma writes balanced double-entry LedgerEntries and records PaymentEvent
        ↓
PaymentIdempotencyService completes key, clears lock, and caches response
        ↓
Results returned to frontend
```

### Cancellation Refund Recovery (Deterministic Path)

```
Supplier-confirmed cancellation persists CANCELLED_PENDING_REFUND with one booking-owned Refund.
        ↓
Inline Stripe retries reuse the refund's idempotency key; transient exhaustion schedules the next durable retry.
        ↓
PaymentCronService runs each minute, CAS-claims only due REFUND_RETRY_SCHEDULED records, and retries Stripe with the same key.
        ↓
Success atomically settles Refund, Payment, Booking, ledger entries, and a PaymentEvent.
        ↓
Deterministic errors, retry exhaustion, or a 22-hour-old key move the refund and booking to REFUND_FAILED_NEEDS_ATTENTION without another Stripe call.
        ↓
An ADMIN may schedule a retry with a fresh key or record an externally completed manual resolution through POST /api/admin/refunds/:refundId/resolve.
```

- **Frontend User Experience**: The booking detail page dynamically renders cancellation/refund alerts and provides an inline "Cancel Booking" quote review and confirmation modal, gated by the fare-specific cutoff deadline. Stale pending states are automatically polled every 5s.
- **Operator Dashboard**: Admins use the `/admin/refunds` view to inspect PII-safe escalated refund states and trigger the manual resolution pipeline.
- **Cancellation Refund Obligation & Transaction Foundation (Feature 019 Slice 1A)**:
  - `CancellationRefundObligation`: Decouples the single customer cancellation debt from individual payment refund attempts. 1:1 with `Booking` (`onDelete: Cascade`), 1:N with `Payment` (`onDelete: Restrict`), and 1:N with `Refund` (Refund Transactions). Amounts are stored in integer minor units (`totalAmount`, `airlineRefundAmount`).
  - `LedgerEntry` Transaction Linkage: `LedgerEntry` links directly to `Refund` records via nullable `refundTransactionId` with compound uniqueness `@@unique([refundTransactionId, accountId, entryType])`, guaranteeing exactly one `DEBIT PLATFORM_REVENUE` and one `CREDIT CUSTOMER_RECEIVABLE` per refund transaction.
  - Restart-Safe Backfill: `apps/api/prisma/scripts/backfill-cancellation-refund-obligations.ts` migrates legacy cancellation refunds into obligations with exact Decimal-to-minor-unit conversion (`Math.round(amount * 100)`), validates double-entry ledger balance invariants (`sum(DEBIT) === sum(CREDIT)`), and strictly quarantines ambiguous candidate ledger pairs when multiple pairs match the same payment without durable refund identity.
- **Refund Reservation & Provider-Blind Settlement Core (Feature 019 Slice 1B)**:
  - `RefundTransactionService` (`apps/api/src/refund/`): Enforces brief interactive pessimistic locking (`SELECT ... FOR UPDATE` on Payment, then CancellationRefundObligation). Validates remaining capacities against active + successful refunds on both parents. Manages transaction-scoped idempotency key binding and reuse, creating `Refund` rows in `REFUND_PENDING` before external money movement.
  - `RefundSettlementService` (`apps/api/src/refund-settlement/`): Pure in-process deterministic operation `settleVerifiedOutcome()` without external network calls. Atomically verifies facts, performs idempotent deduplication, writes balanced double-entry ledger reversal pairs (`DEBIT PLATFORM_REVENUE`, `CREDIT CUSTOMER_RECEIVABLE`), calculates derived aggregate transitions (`PaymentStatus.REFUNDED` vs `PARTIALLY_REFUNDED`, preserving `preDisputeStatus` under `DISPUTED`/`CHARGEBACK_LOST`), and derives Booking completion (`CANCELLED_AND_REFUNDED` only when cumulative obligation refunds meet obligation `totalAmount`). Emits structured PII-safe `PaymentEvent` and `AuditLog` records with trace/correlation context.
- **Unified Refund Trigger Pipeline (Feature 019 Slice 1C)**:
  - All four refund trigger paths in `apps/api/src/payment/` route 100% through `RefundTransactionService.reserveTransaction()` and `RefundSettlementService.settleVerifiedOutcome()`:
    1. **Inline Cancellation**: `PaymentRefundService.processCancellationRefund` uses transaction-specific key (`cancellation-refund:${obligation?.id || bookingId}:1`), executes Stripe call outside DB locks, settles via `RefundSettlementService.settleVerifiedOutcome({ provenance: { source: 'INLINE' } })`.
    2. **Stripe Webhook**: `PaymentWebhookService.handleChargeRefunded` verifies webhook payload, matches/late-binds pending `Refund` record, and settles via `RefundSettlementService.settleVerifiedOutcome({ provenance: { source: 'WEBHOOK', externalEventId } })`.
    3. **Background Sweeper**: `PaymentCronService.handleCancellationRefundRecovery` claims lease on pending retries, executes Stripe call, and settles via `RefundSettlementService.settleVerifiedOutcome({ provenance: { source: 'CRON' } })`.
    4. **Admin Manual Resolution**: `AdminRefundController.resolveRefund` extracts caller identity (`req.user?.id`), executes resolution action, and settles via `RefundSettlementService.settleVerifiedOutcome({ provenance: { source: 'ADMIN', actorId } })`.
  - Monolithic `cancellation-refund:{bookingId}` keys replaced with transaction-specific idempotency keys. All disparate, duplicated DB mutations across payment refund services eliminated.

### Disruption Core Domain (Deterministic Path)

```
Authoritative Duffel Order Payload or Local Snapshot Array
        ↓
ItineraryNormalizer maps raw structures to Ordered Canonical NormalizedSegment list (resolving timezones, local dates, durations)
        ↓
ItineraryFingerprint hashes NormalizedSegment list to versioned SHA-256 fingerprint (stable under key/segment ordering, excludes volatile data)
        ↓
SegmentMatcher matches old to new segments using 4-tier confidence cascade (Duffel ID, Flight Key, Route & Time, Position Tie-Breaker)
        ↓
ItineraryDiff compares matched segments, connections, final arrival times to produce segment, connection, and slice shifts
        ↓
MaterialityClassifier checks incremental/cumulative diff against disruption-v1 ruleset (binary & strict threshold checks)
```

- **Functional Decoupling**: Pure core domain functions contain no framework, DB, or external API references. Inputs are fully typed structures; outputs are deterministic diff, fingerprint, and classification results.

### Disruption Synchronization & Concurrency (Phase 3)

```
Supplier Synchronization Run (Webhook or Cron trigger)
        ↓
SyncClaimService acquires claim lock (CAS write on syncLockedAt/syncLockToken; 5-min lease limit)
        ↓
DuffelService retrieves complete order (Remote API call executed OUTSIDE DB transactions)
        ↓
Prisma Transaction starts:
  ├─ Re-verify booking status (race handler: abort if no longer CONFIRMED)
  ├─ Re-verify lock token matches (prevent expired lease takeover issues)
  ├─ Compute Diff & Materiality (using Phase 2 domain core)
  ├─ Version check: if version exists & fingerprint matches → Converge Duplicate
  ├─ Version collision check: if version unique violation is thrown → Retry transaction with incremented version
  ├─ Daily outbox check: count sent notifications today (1st/2nd normal, 3rd with warning, 4th+ throttled & raises attention)
  └─ Save new revision/segments, update booking timing & status, create audit event & outbox row
        ↓
Conditional claim release (clears lock only if token matches)
```

- **Pessimistic Concurrency**: Prevents concurrent execution of sync tasks on the same booking using atomic DB updates.
- **Atomic Operations**: Guarantees database consistency by performing all writes, state transitions, and audit logging in a single, short database transaction.
- **Race and Collision Safety**: Ensures concurrent cancellations always win, and dynamic version collisions resolve gracefully by automatic retrying.

### Disruption Webhook Ingestion & Webhook Inbox Processing (Phase 4)

```
Duffel HTTP Webhook Request
        ↓
DuffelWebhookController receives POST /api/duffel/webhook
  ├─ Verify Feature Flag (FEATURE_FLAG_DISRUPTION_INGRESS)
  ├─ Verify Webhook Secret configured (DUFFEL_WEBHOOK_SECRET)
  ├─ Validate Signature (HMAC-SHA256 of timestamp + '.' + rawBody matches X-Duffel-Signature)
  ├─ Enforce Timestamp Tolerance (replays rejected if older than 5 minutes)
  ├─ Validate minimal envelope (id and type present)
  └─ Call DuffelInboxService.createEvent (Durable insert to DB)
        ↓
DuffelInboxService inserts event:
  ├─ Deduplicate: return existing event if supplierEventId matches (safe convergence)
  ├─ Catch unique constraint violation (P2002) for race condition safety
  ├─ SKIPPED: unsupported event types marked skipped immediately
  └─ PENDING: supported events marked pending (returns 200 fast-ack to Duffel without sync/external calls)

---

DuffelEventProcessor Cron (Every 10s via @Cron)
  ├─ Verify Feature Flag (FEATURE_FLAG_DISRUPTION_PROCESSOR)
  ├─ Claim Batch (leases up to N pending/retry-scheduled events)
  │     └─ CAS update using random token & status PROCESSING on duffelWebhookEvent
  ├─ Recover Stale Claims (PROCESSING events older than 5 minutes reverted and claimed)
  ├─ Process claimed batch concurrently and independently:
  │     ├─ Lookup local booking mapping by duffelOrderId
  │     ├─ If booking exists: invoke SupplierSyncService.syncBooking (runs Phase 3 sync transaction)
  │     ├─ Success: update event status to PROCESSED and clear payload
  │     └─ Failure: compute next retry backoff (1m, 5m, 15m, 15m) or escalate to FAILED_NEEDS_ATTENTION after 5th attempt
  └─ Retention job (runs daily): redact raw payloads older than 30 days to strip PII
```

- **Fast Webhook Acks**: Fast-acks immediately after durable DB insertion, avoiding slow sync operations and external API requests inline to prevent Duffel timeouts.
- **Asynchronous Leasing**: Employs compare-and-swap (CAS) logic with random tokens and status verification to safely lease events across multiple API instances.
- **Independent Processor Boundaries**: Batch failures are isolated; errors processing one webhook event do not impact or stall the execution of other events in the same batch.
- **PII-Safe Retention**: Redacts raw webhook payloads after 30 days to adhere to strict user privacy standards.

### Budget-Aware Reconciliation & Booking Completion (Phase 5)

```
Reconciliation Cron (Every 30m via @Cron or DUFFEL_RECONCILIATION_CRON)
  ├─ Verify Feature Flag (FEATURE_FLAG_DISRUPTION_RECONCILIATION)
  ├─ Complete stale bookings that have passed their final arrival
  │     └─ Fetch CONFIRMED bookings past currentFinalArrivalAt or departureAt
  │     └─ Transition status to COMPLETED and resolve active disruptions as RESOLVED with DEPARTURE_PASSED
  ├─ Fetch eligible bookings for synchronization (up to batch size DUFFEL_RECONCILIATION_BATCH_SIZE)
  │     ├─ Status CONFIRMED, non-null duffelOrderId
  │     ├─ nextUnflownDepartureAt in (now, now + 72 hours]
  │     ├─ nextDuffelSyncAt due (null or <= now)
  │     └─ syncLockedAt not active (null or < 5 minutes ago)
  ├─ Sort: lastDuffelSyncedAt ASC NULLS FIRST, nextUnflownDepartureAt ASC, id ASC
  ├─ For each booking:
  │     ├─ Enforce Monthly API Budget limits (Redis key `budget:duffel:YYYY-MM` vs DUFFEL_BUDGET_LIMIT_TOTAL)
  │     │     ├─ If budget exceeded: defer, record budgetBlocked metric
  │     │     └─ If budget OK: increment counter, call SupplierSyncService.syncBooking
  │     ├─ If SKIPPED_LOCKED or SKIPPED_INELIGIBLE: decrement budget counter back
  │     └─ If Sync Fails: increment failed counter, apply exponential backoff (15 * 2^(failures-1) minutes)
  └─ Return structured results: selected, processed, changed, unchanged, failed, deferred, stale, budgetBlocked
```

- **Stale Completion Sweep**: Resolves active disruptions and marks bookings completed atomically in database transactions after flights have landed.
- **Fair Batch Selection & Ordering**: Reconciliation order ensures bookings closer to departure or not synced recently are synchronized first.
- **API Budget Control**: Protects supplier integration limits by checking monthly API budget before processing each booking, preventing excessive charges.
- **Exponential Retry Backoff**: Prevents starve-out from repeating synchronization failures by scaling retry backoff exponentially.

### Traveller Disruption APIs & Lifecycle (Phase 6)

```
Booking List/Detail Read (GET /api/bookings and GET /api/bookings/:id)
  ├─ Verify Feature Flag (FEATURE_FLAG_DISRUPTION_SURFACING === 'true')
  ├─ Map:
  │    ├─ currentItinerary: Maps active itinerary revision segments (deserializes flat database columns to nested objects) or falls back to ORIGINAL flightSnapshot.
  │    └─ disruption: Maps active disruption revision diffs (isMaterial, incrementalSummary, cumulativeSummary, stabilizationWarning) or falls back to NONE status.
  └─ Return safe, PII-stripped response payload.

Traveller Disruption Actions (Acknowledge and Accept)
  ├─ POST /api/bookings/:bookingId/disruptions/:revisionId/acknowledge -> Transition DETECTED → ACKNOWLEDGED
  ├─ POST /api/bookings/:bookingId/disruptions/:revisionId/accept -> Transition DETECTED/ACKNOWLEDGED → RESOLVED (TRAVELLER_ACCEPTED)
  ├─ Validations:
  │    ├─ Owner validation (ensures only the booking traveler can execute actions)
  │    ├─ Active revision validation (checks that revisionId matches booking.activeDisruptionRevisionId)
  │    │     └─ Mismatch returns 409 Conflict with code 'STALE_DISRUPTION_REVISION'
  │    └─ Idempotency (same-revision retries return success status without re-transitioning)
  └─ Side Effects: Write safe DisruptionAuditEvent with TRAVELLER actor type and userId.

Booking Cancellation Disruption Resolution
  └─ Upon client cancel request, active disruption is resolved atomically to RESOLVED with reason BOOKING_CANCELLED.
```

- **Flat-to-Nested Mapping**: Decoupled database storage (flat columns in segment snapshots) from the customer-facing API contract (fully nested and clean representation).
- **Concurrency & Conflict Safeguard**: Rejects stale revision commands with `409 STALE_DISRUPTION_REVISION` to prevent users from accepting out-of-date flight changes when a newer change is available.
- **Traceable Audit Logging**: Writes audit events for all traveler-initiated lifecycle transitions capturing actor and trace details.

### AI Chatbot Agent Flow (SSE Streaming & Deterministic Handoff)

```
User sends message in chat interface
        ↓
Next.js UI → POST apps/agent:3002/chat/stream (Direct SSE streaming with correlation handling)
        ↓
FastAPI JWTAuthMiddleware validates JWT token (shared JWT_SECRET)
        ↓
FastAPI NemoGuardrailService runs safety checks (length, regex heuristics, Mimo safety classification)
        ├── Safety check FAILS/BLOCKED → Log security event, return error event and close stream
        └── Safety check PASSES ↓
            Agent checks conversation memory (loads history/summary from NestJS Chat API using X-Service-Auth)
                ↓
            Orchestrates LangGraph StateGraph agent (Router → Travel Assistant or Checkout Orchestrator)
                ↓
            Tokens fed into OutputGuardrailPipeline (accumulates tokens to sentences → concurrent lookahead regex scan & NeMo safety check)
                ├── Safety check FAILS/BLOCKED → Log security event, emit OUTPUT_GUARDRAIL_BLOCKED error, persist partial response, and close stream
                └── Safety check PASSES ↓
                    Safe chunks streamed back to frontend via SSE in real time (structured JSON latency & verdict logged per check)
                ↓
            If Checkout Intent:
                Checkout Orchestrator validates Trusted Search Snapshot, calls deterministic NestJS handoff service.
                NestJS issues short-lived handoff token → Agent emits ACTION_HANDOFF SSE event.
                Frontend parses handoffEvent, POSTs to CSRF-protected Next.js route, sets HttpOnly cookie, and redirects to clean checkout URL.
                ↓
            Upon completion, full conversation Turn persisted via NestJS Chat API (protected by X-Fencing-Token and AES-256-GCM encryption)
```

- **Browser Transport & Correlation (Direct-Only Lockdown)**: Chat clients stream directly to the public FastAPI agent endpoint (`apps/agent:3002/chat/stream`) via permanent direct-only SSE transport (`POST ${NEXT_PUBLIC_AGENT_URL}/chat/stream`). The legacy Next.js proxy route has been permanently decommissioned and removed (Phase 8D / T101). Both the Python Agent configuration and Next.js web client enforce fail-closed runtime validation against any decommissioned proxy flag (e.g. `FEATURE_FLAG_CHAT_DIRECT_STREAM='false'` or `NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM='false'`), throwing a startup/request initialization error. Independently sanitized opaque trace and correlation IDs propagate across browser, agent, and backend; the Python sanitizer is shared by SSE and the NestJS client, and a real loopback integration test verifies identical IDs in NestJS telemetry and audit persistence. Agent and API telemetry enforce per-field closed type/value schemas, fail open on emission failure, and use fixed event names; audit metadata never stores request/session/user/offer/message/token/passenger/payment/passport values.
- **Independent Handoff Gates**: The LLM remains read-only and never creates bookings. When users commit to a flight, the Checkout Orchestrator signals a deterministic NestJS handoff service to issue a token.
- **Secure Handoff Lifecycle**: The `ACTION_HANDOFF` SSE event delivers a hash-only token without URL or offer identifier. A native same-origin form adds the in-memory credential only while constructing the POST body; the bootstrap route validates a renderable safe checkout context, sets a short-lived root-scoped `HttpOnly; Secure; SameSite=Strict` cookie, and redirects to `/checkout/passengers`. The passenger page resolves server-side, and same-origin readiness/intent routes accept only allowlisted passenger inputs, inject the credential from the HttpOnly cookie, use bounded upstream calls, and clear the cookie at the same root scope only after successful intent creation. Tokens are strictly absent from URLs, DOM fields, readable storage, and telemetry.
- **Service-Authenticated Endpoints**: The Python Agent authenticates with the NestJS Chat API using a dedicated `X-Service-Auth` token rather than relying on user credentials or unauthenticated paths.
- **Encrypted Persistence & Cryptographic Audit**: Chat messages (`contentCiphertext`) and session titles (`titleCiphertext`) use strict record-bound AES-256-GCM authenticated encryption (zero fallback). Legacy plaintext columns `title` and `content` have been safely dropped from PostgreSQL (`20260805010000_chat_message_plaintext_cleanup`). Full database schema and raw SQL audits (`phase11d-cryptographic-audit.e2e-spec.ts`) verify 100% AES-256-GCM encryption, 100% SHA-256 hash-only handoff tokens (`tokenHash`, `selectionAttestationHash`, `duffelOfferIdHash`, `idempotencyKeyHash`), zero plaintext in resting stores, and 0 matches for sensitive privacy corpus.
- **Safe Booking Agent Projection**: Dedicated 1-to-1 table `booking_agent_projections` holds pre-computed, safe, allowlisted flight logistics (`agentReference`, `airline`, `origin`, `destination`, `departureAt`, `arrivalAt`, `durationMinutes`, `stopCount`, `flightNumber`, `baggageSummary`, `refundable`, `changeable`). Managed exclusively by NestJS `BookingAgentProjectionService`. Population occurs transactionally on booking confirmation (`CONFIRMED`), cancellation (`CANCELLED`), completion (`COMPLETED`), and failure (`FAILED`), and refreshes on supplier synchronization (`SupplierSyncService`), reconciliation (`ReconciliationService`), and Duffel webhooks (`DuffelEventProcessor`). References are high-entropy, opaque (`bkref_<uuid>`), and never derived from DB IDs. PII, passenger count, passport numbers, payment records, PNRs, financial fields, and raw snapshots are strictly excluded from the schema and queries.
- **Two-Tier Booking Read Tools**: The Python Travel Assistant uses exact two-tier privacy-minimized read tools: `list_user_booking_summaries` (queries `GET /api/agent-gateway/users/bookings/summaries` for tier-1 logistics with `bkref_...` opaque references) and `get_booking_detail` (queries `GET /api/agent-gateway/users/bookings/:bookingReference` for tier-2 on-demand flight numbers, baggage, and fare rules). Legacy broad booking tools (`list_user_bookings`) are completely removed. Outputs never contain financial data, PNRs, DB IDs, or passenger PII.
- **Signed Flight Search Attestation & Snapshot Isolation**: The versioned `POST /api/agent-gateway/v2/flights/search` endpoint validates active `ChatSession` ownership and emits HMAC-SHA256 selection attestations binding `userId`, `chatSessionId`, `snapshotVersion`, `issuedAt`, `expiresAt`, and ordered offers (`flightOfferId` + `duffelOfferId`). The Python `search_flights` tool atomically persists the `TrustedSearchSnapshot` into Redis with TTL bounded by offer freshness, while projecting strictly identifier-free 1-indexed results (zero offer UUIDs, zero provider IDs, zero attestation tokens) to the LLM. Legacy `GET /api/agent-gateway/flights/search` remains byte-for-byte unchanged and unenriched.
- **State-Only Checkout Signal Tool**: The Python Checkout Orchestrator agent utilizes exclusively the state-only, zero-I/O `signal_checkout_intent` tool. It strictly validates the user's selected flight index as a positive integer (1..N) against the active `trusted_snapshot` in `AgentState`, rejecting booleans, floats, non-integers, and out-of-bounds numbers. It returns a JSON signal (`{"signal": {"intent": "checkout", "offer_index": idx, "selected_index": idx}}`) for later deterministic state projection and executes ZERO network calls, database queries, Redis writes, Duffel requests, or token generation.
- **Cryptographic Chat Handoff Token Service**: The NestJS `ChatHandoffTokenService` provides high-entropy credential generation (`chk_handoff_v${keyVersion}_<base64url>`), server-derived idempotency hashing (`HMAC-SHA256(attestationDigest + ":" + selectedOfferIndex, secretKey)` where `attestationDigest = SHA-256(attestation)`), secure token hashing (`SHA-256(rawToken)`) for hash-only database persistence, and constant-time token verification via `crypto.timingSafeEqual`. It supports secret key versioning and rotation (`CHAT_HANDOFF_SECRET_V${version}` with fallback to `CHAT_HANDOFF_SECRET`) with full timing attack mitigation.
- **Deterministic Create & Resolve Handoff Service & Endpoints**: NestJS `ChatHandoffService` and `ChatHandoffController` provide service-authenticated (`POST /api/chat-handoff/tokens`, `POST /api/chat-handoff` guarded by `AgentApiKeyGuard` & `ClaimTokenGuard`) and user-authenticated (`POST /api/chat-handoff/resolve`, `POST /api/bookings/handoffs/resolve` guarded by `JwtAuthGuard`) handoff endpoints. Creation verifies selection attestations, resolves target offer IDs by index from attested offers, derives idempotency internally, converges on active unconsumed unexpired credentials on retry, and gates on `FEATURE_FLAG_CHAT_HANDOFF_ISSUE`. Resolution verifies owner, non-deleted session, unconsumed status, and offer freshness, returning safe allowlisted checkout context (`ChatHandoffSafeResolveResponse`) with `Cache-Control: no-store, private` while strictly excluding internal database IDs and token hashes.
- **Pre-Supplier Claim CAS Lease Protocol & Atomic Consumption**: In `BookingIntentService` and `BookingReadinessService`, token-only requests resolve flight offer and session context internally from the verified `ChatHandoff` record without accepting client `chatSessionId`. Prior to invoking Duffel or any supplier network call, an atomic PostgreSQL Compare-And-Swap (CAS) claim lease is acquired (`UPDATE chat_handoffs SET claimedAt = now, claimTokenHash = hash, claimExpiresAt = now + ttlMs WHERE ...`). Under high concurrency (100 parallel requests), exactly ONE request succeeds while all 99 losing requests fail fast (409 Conflict) with zero supplier or payment API calls. A background watchdog refreshes claim TTL periodically with supplier hard deadlines (25s) strictly buffered below lease TTL (30s). On recoverable supplier errors, claims are automatically released back to ACTIVE. Inside a single Prisma `$transaction`, unexpired claim ownership and active non-deleted `ChatSession` are revalidated before creating `BookingIntent` and transitioning `ChatHandoff` to `CONSUMED` with `consumedByBookingIntentId` linkage.
- **Rollback Matrix, Chaos Recovery & Continuous Privacy Governance**: The system enforces strict multi-phase rollout/rollback matrix governance (`ISSUE=false, ACCEPT=true` safely halts new credential minting while honoring active unexpired tokens; `MULTI_AGENT=false` safely falls back to single-agent Travel Assistant). Redis outages fail closed with HTTP 503 `CHAT_CONTROL_PLANE_UNAVAILABLE` before LLM inference, preventing unbudgeted compute. Upstream supplier timeouts safely execute `releaseClaim` in `finally` blocks, clearing claim locks back to NULL with zero orphaned locks. Monotonic session fencing tokens reject stale turn persistence during abrupt client disconnects. Continuous automated scanners across PostgreSQL, application logs, telemetry, and Redis verify 100% absence of raw tokens, plaintext chat, passport numbers, card numbers, PNRs, or supplier IDs.
- **Metadata-Only Action Card & Secure Chat Handoff (`BookingActionCard`)**: The Next.js frontend renders `BookingActionCard` upon receiving `ACTION_REQUIRED` SSE events. Payloads are strictly allowlisted by `parseActionRequiredEvent` to passenger types/ordinals, section names, field names, and non-sensitive reason codes with zero PII. Single-passenger incomplete profiles route to `/profile?returnTo=...` where the user completes profile fields outside chat, and a safe return banner with `autoResume=true` allows seamless resumption. Multi-passenger or inline flows route directly to `/checkout/passengers`. All return navigation is validated against `safeReturnTarget.ts` allowlists to prevent open redirect vulnerabilities.
- **Fencing Integration**: Concurrent writes are prevented through strict session ownership. The agent must acquire and propagate an `X-Fencing-Token`, and the NestJS backend enforces this write fence on all mutative chat operations.
- **Soft Deletion**: Chat sessions and messages are soft-deleted instead of hard-removed, preserving the relational structure and audit trails while stripping PII/ciphertext and hiding them from active queries.

---

## Containerization

A single `docker-compose.yml` file is located at the root of the project to orchestrate the database and cache services for local development:

- **PostgreSQL**: Version 16 (Alpine). Runs on host port `5432` with username `postgres`, password `postgres`, and database `flight_booking`. Persists database files using the `postgres_data` volume.
- **Redis**: Version 7 (Alpine). Runs on host port `6379`. Persists data using the `redis_data` volume.

To manage the services:

- Start services: `docker compose up -d`
- Stop services: `docker compose down`

---

## Invariants

The following are **architecture-specific** invariants that enforce the system design:

- **AI agents NEVER access PostgreSQL directly.** All agent data access goes through the agent-gateway, which strips PII and enforces scoped access.
- **JWT tokens MUST be validated on every protected endpoint.** No endpoint in the deterministic path is accessible without authentication.
- **Prisma migrations MUST be version-controlled and reviewed.** No ad-hoc schema changes in production.
- **Frontend components contain no business logic or direct API calls to external services.** All external communication goes through the NestJS backend.
- **Shared TypeScript types are the single source of truth.** Frontend and backend must use the same type definitions — never redefine them locally.
- **Traveler Profile PII must be encrypted using record-bound AES-256-GCM encryption.** All sensitive columns (like passport fields) must bind encryption to user/profile identifiers to prevent cross-record decryption or ciphertext substitution attacks.
- **Traveler Profile UI & Navigation must guarantee Zero PII leakage and strict open-redirect prevention.** Profile reads and updates strictly enforce `Cache-Control: no-store, private`, optimistic concurrency (CAS revision checks), and zero persistence in browser storage (`localStorage`/`sessionStorage`) or URLs. Navigation targets (`returnTo`) strictly validate against an allowlisted internal route set (`/`, `/dashboard`, `/search`, `/bookings`, `/checkout`, `/prototype/chat`), rejecting backslash evasions, protocol-relative URLs, schemes, and unallowlisted query parameters.
- **Chat persistence is 100% AES-256-GCM encrypted and token persistence is 100% SHA-256 hashed.** Zero plaintext content/title columns or raw token columns exist in the database. All decryption runs in fail-closed strict mode with zero plaintext fallback.
- **Chat transport is permanent direct-only streaming (`POST ${NEXT_PUBLIC_AGENT_URL}/chat/stream`).** Decommissioned proxy configurations fail fast and close immediately.
- **Data-quality backfills must use optimistic concurrency controls (CAS).** Schema migrations and data backfills must run in additive, non-destructive steps and abort if the validation/quarantine ratio exceeds safe thresholds.
- **Pull-Request CI triggers only on `development` target PRs with a single required `ci-status` summary check.** Change-aware routing deterministically executes only affected service chains, with all actions SHA-pinned, checkout credentials unpersisted, and Node/Python loopback network guards preventing live external API calls.

---

## Continuous Integration Pipeline

The repository uses a single GitHub Actions pull request CI workflow at `.github/workflows/ci.yml`:

- **Trigger & Concurrency**: Triggers exclusively on `pull_request` targeting `development` with `cancel-in-progress: true` keyed by PR number.
- **Security & Reproducibility**: Read-only repository permissions (`contents: read`), immutable 40-character action commit SHAs, line-ending normalization (`core.autocrlf=input` + `.gitattributes`), and zero token/credential persistence.
- **Loopback-Only Network Guards**: `node-network-guard.cjs` and `python/sitecustomize.py` restrict outgoing socket connections during CI test/build stages exclusively to loopback addresses (`127.0.0.1`, `::1`, `localhost`) to prevent unauthorized live provider access.
- **Change Detection & Routing**: `detect-changes` executes contract validation and actionlint, emitting string booleans for `api`, `web`, and `agent` via `dorny/paths-filter`.
- **Deterministic Test Commands**: API unit CI calls the explicit `test:ci` script rather than forwarding Jest flags through pnpm. Agent Redis coverage enforcement is applied only to the dedicated Redis-marked selection, so the non-Redis and Redis groups validate independently.
- **Correctness vs. Performance**: Blocking API E2E runs exclude `[.-]performance.e2e-spec.ts` wall-clock benchmarks, which remain available through the opt-in `test:e2e:performance` command for controlled benchmark environments.
- **Status Evaluation**: The terminal `ci-status` job runs `evaluate-ci-status.mjs` with `always()`, verifying that all relevant service jobs succeeded, irrelevant jobs were safely skipped, and detection ran cleanly. Branch protection requires only `ci-status`.

---

## Feature 019 — Architecture Deepening & Safety Rails

Feature 019 restructures high-leverage boundaries without changing public product behavior:
- **Slice 0 (Baseline Characterization & Safety Rails)**:
  - Establishes immutable automated characterization suites across `apps/api/test/characterization/`, `apps/agent/tests/characterization/`, and `apps/web/tests/characterization/` with 0 production business logic modifications.
  - Characterizes all 4 refund triggers (Inline, Webhook, Sweeper Cron, Admin Manual) to prove identical outcomes, status transitions, and balanced double-entry ledger records.
  - Characterizes booking lifecycle transitions (`createBooking`, `updateToConfirmed`, `updateToFailed`, `reconcileBookingIfStale`), tenant query isolation, and safe agent projection synchronization.
  - Characterizes all 6 read-only Agent Gateway capability endpoints, service auth guards, and PII-free allowlisted projections.
  - Characterizes Trusted Search Snapshot validation (contiguous 1-indexed results, extra forbid, TTL bound), repository lifecycle, and PII-free projections.
  - Characterizes all 8 authoritative SSE wire events (`token`, `tool_call`, `tool_result`, `flight_results`, `ACTION_HANDOFF`, `ACTION_REQUIRED`, `done`, `error`), canonical event sequencing, and terminal failure cleanup.
  - Characterizes Web search and booking flows, recording baseline static metrics for Client Component token props (`accessToken`), `NEXT_PUBLIC_API_URL`, and `forwardRef` dependencies.


