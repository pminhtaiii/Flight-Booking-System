# Architecture

## Stack

| Layer              | Tool                         | Purpose                                                     |
| ------------------ | ---------------------------- | ----------------------------------------------------------- |
| Language           | TypeScript & Python 3.11+    | TS for web/API, Python for agent service                    |
| Backend Framework  | NestJS                       | Deterministic backend services (booking, payments, auth)    |
| Frontend Framework | Next.js (App Router)         | SSR, SEO, Server Components for the user-facing UI          |
| Database           | PostgreSQL                   | Primary transactional store (users, bookings, payments)     |
| ORM                | Prisma                       | Type-safe queries, declarative schema, versioned migrations |
| Cache / Rate Limit | Redis                        | Search result caching, rate limiting, API budget tracking   |
| Authentication     | NextAuth.js (Auth.js) + JWT  | Email/password for v1. Social login deferred                |
| Payment            | Stripe (Payment Intents)     | PCI-DSS compliant payment processing                        |
| Flight Data        | Duffel API                   | Flight search, pricing, PNR creation, ticketing             |
| AI Model           | Mimo (OpenAI-compatible URL) | Advisory agents — search assistance, recommendations        |
| AI Framework       | LangChain (JS/Python)        | Agent chains, tool calling, conversation memory             |
| AI Observability   | LangSmith                    | Agent run tracing, tool call auditing                       |
| Code Review        | CodeRabbit                   | Automated PR review for security and code quality           |

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
