# Library Docs

Project-specific usage patterns for every third-party library in this project. This file only covers how we use each library in this specific Flight Booking System — rules, patterns, and constraints.

Read the relevant section before implementing any feature that touches these libraries.

---

## Before Using Any Library

1. **Check AGENTS.md** — lists every installed skill and how to use them.
2. **Check `context/code-standards.md`** — architectural conventions that apply to all code.
3. **Read this file** — project-specific patterns that override general library knowledge.

Order of authority: `Skills via AGENTS.md → This file → code-standards.md → General training knowledge`

---

## Prisma

### Service Setup (NestJS)

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

### Query Patterns

```typescript
// Read — always scope to user
const bookings = await this.prisma.booking.findMany({
  where: { userId: user.id },
  orderBy: { createdAt: 'desc' },
});

// Insert
const booking = await this.prisma.booking.create({
  data: { userId: user.id, flightId, pnr, status: 'PENDING' },
});

// Transaction — multi-table mutation
await this.prisma.$transaction([
  this.prisma.booking.update({ where: { id: bookingId }, data: { status: 'CONFIRMED' } }),
  this.prisma.payment.create({ data: { bookingId, stripeIntentId, amount, status: 'SUCCEEDED' } }),
  this.prisma.auditLog.create({
    data: { userId, action: 'BOOKING_CONFIRMED', resourceId: bookingId },
  }),
]);
```

**Rules:**

- Schema at `prisma/schema.prisma` — all changes through Prisma migrations, never manual SQL
- Always use `PrismaService` — never import `PrismaClient` directly
- Always scope queries to `userId` on user-owned data
- Use `$transaction` for multi-table mutations (booking + payment + audit log)
- Store raw Amadeus API responses in `jsonb` columns — never lose upstream data
- Migration files are version-controlled and reviewed before merge

---

## Amadeus Self-Service API

### Service Setup

```typescript
// src/amadeus/amadeus.service.ts
import Amadeus from 'amadeus';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AmadeusService {
  private readonly logger = new Logger(AmadeusService.name);
  private readonly amadeus: Amadeus;

  constructor() {
    this.amadeus = new Amadeus({
      clientId: process.env.AMADEUS_API_KEY!,
      clientSecret: process.env.AMADEUS_API_SECRET!,
    });
  }
}
```

### Flight Search

```typescript
async searchFlights(params: {
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  adults: number;
}): Promise<FlightOffer[]> {
  const response = await this.amadeus.shopping.flightOffersSearch.get({
    originLocationCode: params.origin,
    destinationLocationCode: params.destination,
    departureDate: params.departDate,
    returnDate: params.returnDate,
    adults: params.adults,
    max: 20,
  });
  return response.data;
}
```

### Price Confirmation

```typescript
async confirmPrice(flightOffer: FlightOffer): Promise<FlightPrice> {
  const response = await this.amadeus.shopping.flightOffers.pricing.post(
    JSON.stringify({ data: { type: 'flight-offers-pricing', flightOffers: [flightOffer] } })
  );
  return response.data;
}
```

### Create Order (PNR)

```typescript
async createOrder(flightOffer: FlightOffer, travelers: Traveler[]): Promise<Order> {
  const response = await this.amadeus.booking.flightOrders.post(
    JSON.stringify({
      data: {
        type: 'flight-order',
        flightOffers: [flightOffer],
        travelers,
      },
    })
  );
  return response.data;
}
```

**Rules:**

- All Amadeus calls go through `AmadeusService` — never call the SDK from controllers directly
- Always check Redis cache before calling search API (TTL 15–30 min)
- Always check API budget counter before calling (monthly limit: 2,000 calls)
- Log every call: endpoint, parameters (no PII), response status, latency
- Store raw API response in DB alongside parsed data
- Free tier is 2,000 calls/month — every call must be budget-aware

---

## Stripe

### Service Setup

```typescript
// src/payments/payments.service.ts
import Stripe from 'stripe';
import { Injectable } from '@nestjs/common';

@Injectable()
export class PaymentsService {
  private readonly stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2024-06-20',
    });
  }
}
```

### Create Payment Intent

```typescript
async createPaymentIntent(bookingId: string, amountCents: number): Promise<Stripe.PaymentIntent> {
  return this.stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    metadata: { bookingId },
  });
}
```

### Webhook Verification

```typescript
// src/payments/payments.controller.ts
@Post('webhook')
async handleWebhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') sig: string) {
  const event = this.stripe.webhooks.constructEvent(
    req.rawBody!, sig, process.env.STRIPE_WEBHOOK_SECRET!
  );
  // Handle event.type === 'payment_intent.succeeded' etc.
}
```

**Rules:**

- Use Payment Intents API — card data NEVER touches our server (Stripe Elements handles it)
- Always verify webhook signature before processing
- Frontend uses `@stripe/react-stripe-js` with `NEXT_PUBLIC_STRIPE_PUBLIC_KEY`
- Backend uses `STRIPE_SECRET_KEY` — never expose to frontend
- All payment state changes written to `audit_logs` table
- Use Stripe test mode for all development — never use live keys locally

---

## NextAuth.js (Auth.js)

### Route Handler

```typescript
// app/api/auth/[...nextauth]/route.ts
import NextAuth from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';

const handler = NextAuth({
  providers: [
    CredentialsProvider({
      name: 'Email',
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
        // Validate against DB via NestJS auth endpoint
      },
    }),
  ],
  session: { strategy: 'jwt' },
  secret: process.env.NEXTAUTH_SECRET,
});

export { handler as GET, handler as POST };
```

### NestJS JWT Guard

```typescript
// src/auth/guards/jwt-auth.guard.ts
import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

### JWT Strategy (@nestjs/passport)

```typescript
// src/auth/strategies/jwt.strategy.ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.NEXTAUTH_SECRET,
    });
  }

  async validate(payload: { sub: string; email: string }) {
    return { id: payload.sub, email: payload.email };
  }
}
```

**Rules:**

- v1: email/password only — social login deferred
- JWT strategy — stateless, validated independently by Next.js and NestJS
- NextAuth route is the only `app/api/` route in the Next.js app
- NestJS validates JWT on every protected endpoint via `@UseGuards(JwtAuthGuard)`
- `NEXTAUTH_SECRET` must be set in env — never hardcoded
- Never store session data in DB for v1 — JWT is sufficient

---

## Redis (ioredis)

### Cache Service

```typescript
// src/cache/cache.service.ts
import Redis from 'ioredis';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL!);
  }

  async getCached<T>(key: string): Promise<T | null> {
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async setCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async incrementBudget(key: string): Promise<number> {
    const count = await this.redis.incr(key);
    await this.redis.expireAt(key, this.monthEndUnix());
    return count;
  }

  buildKey(domain: string, action: string, params: object): string {
    const hash = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 12);
    return `${domain}:${action}:${hash}`;
  }

  private monthEndUnix(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).getTime();
  }
}
```

**Rules:**

- Use `ioredis` — wrapped in injectable `CacheService`
- Search result cache: TTL 15–30 minutes
- API budget counter: atomic `INCR` with monthly key — alerts at 50%, 75%, 90%
- Cache key pattern: `{domain}:{action}:{sha256_hash}`
- Never cache user PII or payment data in Redis

---

## LangChain.js + Mimo

### Agent Setup

```typescript
// src/agents/flight-match/flight-match.agent.ts
import { ChatOpenAI } from '@langchain/openai';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class FlightMatchAgent {
  private readonly logger = new Logger(FlightMatchAgent.name);
  private readonly model: ChatOpenAI;

  constructor() {
    this.model = new ChatOpenAI({
      modelName: 'mimo',
      openAIApiKey: process.env.MIMO_API_KEY!,
      configuration: {
        baseURL: process.env.MIMO_API_URL!,
      },
      temperature: 0.3,
    });
  }

  async scoreFlights(
    flights: FlightOffer[],
    preferences: TravelerPreferences,
    traceId: string,
  ): Promise<{ success: boolean; scores?: FlightScore[]; error?: string }> {
    try {
      // LangChain agent chain with tool calling
      // Tool calls go through agent-gateway — no direct DB access
      return { success: true, scores };
    } catch (error) {
      this.logger.error(`[scoreFlights] traceId=${traceId}`, error);
      return { success: false, error: String(error) };
    }
  }
}
```

### Tool Calling Pattern

```typescript
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const userPrefsTool = tool(
  async ({ userId }) => {
    // Goes through agent-gateway — PII stripped before reaching agent
    return agentGateway.getUserPreferences(userId);
  },
  {
    name: 'get_user_preferences',
    description: 'Get traveler preferences for flight matching',
    schema: z.object({ userId: z.string() }),
  },
);
```

**Rules:**

- Use `ChatOpenAI` with custom `baseURL` pointing to Mimo's OpenAI-compatible endpoint
- AI agents are NestJS injectable services — follow the same module pattern
- Every agent function returns `{ success: boolean, error?: string }`
- Every agent function has try/catch — never let one failure crash the run
- Agent functions NEVER access Prisma directly — all data access goes through agent-gateway
- Agent functions NEVER import from frontend code
- Errors logged with trace ID before returning
- Feature 17 chat runs must not send prompts, messages, credentials, identifiers, or raw tool payloads to LangSmith or another third-party trace store; use PII-safe internal telemetry.

**Temperature settings:**

- `0.3` — flight matching, scoring, extraction (deterministic results)
- `0.7` — conversational responses, trip suggestions (natural variation)

---

## LangSmith (not approved for Feature 17 chat payloads)

Feature 17 uses bounded internal telemetry with opaque trace/correlation IDs. Do not configure full agent inputs, outputs, tool payloads, credentials, user/session/offer identifiers, or raw exception data for LangSmith or another third-party trace store. Propagate only the approved opaque identifiers and finite operational labels. Dashboard/alert assertions and measured latency evidence remain T097/T098. See the [handoff runbook](../docs/runbooks/chatbot-handoff.md).

---

## NestJS (Framework Patterns)

### Module Structure

```typescript
// src/flights/flights.module.ts
import { Module } from '@nestjs/common';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { CacheModule } from '@/cache/cache.module';
import { AmadeusModule } from '@/amadeus/amadeus.module';

@Module({
  imports: [PrismaModule, CacheModule, AmadeusModule],
  controllers: [FlightsController],
  providers: [FlightsService],
  exports: [FlightsService],
})
export class FlightsModule {}
```

### Controller Pattern

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

### Service Pattern

```typescript
// src/flights/flights.service.ts
import { Injectable, Logger } from '@nestjs/common';

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

**Rules:**

- One module per domain: flights, bookings, payments, auth, agents, notifications
- Module → Controller → Service → Repository pattern
- Controllers handle HTTP concerns only — validation, request parsing, response shaping
- Services contain all business logic — controllers never call external APIs or Prisma directly
- DTOs with `class-validator` decorators for all request/response shapes
- Guards for auth (`@UseGuards(JwtAuthGuard)`) on all protected endpoints
- Injectable services use constructor injection — never `new`
- Every controller method has try/catch — errors caught by global exception filter

---

## class-validator

### DTO Pattern

```typescript
// src/flights/dto/search-flights.dto.ts
import { IsString, IsDateString, IsInt, Min, Max, IsOptional } from 'class-validator';

export class SearchFlightsDto {
  @IsString()
  origin: string;

  @IsString()
  destination: string;

  @IsDateString()
  departDate: string;

  @IsOptional()
  @IsDateString()
  returnDate?: string;

  @IsInt()
  @Min(1)
  @Max(9)
  adults: number;
}
```

### Global Validation Pipe

```typescript
// src/main.ts
import { ValidationPipe } from '@nestjs/common';

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
);
```

**Rules:**

- Every controller input uses a DTO class with `class-validator` decorators — never validate manually
- `whitelist: true` strips unknown properties — defence against mass assignment
- `forbidNonWhitelisted: true` rejects requests with unexpected fields
- `transform: true` auto-converts query string values to their declared types
- One DTO file per operation: `create-booking.dto.ts`, `search-flights.dto.ts`, etc.

---

## Next.js App Router

### Data Fetching (Server Components)

```typescript
// app/search/page.tsx — Server Component (default)
import { getServerSession } from 'next-auth';

export default async function SearchPage() {
  const session = await getServerSession();
  // Fetch from NestJS backend — not from app/api/
  const results = await fetch(`${process.env.NEXT_API_URL}/flights/recent`, {
    headers: { Authorization: `Bearer ${session?.accessToken}` },
  });
  return <FlightResults data={await results.json()} />;
}
```

### Client Component (when needed)

```typescript
'use client';

import { useState } from 'react';

type Props = {
  flights: Flight[];
};

export function FlightSearchForm({ flights }: Props) {
  // useState, useEffect, event handlers here
}
```

**Rules:**

- App Router only — no Pages Router
- All components are Server Components by default
- Only add `"use client"` when the component requires: useState, useEffect, browser APIs, event listeners, or client-only libraries
- Data fetching happens in Server Components — never fetch in Client Components directly
- Next.js is the frontend only — all API calls go to the NestJS backend, not `app/api/` route handlers
- Minimal `app/api/` usage — only for NextAuth.js auth routes and Stripe webhook receivers
- Never put business logic in the Next.js layer — it belongs in NestJS services

---

## Python Redis (redis.asyncio)

### Client Lifecycle

- Create one `redis.asyncio.Redis` pooled client during FastAPI lifespan and close it on shutdown.
- Redis is the agent control plane, not conversation storage.
- Redis unavailability fails closed before inference. Health reports Redis separately.

### Allowed Data

- No message text, prompt, booking passenger data, token, or payment data is stored in Redis.
- Only counters, locks, and explicitly PII-free Trusted Search Snapshots are permitted.

### Approved Use Cases

1. **Budget/Quota Admission**:
   - Keys: `chat:budget:{userId}:{YYYY-MM-DD}` and `chat:burst:{userId}:{window}`
   - One versioned Lua admission script increments both only when both admit, uses next-UTC-boundary expiry, and never charges denied attempts.
2. **Session Fencing**:
   - Key: `chat:session-lock:{userId}:{sessionId}`
   - Token-owned lease plus monotonic fencing token. Refresh loss cancels work and NestJS durable writes reject stale fencing owners.
3. **Trusted Search Snapshot**:
   - Key: `chat:snapshot:{userId}:{sessionId}`
   - Versioned PII-free snapshot with TTL no longer than offer freshness.

### Ownership and safety rules

- Implement control-plane behavior only in `ChatBudgetRepository`, `SessionLockRepository`, and `TrustedSnapshotRepository`; do not add ad-hoc Redis calls to graph nodes, tools, or controllers.
- Redis is not durable truth and never stores conversation text, summaries, handoff credentials/tokens/hashes, booking projections, passenger/contact/passport data, or payment data. The strict Trusted Search Snapshot is the only approved place for service-only local/provider offer bindings and the signed attestation; those fields never enter LLM messages, browser events, logs, or telemetry.
- A failed control plane fails closed before inference. Lua admission charges accepted requests only; refresh loss cancels work; snapshots atomically replace and are owner/session/expiry bound.

---

## Python LangGraph

### Graph Architecture

- The compiled LangGraph remains a single graph containing all agent nodes, but without an interrupt-capable checkpointer (no `MemorySaver`).
- One graph execution per turn. Durable context is restored at entry from NestJS (decrypted summary/messages) and Redis (snapshot).
- After execution, the encrypted completed turn is persisted via the service-authenticated gateway.
- LangGraph is a direct dependency, not just transitive through LangChain.

### Routing and Agents

- **Stateless Router**: Uses strict Pydantic structured output. No tools, never writes conversational text. A deterministic route function applies configured thresholds.
- **Explicit Registries**: Tool inventories are constructed per agent, not filtered at runtime.
  - _General_: no tools
  - _Travel_: `search_flights`, `get_user_preferences`, `list_user_booking_summaries`, `get_booking_detail`, `check_booking_readiness`
  - _Checkout_: `signal_checkout_intent` (state-only, no I/O)

### Deterministic Nodes

- Graph nodes that interact with token issuance or intent lifecycle are deterministic application I/O and must never be exposed as LLM tools.
- Validation and handoff creation happen in strict graph nodes, never directly in LLM responses.

### Service, encryption, and observability boundary

- The agent has no direct Prisma/PostgreSQL access. Durable chat, safe booking projections, attestation/handoff operations, and persistence go only through service-authenticated NestJS gateway endpoints; browser JWT forwarding is not service identity.
- Chat content/titles are record-bound AES-256-GCM at the NestJS boundary with keys outside PostgreSQL. Legacy plaintext is rollback inventory; T102 is separately approved irreversible cleanup.
- Snapshots are minimum PII-free owner/session/version/expiry data. Offer IDs and attestations are service-only and never LLM or browser-display inputs. Fence revalidation is mandatory before durable writes/handoff emission.
- Emit only opaque trace/correlation IDs, finite allowlisted labels, and aggregate fields. Never emit content, summaries, credentials/hashes, IDs, PNR, passenger/contact/passport/payment data, or raw tool payloads. Existing logging gaps are tracked in the runbook and must not become patterns.

### Dependency rationale

- `redis.asyncio` is a direct dependency for pooled lifecycle, Lua admission, leases, and TTL snapshots; in-process controls cannot coordinate replicas.
- `langgraph` is a direct dependency for the single routed state graph without `MemorySaver` or another durable checkpointer. NestJS remains the durable state owner.
- Keep the deployed Mimo adapter and existing LangChain dependencies. Do not add a tracing provider or new guardrail framework in this feature. See the [Feature 17 plan](../specs/017-chatbot-backend-infrastructure/plan.md) and [handoff runbook](../docs/runbooks/chatbot-handoff.md).
