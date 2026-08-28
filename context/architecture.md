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
│   │   ├── src/                       → NestJS source code
│   │   │   ├── agent-gateway/         → Capability-local gateway umbrella & submodules
│   │   │   │   ├── attested-flight-search/ → V1/V2 search & HMAC selection attestations
│   │   │   │   ├── booking-readiness/     → Advisory readiness projection
│   │   │   │   ├── safe-booking-read/     → Tier-1 & Tier-2 safe booking projections
│   │   │   │   ├── traveler-preferences/  → PII-stripped preferences projection
│   │   │   │   ├── auth/                  → AgentAuthModule (API key & claim token guards)
│   │   │   │   └── audit/                 → AgentToolAuditModule (privacy-safe telemetry)
│   │   │   ├── booking/               → Pure umbrella BookingModule aggregating submodules
│   │   │   ├── booking-lifecycle/     → Provider-blind lifecycle transitions & recovery
│   │   │   ├── booking-management/    → Owner read models, disruption & revision queries
│   │   │   ├── cancellation/          → Cancellation quotes, locks & obligation generation
│   │   │   ├── chat/                  → Chat persistence & AgentChatController (JTI checks)
│   │   │   ├── payment/               → Payment processing & trigger coordinators
│   │   │   ├── refund/                → RefundTransactionService & capacity reservation
│   │   │   └── refund-settlement/     → Provider-blind atomic ledger & projection settlement
│   │   └── test/                      → API E2E & characterization spec tests
│   ├── agent/                         → Python/FastAPI agent service
│   │   ├── src/agent/                 → FastAPI source code
│   │   │   ├── chat_turn/             → ChatTurnRunner (causal cleanup) & event models
│   │   │   ├── trusted_search_snapshot/ → 3-key Redis protocol & safe projections
│   │   │   ├── graph/                 → LangGraph state machine & deterministic nodes
│   │   │   └── streaming/             → Thin SSE transport adapter & pre-stream admission
│   │   └── tests/                     → pytest unit, characterization & integration tests
│   └── web/                           → Next.js frontend UI service
│       ├── app/                       → Next.js App Router pages
│       │   ├── api/booking-management/ → Thin same-origin route handlers (private, no-store)
│       │   ├── bookings/              → Server Components rendering booking views
│       │   └── search/                → Server Actions executing flight searches
│       ├── lib/server/                → Server-only domain modules (flight-search, booking-management)
│       ├── components/                → React UI components (Zero-Client-Credential invariant)
│       └── tests/                     → Playwright UI browser & characterization tests
│
├── packages/
│   └── shared/                        → Shared library for types and constants
│       └── src/types/                 → Strict Zod schemas & inferred TypeScript types
│
├── tests/
│   ├── ci/                            → CI workflow contract & network guard tests
│   └── smoke/                         → Authoritative whole-stack smoke & sanity test harness
│
├── docs/
│   ├── adr/                           → Architectural Decision Records
│   └── runbooks/                      → Authoritative operational runbooks
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
    ├── templates/                     → Spec Kit templates
    └── scripts/                       → Setup and prerequisite scripts
```

## Build and Runtime Output

The root TypeScript configuration is type-check-only and sets `noEmit: true`. Package build configurations override that setting where runtime JavaScript is required: the API emits `apps/api/dist/main.js` for NestJS startup, and the shared package emits `packages/shared/dist` for the API's workspace imports. The API development command builds shared types first and then runs `nest start --watch`; inheriting the root `noEmit` setting prevents the API entrypoint from being created and causes a `dist/main` module-resolution failure.

---

## System Architecture & Module Ownership (Feature 019 Final State)

### High-Level System Overview Diagram

```mermaid
flowchart TD
    subgraph Browser["Browser / Client"]
        ClientUI["Next.js Client Components\n(Zero-Client-Credential Invariant)"]
    end

    subgraph WebServer["Next.js Web Service (apps/web)"]
        ServerActions["Server Actions\n(app/search/actions.ts)"]
        RouteHandlers["Same-Origin Route Handlers\n(app/api/booking-management/*)\nCache-Control: private, no-store"]
        ServerSeams["Server Domain Modules (import 'server-only')\n(lib/server/flight-search.ts)\n(lib/server/booking-management.ts)"]
    end

    subgraph AgentService["Python Agent Service (apps/agent:3002)"]
        ThinTransport["Thin SSE Transport Adapter\n(agent/streaming/sse.py)"]
        TurnRunner["ChatTurnRunner\n(agent/chat_turn/runner.py)\n[Causal 4-Step Cleanup Order]"]
        EventModels["Authoritative Wire Events\n(agent/chat_turn/events.py)\nConfigDict(extra='forbid')"]
        SnapshotLifecycle["TrustedSearchSnapshotLifecycle\n(agent/trusted_search_snapshot/)"]
    end

    subgraph RedisStore["Redis Store (:6379)"]
        RedisSnapshot["3-Key Snapshot Protocol\nchat:snapshot:{user}:{session}\n:version (issued)\n:accepted (tombstone/fence)"]
        RedisSessionLock["Session Fencing Locks\nchat:session-lock:{user}:{session}\n(X-Fencing-Token)"]
        RedisBudget["API Budget & Quota Counters\nbudget:duffel:* | chat:budget:*"]
    end

    subgraph NestJSBackend["NestJS API Service (apps/api:3001)"]
        subgraph GatewayModule["AgentGatewayModule (Pure Umbrella)"]
            AttestedSearchMod["AttestedFlightSearchModule\n(/v2/flights/search + HMAC)"]
            ReadinessMod["AgentBookingReadinessModule\n(/bookings/readiness)"]
            SafeBookingMod["SafeBookingReadModule\n(/users/bookings/summaries & :ref)"]
            PreferencesMod["TravelerPreferencesModule\n(/users/preferences)"]
            AuthMod["AgentAuthModule\n(ApiKey & ClaimToken Guards)"]
            AuditMod["AgentToolAuditModule\n(Negative-Privacy Telemetry)"]
        end

        subgraph ChatPersistence["ChatModule (Independent Persistence)"]
            AgentChatCtrl["AgentChatController\n(/agent-gateway/chat/*)"]
            AgentChatSvc["AgentChatAccessService\n(JTI Revocation & Fencing)"]
            ChatCore["ChatService\n(AES-256-GCM Encryption)"]
        end

        subgraph BookingSubmodules["Booking Domain (Zero Cycles to Payment)"]
            BookingUmbrella["BookingModule (Umbrella)"]
            BookingLifecycle["BookingLifecycleModule\n(BookingLifecycleService: create/confirm/fail)\n(BookingRecoveryService: sync/reconcile)"]
            BookingManagement["BookingManagementModule\n(BookingManagementService: list/detail/revisions)"]
            CancellationDomain["CancellationModule\n(CancellationService: quotes/locks/supplier-cancel)"]
        end

        subgraph PaymentAndSettlement["Payment & Settlement Domain"]
            PaymentMod["PaymentModule\n(PaymentService, PaymentRefundService,\nPaymentWebhookService, PaymentCronService)"]
            RefundTxMod["RefundModule\n(RefundTransactionService: capacity reservation)"]
            SettlementMod["RefundSettlementModule\n(RefundSettlementService: provider-blind settlement)"]
        end
    end

    subgraph PostgresDB["PostgreSQL 16"]
        DBBookings["bookings & itinerary_revisions"]
        DBObligations["cancellation_refund_obligations\n(Minor integer units)"]
        DBRefunds["refunds (Refund Transactions)"]
        DBLedger["ledger_entries\n(refundTransactionId FK, double-entry pairs)"]
        DBProjections["booking_agent_projections\n(PII-free bkref_* references)"]
        DBChat["chat_sessions & chat_messages\n(AES-256-GCM ciphertext)"]
    end

    subgraph ExternalSuppliers["External Third Parties"]
        StripeAPI["Stripe Payments & Refunds API"]
        DuffelAPI["Duffel Flights & Orders API"]
    end

    %% Browser to Web Server
    ClientUI -->|Server Action Invocation| ServerActions
    ClientUI -->|HTTP GET/POST same-origin| RouteHandlers
    ServerActions --> ServerSeams
    RouteHandlers --> ServerSeams
    ServerSeams -->|Private Bearer JWT / API_URL| NestJSBackend

    %% Browser to Agent Service (Direct-Only SSE)
    ClientUI -->|Direct SSE POST /chat/stream| ThinTransport
    ThinTransport --> TurnRunner
    TurnRunner --> EventModels
    TurnRunner --> SnapshotLifecycle

    %% Agent to Redis
    SnapshotLifecycle <-->|Atomic 3-Key Lua CAS| RedisSnapshot
    TurnRunner <-->|Fenced Session Leases| RedisSessionLock

    %% Agent to Gateway & Chat API
    TurnRunner -->|X-Service-Auth + Fencing| AgentChatCtrl
    SnapshotLifecycle -->|Fetch Attested Flights| AttestedSearchMod
    TurnRunner -->|Tool Invocations| GatewayModule

    %% NestJS Internal Wiring & Anti-Cyclic Flow
    CancellationDomain -->|Initiates Refund| PaymentMod
    PaymentMod -->|Transitions Status| BookingLifecycle
    PaymentMod -->|Reserves Capacity| RefundTxMod
    PaymentMod -->|Settles Verified Facts| SettlementMod
    RefundTxMod --> PostgresDB
    SettlementMod --> PostgresDB
    BookingLifecycle --> PostgresDB
    BookingManagement --> PostgresDB
    ChatCore --> PostgresDB

    %% External Interactions
    PaymentMod --> StripeAPI
    CancellationDomain --> DuffelAPI
```

### Subsystem 1: Payment & Refund Settlement Architecture

The payment and refund settlement domain provides deterministic, provider-blind settlement with balanced double-entry accounting:

1. **Provider-Blind Settlement Core (`RefundSettlementModule`)**:
   - `RefundSettlementService.settleVerifiedOutcome()` is a pure in-process deterministic operation with zero external network calls.
   - Idempotently verifies terminal payment/refund facts, writes balanced double-entry ledger reversal pairs (`DEBIT PLATFORM_REVENUE`, `CREDIT CUSTOMER_RECEIVABLE`), calculates derived status transitions (`PaymentStatus.REFUNDED` vs `PARTIALLY_REFUNDED`), and updates booking completion (`CANCELLED_AND_REFUNDED` only when cumulative obligation refunds meet obligation `totalAmount`).
   - Emits structured PII-safe `PaymentEvent` and `AuditLog` records with trace/correlation context.

2. **Cancellation Refund Obligations (`CancellationRefundObligation`)**:
   - Decouples the single customer cancellation debt from individual payment refund transactions.
   - Relational ownership: 1:1 with `Booking` (`onDelete: Cascade`), 1:N with `Payment` (`onDelete: Restrict`), and 1:N with `Refund` (Refund Transactions).
   - Amounts are stored strictly in integer minor units (`totalAmount`, `airlineRefundAmount`) to prevent floating-point rounding errors.

3. **Refund Transactions & Capacity Reservation (`RefundModule`)**:
   - `RefundTransactionService.reserveTransaction()` enforces brief interactive pessimistic locking (`SELECT ... FOR UPDATE` on Payment, then CancellationRefundObligation).
   - Dual-capacity reservation limits: Validates that active (`REFUND_PENDING`, `REFUND_PROCESSING`, `REFUND_RETRY_SCHEDULED`) plus succeeded refunds do not exceed either Payment `amount` or Obligation `totalAmount`.
   - Transaction-scoped idempotency key binding: Keys follow the format `cancellation-refund:${obligationId}:${attemptNumber}`, creating `Refund` rows in `REFUND_PENDING` before external money movement.

4. **Transaction-Linked Double-Entry Ledger Pairs**:
   - `LedgerEntry` links directly to `Refund` records via nullable `refundTransactionId` with compound uniqueness `@@unique([refundTransactionId, accountId, entryType])`.
   - Guarantees exactly one `DEBIT PLATFORM_REVENUE` and one `CREDIT CUSTOMER_RECEIVABLE` per refund transaction.

5. **Unified Trigger Pipeline**:
   - All four refund trigger paths (Inline Cancellation, Stripe Webhook, Background Sweeper Cron, Admin Manual Resolution) execute identically:
     1. Reserve transaction capacity via `RefundTransactionService.reserveTransaction()`.
     2. Execute external Stripe refund API call outside DB locks.
     3. Deliver verified facts to `RefundSettlementService.settleVerifiedOutcome({ provenance: { source } })`.

### Subsystem 2: Booking Submodules & Anti-Cyclic Architecture

To prevent architectural bloat and cyclic dependencies, the monolithic `BookingService` is decomposed into three cohesive, independent domain submodules:

1. **Booking Lifecycle Module (`BookingLifecycleModule`)**:
   - `BookingLifecycleService`: Pure provider-blind core handling booking state transitions:
     - `createBooking`: Transactional creation of `PROCESSING` booking with unique `bookingIntentId`.
     - `updateToConfirmed`: Transitions to `CONFIRMED` upon payment capture and Duffel order completion.
     - `updateToFailed`: Transitions to `FAILED` with non-retryable reason.
     - `applyPipelineOutcome`: Reconciles pipeline outcomes idempotently.
     - Terminal status guards: Enforces that `CONFIRMED`, `CANCELLED`, or `COMPLETED` bookings cannot be overwritten by stale failures.
   - `BookingRecoveryService`: Provider-aware stale booking recovery and background sweeps.

2. **Booking Management Module (`BookingManagementModule`)**:
   - `BookingManagementService`: Dedicated read and query domain for authenticated travelers:
     - `listBookings`: Paginated list filtered by upcoming/past tabs with passenger and flight summaries.
     - `getBookingDetail`: Full booking view with PNR, segments, baggage, and disruption alerts.
     - `getBookingRevisions`: Itinerary revision history and diff displays.
     - Tenant query isolation: Every query strictly filters by `userId` and maps Prisma models to safe view DTOs.
     - Zero payment or refund dependencies.

3. **Cancellation Module (`CancellationModule`)**:
   - `CancellationService`: Dedicated cancellation lifecycle orchestrator:
     - Cancellation status and quote generation (`POST /bookings/:bookingId/cancellation-quote`).
     - Optimistic quote locking via `PENDING_QUOTE` state with expiration deadlines.
     - Supplier cancellation execution with retries (`confirmCancellationWithRetries`) via `DuffelService`.
     - Creation of `CancellationRefundObligation` in integer minor units.
     - Disruption resolution: Atomically marks active disruptions `RESOLVED` with reason `BOOKING_CANCELLED`.
     - Downstream refund initiation: Delegates refund execution to `PaymentRefundService.processCancellationRefund()`.
     - Invariant: `CancellationService` never writes ledger entries or terminal financial statuses directly.

4. **Zero-Cycle Dependency Graph**:
   - Strict one-way acyclic module graph:
     - `BookingModule` (umbrella) $\rightarrow$ imports `BookingLifecycleModule`, `BookingManagementModule`, `CancellationModule`.
     - `CancellationModule` $\rightarrow$ imports `PaymentModule` (for `PaymentRefundService`).
     - `PaymentModule` $\rightarrow$ imports `BookingLifecycleModule` (for lifecycle status updates), `RefundModule`, `RefundSettlementModule`.
     - `BookingLifecycleModule` $\rightarrow$ 0 imports to `PaymentModule` or `CancellationModule`.
     - `BookingManagementModule` $\rightarrow$ 0 imports to `PaymentModule` or `CancellationModule`.
     - `PaymentModule` $\rightarrow$ 0 imports to `BookingModule` or `CancellationModule`.
   - Cyclic dependency count between Payment and Booking domains = **0**.

### Subsystem 3: Python Agent Architecture

The Python Agent (`apps/agent`) operates as a stateless conversational advisor with strict Redis control plane guarantees and causal failure cleanup:

1. **Trusted Search Snapshot Protocol (`apps/agent/src/agent/trusted_search_snapshot/`)**:
   - **Atomic 3-Key Redis Protocol**:
     1. Primary snapshot payload: `chat:snapshot:{userId}:{chatSessionId}`
     2. Issued version reservation: `chat:snapshot:{userId}:{chatSessionId}:version`
     3. Accepted version fence / tombstone: `chat:snapshot:{userId}:{chatSessionId}:accepted`
   - **Lua CAS Operations**:
     - `_NEXT_VERSION_LUA`: Allocates next monotonic version above both counter and stored snapshot.
     - `_REPLACE_SNAPSHOT_LUA`: Atomically validates version ordering ($incoming > effective\_accepted$) and updates payload, issued, and accepted keys.
     - `_DELETE_SNAPSHOT_LUA`: Deletes snapshot payload while retaining accepted version fence as a tombstone with remaining TTL, rejecting delayed or stale writes.
   - **Offer Freshness TTL**: Payload TTL is bounded by positive offer freshness ($\le 900s$).
   - **Safe Projections**:
     - `project_for_llm`: Generates contiguous 1-indexed results without provider UUIDs, Duffel IDs, or attestation signatures.
     - `project_for_browser`: Projects safe flight cards for frontend streaming.

2. **Chat Turn Runner & Causal Cleanup (`apps/agent/src/agent/chat_turn/`)**:
   - `ChatTurnRunner`: Transport-agnostic async generator producing authoritative `ChatTurnEvent` wire models (`ConfigDict(extra="forbid")`).
   - **Deterministic 4-Step Causal Cleanup Order (`_finalize_cleanup`)**:
     - **Step 1: Persist Safe Partial Turn**: If tokens were emitted and fence is valid, persists partial agent message via NestJS Chat API (`asyncio.shield` protected against cancellation, 1.0s fence check, 3.0s persistence timeout).
     - **Step 2: Finalize Output Guardrails**: Closes guardrail pipeline (`pipeline.aclose()`, 1.0s timeout).
     - **Step 3: Release Session Lease**: Releases Redis distributed lock (`queue_manager.release(session_id, req_id)`, 2.0s timeout).
     - **Step 4: Emit Terminal ErrorEvent**: Constructs typed `ErrorEvent` for client if caller is still attached.
   - **Fenced Lease Validation**: Agent propagates `X-Fencing-Token` acquired from Redis session lock; NestJS validates monotonic fencing on all turn persistence.
   - **Lifespan Shutdown Limits**: `agent.main:lifespan` tracks `active_runners: Set[asyncio.Task]`, gracefully cancels and awaits them within `SHUTDOWN_TIMEOUT_SECONDS=5.0s`, drains stream queues, and closes Redis.

### Subsystem 4: Web Server Seams & Zero-Client-Credential Boundary

The web layer (`apps/web`) establishes a strict server boundary protecting backend credentials and transport topology:

1. **Server Domain Modules (`apps/web/lib/server/`)**:
   - Protected with the `import 'server-only'` sentinel.
   - `flight-search.ts`: Acquires NextAuth session, resolves private `API_URL` (`API_URL || NEXT_PUBLIC_API_URL || 'http://localhost:3001'`), bounds requests with 10s timeout and 3-attempt exponential retry policy, validates responses with Zod, and normalizes into shared `FlightSearchOutcome`.
   - `booking-management.ts`: Acquires NextAuth session, resolves private `API_URL`, manages bounded retries (3 attempts on GET reads, fast-fail on POST mutations), validates responses with Zod, strips provider identifiers (Duffel IDs, Stripe IDs, raw snapshots), and normalizes into shared `BookingManagementOutcome`.

2. **Thin Same-Origin Route Handlers (`apps/web/app/api/booking-management/`)**:
   - 7 thin route handlers for interactive polling and mutations:
     - `GET /api/booking-management/bookings/[bookingId]`
     - `POST /api/booking-management/bookings/[bookingId]/cancellation-quote`
     - `GET /api/booking-management/bookings/[bookingId]/cancellation-status`
     - `POST /api/booking-management/bookings/[bookingId]/cancel`
     - `POST /api/booking-management/bookings/[bookingId]/disruptions/acknowledge`
     - `POST /api/booking-management/bookings/[bookingId]/disruptions/accept`
     - `GET /api/booking-management/bookings/[bookingId]/revisions`
   - Every handler enforces `export const dynamic = 'force-dynamic'`.
   - Every handler strictly enforces `Cache-Control: private, no-store`.
   - Maps shared domain failure reasons (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `STALE_REVISION`, `INVALID_COMMAND`, `UPSTREAM_UNAVAILABLE`) to standard HTTP status codes.

3. **Zero-Client-Credential Invariant**:
   - Client Components NEVER receive JWT access tokens, `NEXT_PUBLIC_API_URL`, or backend transport configuration via props, state, contexts, or hidden DOM fields.
   - Server Components render views with data fetched server-side; Client Components execute commands and polling exclusively through Server Actions or same-origin `/api/booking-management/` routes.
   - Static automated characterization audits verify 0 occurrences of `useSession`, `accessToken`, and `NEXT_PUBLIC_API_URL` across all booking management client components.

### Subsystem 5: Agent Gateway Capability Submodules & Chat Module Separation

The Agent Gateway decomposes the legacy monolithic service into isolated capability modules with negative-privacy telemetry and decoupled chat persistence:

1. **Four Isolated Capability Submodules (`apps/api/src/agent-gateway/`)**:
   - `AttestedFlightSearchModule`: Owns legacy search and versioned attested search (`POST /api/agent-gateway/v2/flights/search`) with HMAC-SHA256 selection attestation generation.
   - `AgentBookingReadinessModule`: Owns advisory readiness projection (`POST /api/agent-gateway/bookings/readiness`), internal profile resolution, safe ordinal mapping, and telemetry.
   - `SafeBookingReadModule`: Owns Tier-1 summaries (`GET /api/agent-gateway/users/bookings/summaries`) and Tier-2 details (`GET /api/agent-gateway/users/bookings/:bookingReference`) strictly projected from `BookingAgentProjection` with regex reference validation (`^bkref_...`), 404 tenant isolation, and temporarily retained legacy `/users/bookings`.
   - `TravelerPreferencesModule`: Owns allowlisted preference projection (`GET /api/agent-gateway/users/preferences`) querying Prisma `travelerProfile` without exposing passport PII.

2. **Supporting Infrastructure Modules**:
   - `AgentAuthModule`: Encapsulates and exports `AgentApiKeyGuard`, `ClaimTokenGuard`, and `ClaimTokenService`.
   - `AgentToolAuditModule`: `AgentToolAuditService` emits structured, negative-privacy telemetry (`toolName`, `outcome`, `durationMs`, `responseSizeBytes`, `occurredAt`, `errorCode`) to `AuditLog`, unconditionally discarding raw parameters, customer messages, passenger details, and provider IDs.

3. **Chat Persistence Ownership in `ChatModule` (`apps/api/src/chat/`)**:
   - `AgentChatController` and `AgentChatAccessService` handle `/agent-gateway/chat/*` persistence endpoints directly.
   - Injects `ChatService` with record-bound AES-256-GCM authenticated encryption.
   - Enforces user active status, expiration timestamp verification (`exp > NOW()`), and JTI revocation checking against Redis (`blacklist:jti:${dto.jti}`).
   - `ChatModule` has zero dependency on `AgentGatewayModule`.

4. **Pure Umbrella Composition (`AgentGatewayModule`)**:
   - `AgentGatewayModule` serves as an umbrella composition module importing and re-exporting the 4 capability submodules, `AgentAuthModule`, `AgentToolAuditModule`, and shared providers (`SelectionAttestationService`, `BookingAgentProjectionService`).
   - Obsolete `AgentGatewayService` and `AgentGatewayController` are completely deleted with zero remaining references.

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
- **Shared Agent Auth Module (`AgentAuthModule`)**: Encapsulates and exports `AgentApiKeyGuard`, `ClaimTokenGuard`, and `ClaimTokenService` with minimal `PrismaModule` dependency. Decouples cross-module agent authentication guards from the broad `AgentGatewayService`, eliminating circular module references with `ChatHandoffModule` and providing the isolated auth foundation for capability-local decomposition.
- **Privacy-Safe Agent Tool Audit Service (`AgentToolAuditService`)**: Emits structured, privacy-safe execution telemetry (`toolName`, `outcome: 'SUCCESS' | 'FAILURE'`, `durationMs`, `responseSizeBytes`, `traceId`, `correlationId`, `actorId`, `occurredAt`, `errorCode`) to `AuditLog`. Strictly enforces negative privacy protection: projects only allowlisted performance metrics while unconditionally discarding raw parameters, customer messages, passenger details, passport numbers, card numbers, or Duffel IDs. Provides graceful fallback UUID generation and fail-safe error isolation to prevent audit logging failures from interrupting agent tool operations.
- **Capability-Local Agent Gateway Submodules & Clean Composition (`apps/api/src/agent-gateway/`)**:
  - `AgentGatewayModule`: Serves as an umbrella composition module importing and re-exporting the 4 capability submodules, `AgentAuthModule`, `AgentToolAuditModule`, and transitional cross-module providers (`SelectionAttestationService`, `BookingAgentProjectionService`). Broad monolithic `AgentGatewayService` and `AgentGatewayController` are completely decommissioned and deleted with zero remaining references.
  - `AttestedFlightSearchModule`: Owns legacy search (`GET /api/agent-gateway/flights/search`) with Redis caching and V2 attested search (`POST /api/agent-gateway/v2/flights/search`) with HMAC-SHA256 selection attestation generation.
  - `AgentBookingReadinessModule`: Owns advisory readiness projection (`POST /api/agent-gateway/bookings/readiness`), internal profile resolution, safe ordinal mapping, and telemetry.
  - `SafeBookingReadModule`: Owns Tier-1 summaries (`GET /api/agent-gateway/users/bookings/summaries`) and Tier-2 details (`GET /api/agent-gateway/users/bookings/:bookingReference`) strictly projected from `BookingAgentProjection` with regex reference validation (`^bkref_...`), 404 tenant isolation, and temporarily retained legacy `/users/bookings`.
  - `TravelerPreferencesModule`: Owns allowlisted preference projection (`GET /api/agent-gateway/users/preferences`) querying Prisma `travelerProfile` without exposing passport PII.
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

### Subsystem 8: Whole-Stack Smoke & Sanity CI Pipeline

The whole-stack smoke and sanity test suite runs as a single `smoke-and-sanity` CI job in `.github/workflows/ci.yml` after all upstream gate, test, and build jobs pass. The suite uses pure `node:test` and built-in `fetch` for framework-agnostic black-box HTTP assertions against a fully running multi-service stack. Tests and helpers live under `tests/smoke/` and `scripts/ci/run-smoke-sanity.mjs`.

1. **CI Pipeline Graph & Routing**:
   - `detect-changes` evaluates changes via `dorny/paths-filter` and actionlint.
   - The `smoke-and-sanity` job is triggered whenever any application service path changes (`apps/api/**`, `apps/web/**`, `apps/agent/**`, `packages/shared/**`) or shared infrastructure changes (`docker-compose.yml`, `tests/smoke/**`, `scripts/ci/run-smoke-sanity.mjs`).
   - Terminal summary `ci-status` evaluates overall workflow status using `evaluate-ci-status.mjs` with `always()`, ensuring required gates succeeded and skips were intentional. Branch protection requires only `ci-status`.

2. **Loopback Provider Override Seams**:
   - Zero production bypasses or mock hooks in application logic. Production services cleanly accept loopback provider overrides:
   - **Duffel API Override**: `DUFFEL_API_URL` overrides default `https://api.duffel.com` in `DuffelService` (`apps/api/src/duffel/duffel.service.ts`). Instantiation validates `http:` or `https:` protocol and normalizes trailing slashes before passing `basePath` to `new Duffel({ token, basePath })`. Manual fetch calls in `createOrder` prepend `this.basePath`.
   - **Stripe API Override**: `STRIPE_API_URL` overrides default `https://api.stripe.com` in `StripeService` (`apps/api/src/common/stripe.service.ts`). Instantiation parses the URL, validates protocol (`http:` or `https:`), extracts hostname and optional port, and configures `new Stripe(apiKey, { apiVersion: '2026-05-27.dahlia', protocol, host, port })`. Absent environment variables strictly preserve production SDK endpoints.

3. **Cross-Service Health Topology**:
   - **FastAPI Agent Service**: Exposes `GET /health/live` as a lightweight, zero-inference, no-LLM endpoint that bypasses JWT and API key authentication to report immediate process liveness.
   - **Next.js Web Service**: Exposes `GET /health/upstream` (`apps/web/app/health/upstream/route.ts`) as a dynamic route handler (`force-dynamic`, `Cache-Control: private, no-store`) performing a bounded 2000ms server-to-server health ping to NestJS `GET /api/health/ping` via private `API_URL`.
   - **NestJS API Service**: Exposes `GET /api/health/agent` using `AgentHealthService` (`apps/api/src/health/agent-health.service.ts`), which pings FastAPI Agent `GET /health/live` with a bounded 2000ms timeout and sanitized error logging.

4. **Zero-Dependency Test Harness Architecture**:
   - **Readiness Polling (`tests/smoke/helpers/wait-for-ready.mjs`)**: Concurrently polls health endpoints for all services (Mock Server, NestJS API, FastAPI Agent, Next.js Web) with exponential backoff and a strict 120-second deadline. Hung probes cannot block teardown.
   - **Mock Provider Server (`tests/smoke/mocks/mock-server.mjs`)**: Pure `node:http` standalone server providing deterministic Duffel and Stripe fixtures on a loopback port. Enforces strict method/route routing, request body validation, and 404 responses on unknown routes with sanitized request logging.
   - **Test Utilities (`tests/smoke/helpers/test-utils.mjs`)**: Pure ES module utilities for generating unique test actors, creating auth bearer headers, signing HMAC-SHA256 user claim tokens (`signHmacClaimToken`), polling payment statuses (`pollPaymentStatus`), and enforcing centralized redaction (`redactSensitive`).
   - **Lifecycle Orchestrator (`scripts/ci/run-smoke-sanity.mjs`)**: Central execution harness that coordinates child process spawning (Mock, API, Agent, Web), manages PID/process-group ownership across POSIX and Windows, streams diagnostic logs to `.smoke-diagnostics/<run-id>/`, executes smoke checks before sanity tests (skipping sanity on smoke failure), and enforces fail-safe bounded cleanup on exit, SIGINT, or SIGTERM.

---

## Feature 019 — Architecture Deepening & Safety Rails

### Slice 5A — Narrow Shared Contracts for Web Server Seams

- `packages/shared/src/types/flight-search.types.ts` owns strict Zod schemas and inferred types for server-seam Flight Search query, provider-free offer/slice/segment views, metadata, and search/selection outcomes. Browser offers expose only an opaque local `id`; raw Duffel offer identifiers are rejected by strict parsing.
- `packages/shared/src/types/booking-management.types.ts` owns strict prepared owner views and generic `BookingManagementOutcomeSchema(dataSchema)`. It preserves local booking/revision references, PNR, flight details, passenger names, ancillary summaries, cancellation facts, and disruption displays while rejecting Stripe IDs, Duffel order/quote/segment IDs, provider payloads, and raw snapshots.
- Both outcome families use explicit `ok` discriminants and allowlisted error reasons. `packages/shared/src/types/index.ts` exports the contracts, and the package root re-exports that stable type surface for web and API consumers.

### Slice 5B — Flight Search Server Seam

- `apps/web/lib/server/flight-search.ts` is the Flight Search server-only transport owner. It obtains the NextAuth session itself, resolves `API_URL || NEXT_PUBLIC_API_URL || http://localhost:3001` only on the server, injects the bearer credential, bounds requests with a timeout and three-attempt exponential retry policy, validates NestJS responses with Zod, and normalizes every result into the shared discriminated outcome contracts.
- `apps/web/app/search/actions.ts` provides the colocated Next.js Server Actions. Search rendering calls the typed action boundary only; `SearchFormClient` receives and stores `FlightSearchOfferView` values containing an opaque local offer ID and display fields, never a JWT, backend URL, provider payload, Duffel identifier, or retry policy.
- Offer selection revalidates the opaque offer server-to-server and returns the contractually specified encoded checkout path. The server module is protected with the `server-only` sentinel so it cannot be imported into the browser bundle.
- Playwright uses a loopback Flight Search fixture through private `API_URL` for Server Action coverage. The scoped static characterization audit rejects credential, public transport, direct-fetch, provider/raw payload, and retry-policy markers in the search rendering tree.

### Slice 5C — Booking Management Server Seam & Client Token Removal

- `apps/web/lib/server/booking-management.ts` is the Booking Management server domain module. It obtains the NextAuth session, resolves private `API_URL`, injects bearer credentials, manages bounded retry/timeout policies (3 bounded attempts on GET reads, fast-fail on POST mutations), validates upstream NestJS responses with Zod, maps typed error reasons (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `STALE_REVISION`, `INVALID_COMMAND`, `UPSTREAM_UNAVAILABLE`), and prepares views stripping Stripe IDs, Duffel order IDs, and raw snapshots while preserving owner-facing PNR, status, and itinerary facts. Protected with `import 'server-only'`.
- `apps/web/app/api/booking-management/` provides 7 thin same-origin Route Handlers:
  - `GET /api/booking-management/bookings/[bookingId]`
  - `POST /api/booking-management/bookings/[bookingId]/cancellation-quote`
  - `GET /api/booking-management/bookings/[bookingId]/cancellation-status`
  - `POST /api/booking-management/bookings/[bookingId]/cancel`
  - `POST /api/booking-management/bookings/[bookingId]/disruptions/acknowledge`
  - `POST /api/booking-management/bookings/[bookingId]/disruptions/accept`
  - `GET /api/booking-management/bookings/[bookingId]/revisions`
  - Every handler strictly enforces `Cache-Control: private, no-store` and maps failure reasons to standard HTTP status codes.
- `apps/web/app/bookings/page.tsx` and `apps/web/app/bookings/[bookingId]/page.tsx` render Server Components using `listBookings` and `getBookingDetail` without receiving or forwarding JWT tokens or backend URLs to the browser.
- Client Components (`BookingCard.tsx`, `BookingDetail.tsx`, `ItineraryRevisionHistory.tsx`) are completely decoupled from `useSession`, `accessToken`, `process.env.NEXT_PUBLIC_API_URL`, and direct NestJS fetches. All interactive mutations and reads route through same-origin `/api/booking-management/...` endpoints.
- Scoped characterization and static privacy audits verify zero `useSession`, zero `accessToken`, and zero `NEXT_PUBLIC_API_URL` leakage across all 13 booking management files.

Feature 019 restructures high-leverage boundaries without changing public product behavior:

- **Slice 0 (Baseline Characterization & Safety Rails)**:
  - Establishes immutable automated characterization suites across `apps/api/test/characterization/`, `apps/agent/tests/characterization/`, and `apps/web/tests/characterization/` with 0 production business logic modifications.
  - Characterizes all 4 refund triggers (Inline, Webhook, Sweeper Cron, Admin Manual) to prove identical outcomes, status transitions, and balanced double-entry ledger records.
  - Characterizes booking lifecycle transitions (`createBooking`, `updateToConfirmed`, `updateToFailed`, `reconcileBookingIfStale`), tenant query isolation, and safe agent projection synchronization.
  - Characterizes all 6 read-only Agent Gateway capability endpoints, service auth guards, and PII-free allowlisted projections.
  - Characterizes Trusted Search Snapshot validation (contiguous 1-indexed results, extra forbid, TTL bound), repository lifecycle, and PII-free projections.
  - Characterizes all 8 authoritative SSE wire events (`token`, `tool_call`, `tool_result`, `flight_results`, `ACTION_HANDOFF`, `ACTION_REQUIRED`, `done`, `error`), canonical event sequencing, and terminal failure cleanup.
  - Characterizes Web search and booking flows, recording baseline static metrics for Client Component token props (`accessToken`), `NEXT_PUBLIC_API_URL`, and `forwardRef` dependencies.
- **Slice 1 (Unified Refund Settlement & Obligation Contract)**:
  - **Slice 1A (Additive PostgreSQL/Prisma Schema Expansion)**: Introduced `CancellationRefundObligation` model, `refundTransactionId` on `LedgerEntry`, and double-entry ledger constraints. Added restart-safe backfill script.
  - **Slice 1B (Reservation & Provider-Blind Settlement Core)**: Added `RefundTransactionService` with strict Payment-first pessimistic locking and capacity checks, and `RefundSettlementService` for in-process atomic ledger and projection settlement.
  - **Slice 1C (Trigger Path Cutover)**: Unified all 4 refund paths (Inline, Webhook, Sweeper Cron, Admin Manual) to route exclusively through unified reservation and settlement with transaction-scoped idempotency keys.
  - **Slice 1D (Contract Schema & Gate 1 Sign-Off)**: Contract migration `20260823000000_refund_obligation_contract` removes legacy `Refund.bookingId` and `Booking.cancellationRefund` columns/relations and enforces obligation linkage constraints on cancellation refunds. Runbook documented in `docs/runbooks/refund-settlement-migration.md`. Feature 019 Gate 1 100% green.
- **Slice 2 (Booking Lifecycle, Management, and Cancellation)**:
  - **Slice 2A (Extract Provider-Blind Booking Lifecycle Core)**: Extracted `createBooking`, `updateToConfirmed`, `updateToFailed`, `applyPipelineOutcome`, and flight completion checking into `BookingLifecycleService` (`apps/api/src/booking-lifecycle/`). Extracted provider-aware stale recovery and background sweeps into `BookingRecoveryService`.
  - **Slice 2B (Extract Booking Management Module)**: Extracted read and query capabilities (`listBookings`, `getBookingDetail`, `mapDisruptionAndItinerary`, `sortBookings`, `toListItem`, and ancillary summary mapping) into `BookingManagementService` (`apps/api/src/booking-management/`). Rewired `BookingController` to inject `BookingManagementService` directly for `GET /bookings` and `GET /bookings/:bookingId` while preserving response DTO shapes, tenant isolation, and transitional delegation in `BookingService`.
  - **Slice 2C (Extract Cancellation Module)**: Extracted cancellation status, quote generation, optimistic quote locking (`PENDING_QUOTE`), supplier-first cancellation execution with retries (`confirmCancellationWithRetries`), remote Duffel order recovery (`retrieveOrder`), `CancellationRefundObligation` creation (minor units), active disruption resolution (`BOOKING_CANCELLED`), and downstream refund initiation via `PaymentRefundService` into `CancellationService` (`apps/api/src/cancellation/`). Rewired `BookingController` to inject `CancellationService` directly for `@Get(':bookingId/cancellation')`, `@Post(':bookingId/cancellation-quote')`, and `@Post(':bookingId/cancel')`, while providing transitional delegation in `BookingService`. Invariant maintained: `CancellationService` never performs direct ledger or terminal settlement writes (strictly owned by `RefundSettlementService`).

- **Slice 3A (Trusted Search Snapshot Lifecycle Core)**:
  - **Canonical ownership**: `apps/agent/src/agent/trusted_search_snapshot/` owns the strict Pydantic domain models, owner-scoped lifecycle orchestration, Redis persistence, graph-state normalization, and safe LLM/browser projections. NestJS remains the sole HMAC verifier and handoff-token issuer; this slice does not migrate existing callers.
  - **Model and lifecycle guarantees**: `SnapshotOwner`, `AttestedSearchEnvelope`, `TrustedSearchSnapshot`, `ResolvedOfferSelection`, `SafeSearchResult`, and `SafeFlightResult` enforce `extra="forbid"`, non-empty owner/attestation data, positive versions, contiguous 1-based result indices, monotonic snapshot versions, and timezone-aware UTC expiry. Selection validates bounds and active expiry; graph normalization accepts legacy `snapshot`/`trusted_snapshot`, `version`/`snapshotVersion`, `attestation`/`selectionAttestation`, and `offers`/`results` aliases.
  - **Repository guarantees**: `TrustedSnapshotRepository` uses the required owner-scoped payload key `chat:snapshot:{user_id}:{chat_session_id}` plus private issued-version (`:version`) and accepted-version/tombstone (`:accepted`) keys. Lua allocation reserves an issued version; one successful save promotes that reservation into the accepted boundary and payload atomically. Delete removes the payload while retaining/advancing the accepted tombstone, so delayed work cannot write an invalidated version; its recovery path removes corrupt payloads and clears malformed private state while retaining valid accepted fences. Incoming versions less than or equal to the accepted boundary are rejected, and payload TTL is bounded by positive offer freshness and the `max_ttl` cap; expired snapshots are not stored.
  - **Privacy and compatibility boundary**: `project_for_llm` and `project_for_browser` are explicit PII/provider-ID-free projections and never expose Duffel IDs, local offer IDs, signatures, fingerprints, user IDs, or session IDs. `ResolvedOfferSelection` remains lifecycle-internal. Legacy `agent.models.snapshot` and `agent.repositories.trusted_snapshot_repository` paths re-export the canonical classes; no existing caller migrations are included in Slice 3A.
- **Slice 3B (Cut Over Callers to TrustedSearchSnapshotLifecycle & Decommission Legacy Shims)**:
  - **Tool caller cut-over**: `search_flights.py` creates and saves search snapshots via `TrustedSearchSnapshotLifecycle.create_or_replace(owner, envelope)` and renders model summaries with `lifecycle.project_for_llm(snapshot)`. `signal_checkout_intent.py` normalizes state via `lifecycle.normalize_graph_state()` and performs zero-I/O bound checks.
  - **Graph and streaming cut-over**: `checkout_gate.py` normalizes state and validates active snapshots; `nodes.py:validate_handoff` and `create_handoff_token` resolve offer selection strictly through `lifecycle.select()`, extracting allowlisted display fields from `ResolvedOfferSelection.offer` and forwarding canonical attestations to NestJS. `sse.py` loads active snapshots via `lifecycle.load_active(owner)` and projects browser flight results via `lifecycle.project_for_browser()`.
  - **Legacy shim decommissioning**: Completely deleted `agent/models/snapshot.py` and `agent/repositories/trusted_snapshot_repository.py`. Removed `project_snapshot_results` and `_SAFE_LLM_FIELDS` from `search_flights.py`. Replaced all test imports across `apps/agent/tests/` with `agent.trusted_search_snapshot`.
  - **Established verification**: 423 passed in agent pytest suite (1 deselected), ruff lint/format clean (114 files clean), 0 occurrences of legacy shim paths in static grep audit. Standards and spec review 100% green with 0 remaining P0/P1 issues.
- **Slice 4A (Authoritative Chat Turn Event Models & Golden Contract Tests)**:
  - **Authoritative Event Models**: Created canonical `apps/agent/src/agent/chat_turn/events.py` establishing strict Pydantic v2 payload models (`extra="forbid"`) and tagged event models for all 8 wire events (`token`, `tool_call`, `tool_result`, `flight_results`, `ACTION_HANDOFF`, `ACTION_REQUIRED`, `done`, `error`), along with the discriminated union `ChatTurnEvent` and helper `format_sse()`.
  - **Streaming Integration**: Updated `apps/agent/src/agent/streaming/sse.py` to construct typed `ChatTurnEvent` instances across all event production and error paths, serializing them deterministically in `sse_generator`.
  - **Backwards Compatibility Re-exports**: Re-exported all canonical event types in `apps/agent/src/agent/models/events.py` while preserving legacy types (`DisplayInfo`, `HandoffEvent`, `BaseSSEEvent`) with `extra="forbid"`.
  - **Golden Contract Tests**: Added `apps/agent/tests/test_chat_turn_events.py` verifying serialization, `extra="forbid"` rejection on all payloads and wrappers, `handoffToken` isolation strictly in `ActionHandoffPayload`, exact SSE formatting, `TypeAdapter(ChatTurnEvent)` discriminated union parsing, and zero PII leakage.
  - **Established verification**: 431 passed in full agent pytest suite, 15/15 SSE characterization passed, 15/15 snapshot characterization passed, ruff lint/format 100% green (117 files clean). Standard and spec reviews passed with 0 remaining P0/P1 issues.
- **Slice 4B (Extract ChatTurnRunner in Causal-Cleanup Order)**:
  - **Transport-Agnostic Runner**: Implemented `ChatTurnCommand` and `ChatTurnRunner` under `apps/agent/src/agent/chat_turn/`, extracting session creation, memory/snapshot loading, fenced lease management, LangGraph event stream interpretation, output guardrails, and persistent turn finalization into a pure async generator `run(command) -> AsyncIterator[ChatTurnEvent]`.
  - **Causal Failure Cleanup Ordering**: Enforced deterministic 4-step sequence (`_finalize_cleanup`): persist safe partial turn if tokens were emitted $\rightarrow$ finalize/close output guardrails (`pipeline.aclose()`) $\rightarrow$ release owned session lease (`queue_manager.release()`) $\rightarrow$ yield terminal `ErrorEvent`. Shielded persistence prevents partial message loss during client disconnects.
  - **Monotonic Fencing Protection**: Re-validates active lease fence prior to pre-persistence, handoff token emission, action-required events, and batch completion to prevent cross-turn database corruption or zombie action emissions.
  - **Established verification**: 10/10 unit tests passing in `apps/agent/tests/test_chat_turn_runner.py`, 430/430 full agent test suite passing (11 deselected), ruff lint/format 100% green (120 files clean). Standards and spec code reviews approved with 0 P0/P1 issues.
- **Slice 4C (Thin Transport Adapter and Graceful Runner Shutdown — US4 Complete)**:
  - **Thin Transport Boundary**: Reduced `apps/agent/src/agent/streaming/sse.py` to a thin HTTP transport layer (from ~880 down to 283 lines). Retained HTTP pre-stream admission (JWT validation, NestJS user access verification, length check, ingress PII detection, NeMo safety check, Redis quota & rate limiting) and delegated turn execution entirely to `ChatTurnRunner`.
  - **Client Disconnect & Lifespan Shutdown**: Added active runner task tracking (`active_runners: Set[asyncio.Task]` in `agent.main`), client disconnect detection (`request.is_disconnected()`), generator cleanup on exit (`generator.aclose()`), and graceful cancellation/await in application lifespan shutdown within a 5.0s bounded timeout.
  - **Established verification**: 20/20 unit tests in `apps/agent/tests/test_sse.py`, 452/452 full agent test suite passing (11 deselected), 15/15 web acceptance tests passing, ruff lint/format 100% green (121 files clean). Standards and spec code reviews approved with 0 P0/P1 issues.
- **Slice 6A (Agent Gateway Shared Auth & Safe Audit Module)**:
  - Extracted `AgentAuthModule` (`agent-auth.module.ts`) encapsulating and exporting `AgentApiKeyGuard`, `ClaimTokenGuard`, and `ClaimTokenService`.
  - Implemented `AgentToolAuditService` enforcing negative privacy enforcement with allowlisted metrics (`toolName`, `outcome`, `durationMs`, `responseSizeBytes`, `occurredAt`, `errorCode`).
- **Slice 6B (Extract Capability-Local Agent Gateway Modules)**:
  - Extracted tool families into 4 capability-local modules (`AttestedFlightSearchModule`, `AgentBookingReadinessModule`, `SafeBookingReadModule`, `TravelerPreferencesModule`).
  - Reduced `AgentGatewayService` dependencies and decoupled tool executions into their owning modules.
- **Slice 6C (Move Agent Chat Ownership to ChatModule)**:
  - **Chat-Owned Agent Persistence**: Extracted all `/agent-gateway/chat/...` endpoints into `AgentChatController` and `AgentChatAccessService` in `apps/api/src/chat/`, injecting `ChatService` directly without intermediate gateway layers.
  - **Access & Revocation Verification**: `AgentChatAccessService` handles user active status, expiration timestamp verification (`exp > NOW()`), and JTI revocation checking against Redis (`blacklist:jti:${dto.jti}`).
  - **Zero Protocol & Cryptographic Drift**: Maintained 100% wire-path, status-code, `X-Fencing-Token` header propagation, and AES-256-GCM record-bound authenticated encryption compatibility.
  - **Gateway↔Chat Decoupling**: Completely removed `ChatModule` from `AgentGatewayModule` imports and stripped chat delegation methods from `AgentGatewayService`.
- **Slice 6D (Delete Broad Agent Gateway Service & Finalize Module Composition)**:
  - **Decommission Monolithic Files**: Fully deleted obsolete `AgentGatewayService`, `AgentGatewayController`, and `agent-gateway.service.spec.ts`.
  - **Clean Umbrella Module Composition**: Refactored `AgentGatewayModule` into an umbrella composition module importing and re-exporting capability submodules (`AttestedFlightSearchModule`, `AgentBookingReadinessModule`, `SafeBookingReadModule`, `TravelerPreferencesModule`, `AgentAuthModule`, `AgentToolAuditModule`) alongside external consumer providers (`SelectionAttestationService`, `BookingAgentProjectionService`). Eliminated unused `CacheModule` and empty `controllers` array.
  - **Zero Production References**: Monorepo static audit confirmed exactly 0 remaining references to `AgentGatewayService` and `AgentGatewayController`.
  - **Comprehensive Verification**: 7 capability unit suites (82/82 tests PASS), 3 gateway/characterization E2E suites (75/75 tests PASS), full Python agent pytest suite (455/455 tests PASS), and clean ESLint/TypeScript compilation across the entire monorepo.
