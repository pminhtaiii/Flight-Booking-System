# Architecture

## Stack

| Layer              | Tool                          | Purpose                                                    |
| ------------------ | ----------------------------- | ---------------------------------------------------------- |
| Language           | TypeScript (strict)           | End-to-end — shared types across frontend and backend      |
| Backend Framework  | NestJS                        | Deterministic backend services (booking, payments, auth)   |
| Frontend Framework | Next.js (App Router)          | SSR, SEO, Server Components for the user-facing UI         |
| Database           | PostgreSQL                    | Primary transactional store (users, bookings, payments)    |
| ORM                | Prisma                        | Type-safe queries, declarative schema, versioned migrations|
| Cache / Rate Limit | Redis                         | Search result caching, rate limiting, API budget tracking   |
| Authentication     | NextAuth.js (Auth.js) + JWT   | Email/password for v1. Social login deferred               |
| Payment            | Stripe (Payment Intents)      | PCI-DSS compliant payment processing                       |
| Flight Data        | Amadeus Self-Service API      | Flight search, pricing, PNR creation, ticketing            |
| AI Model           | Mimo (OpenAI-compatible URL)  | Advisory agents — search assistance, recommendations       |
| AI Framework       | LangChain.js                  | Agent chains, tool calling, conversation memory            |
| AI Observability   | LangSmith                     | Agent run tracing, tool call auditing                      |
| Code Review        | CodeRabbit                    | Automated PR review for security and code quality          |

---

## Project Structure (Current)

```
/
├── AGENTS.md                          → Agent rules and procedural guidance
├── .gitignore
├── skills-lock.json
│
├── context/
│   └── architecture.md                → This file
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

> **Note**: No application source code has been implemented yet.

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

### AI Agent Advisory Flow (Non-Transactional)

```
User asks AI assistant for help (e.g., "suggest flights for a beach vacation")
        ↓
Next.js → POST /api/agents/search-assist
        ↓
NestJS agents controller initializes LangChain agent chain
        ↓
LangChain agent (Mimo model via OpenAI-compatible URL)
        │
        ├── Tool call: user-prefs.tool → agent-gateway → Prisma (PII stripped)
        ├── Tool call: flight-lookup.tool → agent-gateway → cached results
        │
        ↓
Agent synthesizes recommendation (natural language)
        ↓
LangSmith records full trace (tools called, inputs, outputs, latency)
        ↓
Response returned to user (advisory only — no booking action taken)
```

---

## Invariants

Rules that must never be violated:

- **AI agents NEVER participate in booking or payment flows.** All transactional operations are handled by deterministic backend services only.
- **AI agents NEVER access PostgreSQL directly.** All agent data access goes through the agent-gateway, which strips PII and enforces scoped access.
- **Raw payment card data NEVER touches our servers.** Stripe Elements handles all card input on the frontend; the backend only sees tokenized Payment Intent IDs.
- **Every Amadeus API call MUST check the Redis budget counter first.** If the monthly budget is exhausted, return a graceful error — never silently exceed the 2,000 call limit.
- **Every Amadeus API response MUST be cached in Redis.** Duplicate searches within the TTL window must hit cache, not Amadeus.
- **All booking, payment, and auth events MUST be written to audit_logs.** No transactional state change goes unrecorded.
- **Audit logs and structured logs MUST NOT contain PII or payment card data.** Use user_id references only.
- **JWT tokens MUST be validated on every protected endpoint.** No endpoint in the deterministic path is accessible without authentication.
- **Prisma migrations MUST be version-controlled and reviewed.** No ad-hoc schema changes in production.
- **All user-facing inputs MUST be validated and sanitized.** SQL injection, XSS, and CSRF protections are mandatory.
- **Frontend components contain no business logic or direct API calls to external services.** All external communication goes through the NestJS backend.
- **Shared TypeScript types are the single source of truth.** Frontend and backend must use the same type definitions — never redefine them locally.