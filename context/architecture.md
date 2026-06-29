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
| Flight Data        | Amadeus Self-Service API     | Flight search, pricing, PNR creation, ticketing             |
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
User enters search criteria (origin, destination, dates, passengers)
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
                    flights.service calls Amadeus Flight Offers API
                        ↓
                    Response cached in Redis (TTL: 15-30 min)
                        ↓
                    API budget counter incremented (Redis INCR)
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

### Payment Flow (Deterministic Path — No AI)

```
User on payment page with booking ID
        ↓
Next.js → POST /api/payments/create-intent
        ↓
payments.service creates Stripe Payment Intent
        ↓
Stripe client secret returned to frontend
        ↓
Stripe Elements handles card input (card data NEVER touches our server)
        ↓
Stripe processes payment
        ↓
Stripe sends webhook → POST /api/payments/webhook
        ↓
payments.service verifies webhook signature
        ↓
Prisma updates booking status → CONFIRMED
        ↓
notifications.service sends confirmation email
        ↓
Audit log entry written to PostgreSQL
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
            Orchestrates LangChain conversational agent with Mimo model
                ↓
            Tokens streamed back to frontend via SSE in real time
                ↓
            Upon completion, full conversation Turn persisted via NestJS Chat API
```

---

## Invariants

The following are **architecture-specific** invariants that enforce the system design:

- **AI agents NEVER access PostgreSQL directly.** All agent data access goes through the agent-gateway, which strips PII and enforces scoped access.
- **JWT tokens MUST be validated on every protected endpoint.** No endpoint in the deterministic path is accessible without authentication.
- **Prisma migrations MUST be version-controlled and reviewed.** No ad-hoc schema changes in production.
- **Frontend components contain no business logic or direct API calls to external services.** All external communication goes through the NestJS backend.
- **Shared TypeScript types are the single source of truth.** Frontend and backend must use the same type definitions — never redefine them locally.
