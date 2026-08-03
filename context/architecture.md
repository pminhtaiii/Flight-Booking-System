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
- **Passenger source boundary**: Canonical intent passengers use a nested discriminated `source` union (`traveler_profile` with `travelerProfileId` plus `expectedProfileRevision`, or complete `inline` identity/contact data). `PassengerSourceResolverService` owner-scopes profile reads by `{id,userId}`, rejects stale revisions with `PROFILE_CHANGED`, returns detached normalized values with provenance, and performs no writes, audits, supplier calls, or profile mutations. The legacy flat shape remains internal to the unchanged pre-Phase-8 create transaction only; canonical source payloads reject flat fields and `useProfile + source` conflicts.
- **Immutable passenger snapshots**: `PassengerSnapshotService` preallocates existing zero-based positions before building `BookingIntentPassengerCreateManyInput` rows. It validates complete identity/contact data and atomic international document groups, preserves date-only values and Duffel IDs, encrypts passport number/expiry with existing versioned AES-GCM AAD `{snapshotVersion,intentId,position,fieldName}`, retains only nullable profile provenance, and returns masked summaries that exclude passport, expiry, email, phone, raw sources, and profile IDs. The service is transaction-compatible but is not wired into the current create orchestration until Phase 8.
- **Observability boundary**: Advisory outcomes emit structured API events with sanitized trace/correlation identifiers and allowlisted aggregate metadata only; observability failures cannot change the endpoint result.

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

### AI Chatbot Agent Flow (SSE Streaming)

```
User sends message in chat interface
        ↓
Next.js UI → POST apps/agent:3002/chat/stream (SSE streaming)
        ↓
FastAPI JWTAuthMiddleware validates JWT token (shared JWT_SECRET)
        ↓
FastAPI NemoGuardrailService runs safety checks (length, regex heuristics, Mimo safety classification)
        ├── Safety check FAILS/BLOCKED → Log security event, return error event and close stream
        └── Safety check PASSES ↓
            Agent checks conversation memory (loads history/summary from NestJS Chat API)
                ↓
            Orchestrates LangGraph StateGraph agent with Mimo model and read-only tools (search_flights, get_user_preferences, list_user_bookings) via NestJS Agent Gateway
                ↓
            Tokens fed into OutputGuardrailPipeline (accumulates tokens to sentences → concurrent lookahead regex scan & NeMo safety check)
                ├── Safety check FAILS/BLOCKED → Log security event, emit OUTPUT_GUARDRAIL_BLOCKED error, persist partial response, and close stream
                └── Safety check PASSES ↓
                    Safe chunks streamed back to frontend via SSE in real time (structured JSON latency & verdict logged per check)
                ↓
            Upon completion, full conversation Turn persisted via NestJS Chat API
```

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
- **Data-quality backfills must use optimistic concurrency controls (CAS).** Schema migrations and data backfills must run in additive, non-destructive steps and abort if the validation/quarantine ratio exceeds safe thresholds.
