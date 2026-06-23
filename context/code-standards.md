# Code Standards

Implementation rules and conventions for the entire project. The AI agent must follow these in every session without exception. These rules prevent pattern drift across sessions.

---

## Engineering Mindset

The AI agent on this project operates as a senior engineer. This means:

- **Think before implementing** — understand what is being built and why before writing a single line
- **Scope is sacred** — only build what the current feature requires. Never go beyond scope even if it seems helpful
- **Every feature must be testable** — if it cannot be verified immediately after implementation, it is incomplete
- **Clean over clever** — simple readable code that a junior developer can understand is always preferred over clever abstractions
- **One thing at a time** — complete one feature fully before touching the next
- **Failures are expected** — wrap agent operations in try/catch, log failures, never let one failure crash everything
- **Constitution compliance** — align implementation decisions with `.specify/memory/constitution.md`

---

## TypeScript

- Strict mode enabled in tsconfig.json — no exceptions
- Never use `any` — use `unknown` and narrow the type
- Never use type assertions (`as SomeType`) unless absolutely necessary and commented why
- All function parameters and return types must be explicitly typed
- Use `type` for object shapes and unions — use `interface` only for extendable component props
- All async functions must have proper error handling — never let promises float unhandled
- Use `const` by default — only use `let` when reassignment is necessary
- Shared types between frontend and backend live in a `shared/types/` package — never redefine locally

---

## NestJS Backend Conventions

- Modular architecture — one module per domain (flights, bookings, payments, auth, agents, notifications)
- Every module follows the pattern: `module → controller → service → repository`
- Controllers handle HTTP concerns only — validation, request parsing, response shaping
- Services contain all business logic — controllers never call external APIs or Prisma directly
- Use DTOs (Data Transfer Objects) with `class-validator` decorators for all request/response shapes
- Use Guards for authentication — `@UseGuards(JwtAuthGuard)` on all protected endpoints
- Use Interceptors for cross-cutting concerns — logging, response transformation
- Use Pipes for input validation — `ValidationPipe` globally registered
- Every controller method has a try/catch — errors are caught by a global exception filter
- Injectable services use constructor injection — never use `new` for service instantiation

### NestJS Controller Pattern

```typescript
// src/flights/flights.controller.ts

import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { FlightsService } from './flights.service';
import { SearchFlightsDto } from './dto/search-flights.dto';

@Controller('flights')
@UseGuards(JwtAuthGuard)
export class FlightsController {
  constructor(private readonly flightsService: FlightsService) {}

  @Post('search')
  async search(@Body() dto: SearchFlightsDto) {
    return this.flightsService.searchFlights(dto);
  }
}
```

### NestJS Service Pattern

```typescript
// src/flights/flights.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { AmadeusService } from '@/amadeus/amadeus.service';

@Injectable()
export class FlightsService {
  private readonly logger = new Logger(FlightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly amadeus: AmadeusService,
  ) {}

  async searchFlights(dto: SearchFlightsDto): Promise<FlightSearchResult> {
    try {
      // 1. Check cache
      // 2. Check rate limit / budget
      // 3. Call Amadeus API
      // 4. Cache response
      // 5. Return results
    } catch (error) {
      this.logger.error('[searchFlights]', error);
      throw error;
    }
  }
}
```

---

## Next.js Frontend Conventions

- App Router only — no Pages Router
- All components are Server Components by default
- Only add `"use client"` when the component requires:
  - useState or useReducer
  - useEffect
  - Browser APIs
  - Event listeners
  - Third party client-only libraries
- Never add `"use client"` to layout files unless absolutely required
- Data fetching happens in Server Components — never fetch in Client Components directly
- **Next.js is the frontend only** — all API calls go to the NestJS backend, not `app/api/` route handlers
- Minimal `app/api/` usage — only for NextAuth.js auth routes and webhook receivers
- Never put business logic in the Next.js layer — it belongs in NestJS services

---

## File and Folder Naming

### NestJS Backend

- Modules: kebab-case — `flights/`, `bookings/`, `payments/`, `agents/`
- Controllers: kebab-case — `flights.controller.ts`
- Services: kebab-case — `flights.service.ts`
- DTOs: kebab-case — `search-flights.dto.ts`, `create-booking.dto.ts`
- Guards: kebab-case — `jwt-auth.guard.ts`
- Interceptors: kebab-case — `logging.interceptor.ts`
- One class per file — never export multiple controllers or services from one file

### Next.js Frontend

- Folders: kebab-case — `flight-search/`, `booking-details/`
- Component files: PascalCase — `StatsBar.tsx`, `FlightCard.tsx`
- Utility files: camelCase — `apiClient.ts`, `formatCurrency.ts`
- Type files: camelCase — `index.ts`
- One component per file — never export multiple components from one file
- Index files only in `components/ui/` — never barrel export from other folders

---

## Component Structure

Every React component follows this exact order:

```typescript
"use client"; // only if needed

// 1. External imports
import { useState } from "react";
import { Button } from "@/components/ui/button";

// 2. Internal imports
import { FlightCard } from "@/components/flights/FlightCard";

// 3. Type definitions
type Props = {
  flightId: string;
  matchScore: number;
};

// 4. Component
export function ComponentName({ flightId, matchScore }: Props) {
  // state
  // derived values
  // handlers
  // return JSX
}
```

- Never use default exports for components — always named exports
- Props type defined directly above the component — not in a separate types file unless shared
- No inline styles — all styling via Tailwind classes

---

## Prisma Conventions

- Schema file lives at `prisma/schema.prisma` in the backend
- All schema changes go through Prisma migrations — never modify the database manually
- Migration files are version-controlled and reviewed before merge
- Use a `PrismaService` injectable wrapper in NestJS — never import `PrismaClient` directly in services
- Always scope queries to the authenticated user — never query without a user filter on user-owned data
- Use transactions for multi-table mutations (e.g., booking + payment + audit log)
- Store raw Amadeus API responses in `jsonb` columns — never lose upstream data

### Prisma Service Pattern

```typescript
// src/prisma/prisma.service.ts

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

---

## Redis Conventions

Caching and rate limiting conventions:

- Use `ioredis` client — wrapped in an injectable `CacheService`
- Search result caching: TTL of 15–30 minutes
- API budget counter: atomic `INCR` with monthly key — alerts at 50%, 75%, 90% thresholds
- Rate limiting: per-user and global limits enforced before any Amadeus API call
- Cache keys follow the pattern: `{domain}:{action}:{hash}` — e.g., `flights:search:{sha256}`
- Never cache user PII or payment data in Redis

---

## Amadeus API Conventions

Conventions for external Amadeus API integration:

- All Amadeus calls go through a single `AmadeusService` — never call the SDK directly from controllers
- Budget counter check and response caching are enforced here (see Redis Conventions above for implementation)
- Use the official `amadeus` npm SDK with typed wrappers
- Store the raw API response in the database alongside parsed data
- Log every API call with: endpoint, parameters (no PII), response status, latency

---

## Stripe Payment Conventions

Conventions for Stripe payment processing:

- Use Payment Intents API + Stripe Elements on the frontend
- Backend only sees tokenized Payment Intent IDs — Stripe Elements handles all card input on the client
- Webhook handling: always verify webhook signature before processing
- Payment flow: create intent → frontend confirms → webhook updates booking status
- All payment state changes written to `audit_logs` table
- Use Stripe test mode for all development — never use live keys locally

---

## AI Agent Code (LangChain.js)

```typescript
// src/agents/flight-match/flight-match.agent.ts

import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';

@Injectable()
export class FlightMatchAgent {
  private readonly logger = new Logger(FlightMatchAgent.name);

  async scoreFlights(
    flights: FlightOffer[],
    preferences: TravelerPreferences,
    traceId: string,
  ): Promise<{ success: boolean; scores?: FlightScore[]; error?: string }> {
    try {
      // LangChain agent chain with Mimo model
      // Tool calls go through agent-gateway (no direct DB access)
      return { success: true, scores };
    } catch (error) {
      this.logger.error(`[scoreFlights] traceId=${traceId}`, error);
      return { success: false, error: String(error) };
    }
  }
}
```

- AI agents are NestJS injectable services — follow the same module pattern
- Every agent function returns `{ success: boolean, error?: string }`
- Every agent function has a try/catch — never let one failure crash the run
- Errors are always logged with trace ID before returning
- Agent functions NEVER import from frontend code
- Agent functions NEVER access Prisma directly — all data access goes through the agent-gateway (see `context/architecture.md` Invariants)
- LangSmith records full traces for every agent run (tool calls, inputs, outputs, latency)
- Use `ChatOpenAI` with custom `baseURL` pointing to Mimo's OpenAI-compatible endpoint

---

## Authentication (NextAuth.js)

- NextAuth.js (Auth.js) with JWT strategy
- v1: email/password only — social login deferred to later milestone
- JWT tokens are stateless — validated independently by both Next.js and NestJS
- NestJS validates JWT on every protected endpoint via `JwtAuthGuard`
- NextAuth route handlers live in `app/api/auth/[...nextauth]/route.ts` — the only `app/api/` route
- Never store session data in the database for v1 — JWT is sufficient
- `NEXTAUTH_SECRET` must be set in environment variables — never hardcode

---

## Error Handling

- Never use empty catch blocks — always log or handle
- NestJS: use the built-in `Logger` service with context prefix: `this.logger.error('[methodName]', error)`
- Frontend: console errors include context prefix: `[component/function name]`
- User-facing errors must be human readable — never expose raw error messages
- Agent errors go to `agent_logs` table — never surface raw agent errors to the UI
- API errors return appropriate HTTP status codes with generic message — never expose internals
- All NestJS exceptions are caught by a global exception filter

---

## Structured Logging

Conventions for structured logging:

```typescript
{
  "timestamp": "2026-06-23T12:00:00.000Z",
  "level": "error",
  "service": "flights",
  "trace_id": "abc-123",
  "correlation_id": "def-456",
  "message": "Amadeus API timeout",
  "metadata": { "endpoint": "/v2/shopping/flight-offers", "latency_ms": 30000 }
}
```

- Logs must use `user_id` references only — never PII or payment card data (constitutional requirement)
- Every cross-service call propagates `trace_id` for distributed tracing
- Use NestJS `Logger` service — never use raw `console.log` in backend code

---

## Audit Logging

All transactional state changes must be recorded in the `audit_logs` table:

- Booking created, confirmed, cancelled
- Payment intent created, succeeded, failed, refunded
- Authentication events (login, logout, password change)
- Amadeus API calls (endpoint, status, budget counter value)

Audit log entries must include: `timestamp`, `user_id`, `action`, `resource_type`, `resource_id`, `metadata`.

---

## Environment Variables

All environment variables defined in `.env.local` for development. Never hardcode any key, URL, or secret anywhere in the codebase.

### NestJS Backend

| Variable                    | Used In                    |
| --------------------------- | -------------------------- |
| `DATABASE_URL`              | prisma/schema.prisma       |
| `REDIS_URL`                 | cache.service.ts           |
| `AMADEUS_API_KEY`           | amadeus.service.ts         |
| `AMADEUS_API_SECRET`        | amadeus.service.ts         |
| `STRIPE_SECRET_KEY`         | payments.service.ts        |
| `STRIPE_WEBHOOK_SECRET`     | payments.controller.ts     |
| `MIMO_API_URL`              | agents/ (LangChain config) |
| `MIMO_API_KEY`              | agents/ (LangChain config) |
| `LANGSMITH_API_KEY`         | agents/ (tracing config)   |
| `JWT_SECRET`                | auth.module.ts             |

### Next.js Frontend

| Variable                       | Used In                    |
| ------------------------------ | -------------------------- |
| `NEXT_PUBLIC_API_URL`          | lib/apiClient.ts           |
| `NEXTAUTH_SECRET`              | NextAuth.js config         |
| `NEXTAUTH_URL`                 | NextAuth.js config         |
| `NEXT_PUBLIC_STRIPE_PUBLIC_KEY`| Stripe Elements            |

`NEXT_PUBLIC_` prefix means the variable is exposed to the browser. Never add `NEXT_PUBLIC_` to secret keys.

---

## Match Threshold

The flight match threshold is defined once as a constant. Never hardcode this value anywhere else.

```typescript
// shared/constants.ts
export const MATCH_THRESHOLD = 70;
```

Import and use `MATCH_THRESHOLD` everywhere this value is needed.

---

## Import Aliases

### Next.js Frontend

Always use the `@/` alias — never use relative imports that go up more than one level.

```typescript
// Correct
import { Button } from "@/components/ui/button";
import { MATCH_THRESHOLD } from "@shared/constants";

// Never
import { Button } from "../../../components/ui/button";
```

### NestJS Backend

Use the `@/` or `@src/` path alias configured in tsconfig.json — never use deep relative imports.

```typescript
// Correct
import { PrismaService } from '@/prisma/prisma.service';
import { FlightSearchResult } from '@shared/types';

// Never
import { PrismaService } from '../../../prisma/prisma.service';
```

---

## Comments

- No comments explaining what the code does — code must be self-explanatory
- Comments only for why — explaining a non-obvious decision
- Agent functions may have a brief comment explaining the LangChain tool strategy or Mimo prompt design
- Never leave TODO comments in committed code

---

## Testing

- Test files live next to source files: `flights.service.spec.ts` alongside `flights.service.ts`
- Unit tests for all services and agents — mock external dependencies (Amadeus, Stripe, Mimo)
- Integration tests for controller endpoints — use NestJS testing module with test database
- E2E tests for critical flows: search → book → pay → confirm
- Never test implementation details — test behavior and outcomes
- All tests must pass before merge

---

## Health Checks

Every deployable service must expose a `/health` endpoint:

- Reports readiness and liveness status
- Includes downstream dependency status: PostgreSQL, Redis, Amadeus API, Stripe
- Returns structured JSON: `{ status: "ok" | "degraded" | "down", dependencies: { ... } }`

---

## Dependencies

Never install a new package without a clear reason. Before installing anything check:

1. Does NestJS already provide this functionality?
2. Does Next.js already provide this functionality?
3. Is there a simpler native solution?

Approved dependencies for this project:

### NestJS Backend

- `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` — NestJS framework
- `@nestjs/config` — Environment variable management
- `prisma`, `@prisma/client` — ORM and database client
- `ioredis` — Redis client
- `amadeus` — Amadeus Self-Service API SDK
- `stripe` — Stripe payment processing
- `langchain`, `@langchain/openai`, `@langchain/core` — AI agent framework
- `class-validator`, `class-transformer` — DTO validation
- `passport`, `@nestjs/passport`, `passport-jwt` — Authentication
- `zod` — Schema validation (shared types)

### Next.js Frontend

- `next-auth` — Authentication (NextAuth.js / Auth.js)
- `@stripe/stripe-js`, `@stripe/react-stripe-js` — Stripe Elements
- `zod` — Schema validation
- `lucide-react` — Icons
- `tailwindcss` — Styling
- `shadcn/ui` components — UI primitives

### Shared

- `typescript` — Language
- `zod` — Shared schema validation

Do not install any other packages without updating this list first.
