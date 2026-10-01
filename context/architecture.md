# Architecture

## Status

This document defines the core and intended system architecture for the Flight Booking System.

Runtime behavior must not be assumed implemented merely because it appears here. `context/progress-checker.md` and `context/active-feature.md` are the source of truth for implementation status. Historical feature change logs and release notes are archived in `docs/history/architecture-archive.md`.

---

## System Topology

The Flight Booking System is organized as a multi-service monorepo with strict process, port, and security boundaries:

```text
               +-------------------------------------------+
               |          Next.js Web Frontend             |
               |        (App Router, Port 3000)            |
               |   - Server Components & Route Handlers    |
               |   - backendClient (zero browser creds)    |
               +--------------------+----------------------+
                                    |
            +-----------------------+-----------------------+
            | HTTP / Session JWT                            | HTTP / SSE Stream
            v                                               v
+-------------------------------+               +-------------------------------+
|         NestJS API            |               |      Python Agent Service     |
|   (Backend, Port 3001)        |               |   (FastAPI / LangGraph, 3002) |
| - Modular Monolith Domain     | <-----------+ | - TurnSessionCoordinator      |
| - Capability Gateway Endpoints|  Service Key  | - Admission (Auth/PII/Quota)  |
| - Transactional DB & Ledger   |  & HMAC Claim | - Memory & Tool Resolution    |
+---------------+---------------+               +---------------+---------------+
                |                                               |
        +-------+-------+                               +-------+-------+
        |               |                               |               |
        v               v                               v               v
+---------------+ +---------------+             +---------------+ +---------------+
|  PostgreSQL   | |     Redis     | <-----------+ |  PostgreSQL   | |  OpenAI /     |
|  (Port 5432)  | |  (Port 6379)  |  Cache/Fences |  (Direct Read | |  Mimo API     |
| Prisma ORM    | | Budget & Rate |               |   Deferred)   | | LLM Engine    |
+---------------+ +---------------+             +---------------+ +---------------+
        |               |
        v               v
+---------------+ +---------------+
|  Duffel API   | |  Stripe API   |
| Supplier SDK  | | Payment / Web |
+---------------+ +---------------+
```

---

## Stack

The following is the authoritative technology baseline. Technology changes require an explicit Architectural Decision Record (ADR) and must preserve documented boundary contracts.

| Layer | Tool / Technology | Purpose |
| --- | --- | --- |
| Languages | TypeScript (strict), Python 3.11+ | TS for Web/API, Python for conversational agent |
| Frontend | Next.js 14 App Router, React 18, Tailwind CSS | SSR, Server Components, client state isolation |
| Backend API | NestJS 10, Express, TypeScript | Transactional business logic, auth, booking fulfillment |
| Agent Engine | FastAPI, LangGraph, LangChain, Pydantic v2 | Conversational workflow, tool interpretation, guardrails |
| Database & ORM | PostgreSQL 16, Prisma ORM | Relational authority for users, bookings, payments, audit |
| Cache & Budgets | Redis 7 (`ioredis`, `redis-py`) | Search cache, seat map catalog, atomic rate budget Lua |
| Auth & Sessions | NextAuth.js (Auth.js) + JWT | Session cookies; HMAC-signed internal claim tokens |
| Flight Supplier | Duffel API (`@duffel/api` SDK singleton) | Search, ancillaries, orders, ticketing behind budget |
| Payments | Stripe API (Payment Intents, Webhooks) | PCI-DSS compliant payment processing and refunds |
| Testing | Vitest, Jest, Pytest, Playwright | Unit, integration, characterization, and smoke gates |
| Security | OWASP ZAP, Semgrep SAST, DAST Harness | Static security scanning, dynamic adversarial fuzzing |

---

## Core Architectural Principles

### 1. LLM = Reasoning Component / Runtime = Authority

The LLM is an untrusted advisory component with zero direct database or payment access. All mutations and system interactions cross deterministic runtime boundaries:

```text
Model Tool Request
      ↓
Input Schema Validation (Pydantic / Zod)
      ↓
Pre-Stream Admission (Auth -> Length -> Gateway Health -> PII Scan -> Quota)
      ↓
Agent Gateway Guard (API Key + HMAC Claim Token Verification)
      ↓
Deterministic Domain Service Execution
      ↓
Output Guardrail / Sanitization (PII Redaction & Schema Projection)
      ↓
Model-Visible Result & SSE Dispatch
```

### 2. Zero-Client-Credential Boundary

Browsers and client-side JavaScript never receive raw supplier credentials, API keys, upstream flight supplier IDs, or database connection strings:
- All external API communication flows through server-side handlers.
- The web application utilizes `apps/web/lib/server/backend-client.ts` as its single-owner transport.
- Client payloads receive normalized, deterministic domain models with internal UUID identifiers.

### 3. Ports & Adapters (Supplier Boundary Narrowing)

External supplier APIs (Duffel, Stripe) sit behind strict, capability-local domain ports:
- `FLIGHT_SEARCH_PORT` (`supplier-search.module.ts`) encapsulates flight offer queries and mapping.
- `DuffelAncillaryService` (`supplier-ancillary.module.ts`) encapsulates seat maps and baggage catalogs.
- Core business domains (`flights/`, `booking-intent/`, `booking-lifecycle/`) depend exclusively on domain interfaces and never import vendor SDKs or vendor data schemas directly.

### 4. Fail-Closed Security & Atomic Daily Rate Budgets

External vendor access is governed by strict rate budgets:
- `DuffelRateBudgetService` enforces global daily limits via atomic Redis Lua scripts (`budget:duffel:daily:YYYY-MM-DD`, default 1,500 attempts, expiring at next UTC midnight `00:00:00Z`).
- Attempts follow attempted-call semantics: reservations decrement immediately before requests, with zero refund methods.
- On Redis connection failure or script evaluation errors, the system fails closed (`storeError: true`, HTTP 429 / `BUDGET_UNAVAILABLE`), preventing unbudgeted upstream calls.

### 5. Idempotent & Atomic Booking Fulfillment

All booking creations and payments execute as atomic, idempotent transactions:
- Two-phase booking reservation with version-fenced optimistic locking.
- Idempotency keys (`idempotency_key`) recorded for all payment authorizations and settlement sagas.
- Post-commit domain events decouple synchronous persistence from asynchronous projection listeners.

---

## Project Structure

```text
/
├── AGENTS.md                          → Project operating rules and entrypoints
├── pnpm-workspace.yaml                → Workspace topology
├── package.json                       → Monorepo script registry
│
├── apps/
│   ├── api/                           → NestJS Backend Monolith
│   │   ├── prisma/                    → Schema definitions, migrations, and seeds
│   │   └── src/
│   │       ├── agent-gateway/         → Capability-local gateway umbrella & submodules
│   │       │   ├── attested-flight-search/ → V1/V2 search & HMAC selection attestations
│   │       │   ├── booking-readiness/ → Advisory readiness projection
│   │       │   ├── safe-booking-read/ → Tier-1 & Tier-2 safe booking projections
│   │       │   ├── auth/              → AgentAuthModule (API key & claim token guards)
│   │       │   └── audit/             → AgentToolAuditModule (privacy-safe telemetry)
│   │       ├── supplier-search/       → FlightSearchPort provider & Duffel adapter
│   │       ├── supplier-ancillary/    → Seat maps, baggage catalog & repricing
│   │       ├── duffel-core/           → DUFFEL_SDK provider & DuffelRateBudgetService
│   │       ├── booking-lifecycle/     → BookingStateModule, transitions & recovery
│   │       ├── booking-projection/    → Safe read model listeners, writers & metrics
│   │       ├── booking-management/    → Owner read models, disruption & revision queries
│   │       ├── cancellation/          → Cancellation quotes, obligations & refunds
│   │       ├── chat/                  → Chat message persistence & AgentChatController
│   │       ├── idempotency/           → PaymentIdempotencyService & lease management
│   │       ├── payment/               → Stripe payment processing & trigger coordinators
│   │       └── domain-events/         → Passive event publisher & transactional context
│   │
│   ├── agent/                         → Python FastAPI Agent Service
│   │   └── src/agent/
│   │       ├── admission/             → AuthService, InputAdmissionService, QuotaService
│   │       ├── chat_turn/             → Coordinator, runner, interpreter & resolver
│   │       ├── guardrails/            → GuardrailGateway, PII scanning, output pipeline
│   │       ├── memory/                → ConversationMemory, sliding window & compaction
│   │       ├── streaming/             → SSE transport adapter & pre-stream admission
│   │       └── graph/                 → LangGraph state machine & advisory nodes
│   │
│   └── web/                           → Next.js Web Frontend
│       ├── app/                       → App Router routes (search, bookings, dashboard)
│       ├── components/                → React UI components (shadcn/ui, Radix UI)
│       └── lib/server/                → Server-only backendClient transport & schemas
│
├── packages/
│   └── shared/                        → Shared TypeScript types, Zod schemas & constants
│
├── tests/
│   ├── ci/                            → Network isolation & contract verification gates
│   ├── security/                      → SAST/DAST harness, ZAP config & adversarial corpus
│   └── smoke/                         → Multi-service smoke test suite
│
├── context/
│   ├── active-feature.md              → In-flight feature checkpoints & tasks
│   ├── progress-checker.md            → Master project progress & completed features
│   ├── architecture.md                → System architecture & invariant definitions (this file)
│   ├── code-standards.md              → Linting, conventions & styling guidelines
│   ├── library-docs.md                → Approved third-party libraries & usage rules
│   └── workflow.md                    → Development lifecycle & TDD requirements
│
└── docs/
    ├── history/                       → Historical archives (progress & architecture)
    ├── adr/                           → Architectural Decision Records
    └── security/                      → Threat model, security specs & runbooks
```

---

## Core Subsystems

### 1. NestJS Backend Monolith (`apps/api`)

- **Modular Boundary Architecture**: Capability submodules are self-contained and anti-cyclic. Feature modules communicate via domain events or injected port tokens.
- **Supplier Search (`supplier-search.module.ts`)**:
  - Implements `FlightSearchPort`.
  - Encapsulates `DuffelSearchService`, `DuffelSearchAdapter`, `FlightOfferNormalizer`, and cleanup cron.
  - Queries Redis cache (`flight:search:${hash}`, 15 min TTL) before reserving rate budget.
  - Normalizes vendor payloads into RFC 4122 v4 deterministic domain offers.
- **Supplier Ancillaries (`supplier-ancillary.module.ts`)**:
  - Encapsulates `DuffelAncillaryService` and `DuffelAncillaryAdapter`.
  - Fetches seat maps and services concurrently; handles 404 seat maps gracefully as empty seat layouts while retaining baggage options.
  - Writes normalized catalogs to Redis with a 60-second TTL.
- **Duffel Core Foundation (`duffel-core.module.ts`)**:
  - Injects singleton `@duffel/api` SDK via `DUFFEL_SDK`.
  - Houses `DuffelRateBudgetService`, enforcing daily attempt quotas via atomic Redis Lua script.
- **Agent Gateway Submodules (`agent-gateway/`)**:
  - Endpoints protected by `AgentAuthGuard` requiring valid `X-Agent-Service-Key` and HMAC claim tokens.
  - Exposes sanitized read models: attested flight searches, advisory booking readiness, and PII-stripped traveler preferences.

### 2. Python Agent Service (`apps/agent`)

- **Event Transport Decoupling**:
  - Domain events in `chat_turn/events.py` are pure Pydantic models (discriminated union: `token`, `tool_call`, `tool_result`, `flight_results`, `ACTION_HANDOFF`, `ACTION_REQUIRED`, `done`, `error`).
  - Wire serialization (`format_sse`) resides strictly in `streaming/sse.py`.
- **Stream Translation & Projections**:
  - `GraphEventInterpreter` (`chat_turn/interpreter.py`): Pure async generator stream translator that converts LangGraph events to `ChatTurnEvent`. Completely tool-name agnostic with zero provider branching.
  - `ToolResultResolver` (`chat_turn/resolver.py`): Pure domain projection engine mapping tool executions to typed `ToolResolution` and `HandoffResolution`.
- **Ordered Admission Pipeline**:
  - Thin FastAPI dependency chain in `streaming/sse.py` enforcing strict ordered progression:
    `AuthService` (JWT verification) -> `Length/Health` -> `InputAdmissionService` (PII scan) -> `QuotaService` (burst + daily Redis limits) -> `TurnSessionCoordinator`.
  - PII violation immediately terminates the turn with an SSE error event before any Redis initialization or quota consumption.
- **Turn Lifecycle & Memory**:
  - `TurnSessionCoordinator` manages session bootstrap, distributed lease acquisition, memory retrieval, graph execution, approved partial token persistence, and post-turn compaction.

### 3. Next.js Web Frontend (`apps/web`)

- **Unified Server-to-Server Transport**:
  - All backend requests route through `apps/web/lib/server/backend-client.ts` (`createBackendClient`).
  - Enforces `server-only` execution boundary and dynamic `API_URL` resolution precedence.
  - Fast-fails unauthenticated requests before dispatch.
- **Deterministic Retry Matrix**:
  - **GET Requests**: Bounded exponential retries (max 3 attempts, 100ms base delay) for 502/503/504 and 429 (`Retry-After` header parsing). Fast-fails immediately on 500 and 4xx.
  - **Mutations (POST / PUT / PATCH / DELETE)**: Strictly single-send (zero automatic mutation retry) to prevent duplicate bookings or double-charges.
  - **Deadlines**: 10-second timeout per attempt, bounded by a 31-second total request deadline.
- **Zero-Credential Logging**:
  - Transport diagnostics log only categorical cause codes (`missing_token`, `network`, `timeout`, `invalid_json`, `invalid_payload`). Tokens, request bodies, and PII are strictly excluded.

---

## Data & Persistence Topology

### PostgreSQL Entities (Prisma ORM)

```text
+------------------+       +-------------------+       +--------------------+
|      User        | 1   * |      Booking      | 1   * |      Payment       |
|------------------|------>|-------------------|------>|--------------------|
| id               |       | id                |       | id                 |
| email, role      |       | user_id           |       | booking_id         |
| profile_data     |       | status, pnr       |       | stripe_intent_id   |
+------------------+       | total_amount      |       | amount, status     |
                           +---------+---------+       +--------------------+
                                     | 1
                                     | *
                           +---------v---------+
                           |     Passenger     |
                           |-------------------|
                           | id, booking_id    |
                           | first_name, etc.  |
                           +-------------------+
```

- `User`: Primary identity, credential hash, profile preferences.
- `Booking`: Lifecycle state machine (`PENDING`, `CONFIRMED`, `CANCELLED`, `DISRUPTED`), PNR, total amount.
- `FlightOffer`: Stored offer snapshots and validation metadata. Retention: 7 days.
- `Payment`: Stripe payment intent reference, idempotency keys, refund records.
- `ChatSession` & `ChatMessage`: Conversational history, token usage telemetry, advisory tool execution logs.
- `DisruptionInbox`: Inbound flight disruption webhooks for asynchronous reconciliation.

### Redis Topologies & TTL Policies

| Key Pattern | Purpose | Expiration (TTL) | Atomicity Model |
| --- | --- | --- | --- |
| `flight:search:${searchHash}` | Cached raw supplier search results | 15 minutes | Standard set / get |
| `flight:ancillaries:catalog:${offerId}` | Normalized seat maps and baggage | 60 seconds | Best-effort write |
| `budget:duffel:daily:${YYYY-MM-DD}` | Global daily Duffel API call limit | Next UTC midnight | Single-roundtrip Lua script |
| `chat:quota:daily:${userId}:${date}` | Daily user message limit | 24 hours | INCR with EXPIRE |
| `chat:quota:burst:${userId}` | 60-second burst message rate limit | 60 seconds | Sliding counter |
| `session:lease:${sessionId}` | Active turn distributed lock | 30 seconds | SET NX EX |
| `trusted_search_snapshot:${snapshotId}` | Validated search snapshot for chat | 30 minutes | 3-key attestation |

---

## Communication & Security Architecture

### Inter-Service Contract Matrix

| Source | Destination | Protocol | Authentication / Authorization | Payload Contract |
| --- | --- | --- | --- | --- |
| Browser | Next.js Web | HTTPS / HTTP | Session Cookie (NextAuth.js) | HTML / RSC / Server Actions |
| Next.js Web | NestJS API | HTTP (Private) | Bearer JWT (Session token) | JSON (Zod / DTO validated) |
| Next.js Web | Python Agent | HTTP SSE Stream | Bearer JWT (Session token) | SSE Stream of `ChatTurnEvent` |
| Python Agent | NestJS API | HTTP (Private) | `X-Agent-Service-Key` + HMAC Claim Token | JSON (Sanitized Gateway Read Models) |
| NestJS API | Duffel API | HTTPS (Public) | Bearer `DUFFEL_ACCESS_TOKEN` | Supplier SDK Calls (Rate Budgeted) |
| NestJS API | Stripe API | HTTPS (Public) | Bearer `STRIPE_SECRET_KEY` | Stripe SDK (Webhook Signed) |

### Trust Model

- **Trusted Components**:
  - NestJS core business logic, database transactions, and Stripe/Duffel adapters.
  - Deterministic admission pipeline (`AuthService`, `QuotaService`).
  - Redis rate budget scripts and Prisma ORM data layer.
- **Untrusted Inputs**:
  - LLM generated text and tool argument suggestions.
  - End-user search prompts and chat messages.
  - Upstream supplier webhook payloads (untrusted until cryptographic signature verification).

### Prompt Injection & Egress Boundary

1. System instructions, model role, and safety rules are sealed server-side and immutable.
2. User chat input is scanned for PII and adversarial injection patterns via `GuardrailGateway`.
3. Agent tool calling is restricted to a closed capability set; no arbitrary shell, filesystem, or database execution tools exist.
4. Tool outputs returning to the agent are projected and scrubbed of raw provider secrets, stack traces, and sensitive internal fields.

---

## Failure & Outcome Model

System errors map to deterministic, typed categorical outcome codes across all boundaries. Stack traces and internal database errors are never exposed to clients:

- `RATE_LIMIT_EXCEEDED` / `BUDGET_UNAVAILABLE`: Daily supplier budget or user quota exhausted.
- `OFFER_EXPIRED` / `OFFER_UNAVAILABLE`: Flight offer invalid or fare class changed.
- `UNAUTHENTICATED` / `FORBIDDEN`: Missing session, invalid JWT, or role mismatch.
- `GUARDRAIL_BLOCKED`: Input or output failed safety scan (PII, prompt injection).
- `UPSTREAM_UNAVAILABLE`: Transient failure from Duffel or Stripe after bounded retry exhaustion.
- `INVALID_PAYLOAD`: Malformed schema rejected at transport boundary.

---

## Architecture Invariants

1. **LLM Never Mutates Directly**: The Python agent service produces advisory suggestions and handoff intents; only the NestJS backend and authenticated user can commit bookings or trigger payments.
2. **Deterministic Rate Budgeting**: Every live Duffel API call must check and reserve capacity in `DuffelRateBudgetService` prior to dispatch.
3. **Fail-Closed on Budget Outage**: Redis failures in budget services must fail closed, rejecting external calls.
4. **Single-Send Mutations**: Web client transports never retry mutating HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`).
5. **No Upstream ID Leakage**: Upstream supplier IDs (e.g., Duffel offer IDs) are quarantined to the backend and never emitted to client DOM or unauthenticated endpoints.
6. **Zero Raw Trace Leakage**: Production API and agent error responses never leak stack traces or raw upstream payloads.

---

## Historical Reference

For granular historical change logs, task-level PR notes, and migration records across Features 001 through 029, consult:
- `docs/history/architecture-archive.md` (Archived full system architecture logs)
- `docs/history/progress-archive.md` (Archived granular progress records)
