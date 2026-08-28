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

## Duffel API (@duffel/api)

### Service Setup & Provider Override

```typescript
// src/duffel/duffel.service.ts
import { Duffel } from '@duffel/api';
import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';

@Injectable()
export class DuffelService {
  private readonly logger = new Logger(DuffelService.name);
  private readonly duffel: Duffel;
  private readonly basePath: string;

  constructor(private readonly cacheService: CacheService) {
    const token = process.env.DUFFEL_ACCESS_TOKEN || '';
    const rawApiUrl = process.env.DUFFEL_API_URL;

    if (rawApiUrl && rawApiUrl.trim() !== '') {
      const parsed = new URL(rawApiUrl.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(
          `Unsupported DUFFEL_API_URL protocol: ${parsed.protocol}. Only http: and https: are allowed.`,
        );
      }
      this.basePath = `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/+$/, '');
    } else {
      this.basePath = 'https://api.duffel.com';
    }

    this.duffel = new Duffel({
      token,
      basePath: this.basePath,
    });
  }
}
```

**Rules:**

- Default endpoint is `https://api.duffel.com` when `DUFFEL_API_URL` is absent or empty.
- Providing `DUFFEL_API_URL` overrides the SDK endpoint by passing `basePath` to `new Duffel({ token, basePath })`.
- Constructor performs fast-fail validation using `new URL(rawApiUrl)` and restricts protocol to `http:` or `https:`. Malformed URLs or unsupported protocols fail fast immediately.
- Trailing slashes are normalized cleanly, and manual fetch calls in `createOrder` prepend `this.basePath`.
- Fully compatible with `mock-server.mjs` on loopback for zero-dependency CI smoke suites.

---

## Stripe

### Service Setup & Provider Override

```typescript
// src/common/stripe.service.ts
import Stripe from 'stripe';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class StripeService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);

  constructor() {
    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (!apiKey) {
      this.logger.error('STRIPE_SECRET_KEY environment variable is not defined');
      throw new Error('STRIPE_SECRET_KEY is missing');
    }

    const rawUrl = process.env.STRIPE_API_URL;
    if (rawUrl && rawUrl.trim() !== '') {
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        this.logger.error('Invalid STRIPE_API_URL provided');
        throw new Error('Invalid STRIPE_API_URL');
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        this.logger.error(`Unsupported STRIPE_API_URL protocol: ${parsed.protocol}`);
        throw new Error(`Unsupported STRIPE_API_URL protocol: ${parsed.protocol}`);
      }

      const stripeConfig: Stripe.StripeConfig = {
        apiVersion: '2026-05-27.dahlia' as Stripe.StripeConfig['apiVersion'],
        protocol: parsed.protocol.replace(':', '') as 'http' | 'https',
        host: parsed.hostname,
      };

      if (parsed.port && parsed.port.trim() !== '') {
        stripeConfig.port = Number(parsed.port);
      }

      this.stripe = new Stripe(apiKey, stripeConfig);
    } else {
      this.stripe = new Stripe(apiKey, {
        apiVersion: '2026-05-27.dahlia' as Stripe.StripeConfig['apiVersion'],
      });
    }
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
- Default endpoint is `https://api.stripe.com` when `STRIPE_API_URL` is absent or empty.
- Providing `STRIPE_API_URL` configures `protocol`, `host`, and `port` on `Stripe.StripeConfig` with `apiVersion: '2026-05-27.dahlia'`.
- Fast-fail URL validation throws immediately on malformed URLs or non-`http:`/`https:` protocols during constructor execution.
- Compatible with loopback `mock-server.mjs` serving form-encoded payment intent and capture fixtures.
- Always verify webhook signature before processing.
- Frontend uses `@stripe/react-stripe-js` with `NEXT_PUBLIC_STRIPE_PUBLIC_KEY`.
- Backend uses `STRIPE_SECRET_KEY` — never expose to frontend.
- All payment state changes written to `audit_logs` table.
- Use Stripe test mode for all development — never use live keys locally.

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
- LangSmith records full traces for every agent run

**Temperature settings:**

- `0.3` — flight matching, scoring, extraction (deterministic results)
- `0.7` — conversational responses, trip suggestions (natural variation)

---

## LangSmith

### Tracing Setup

```typescript
// src/agents/agent.module.ts
import { Client } from 'langsmith';

export const langsmithClient = new Client({
  apiUrl: 'https://api.smith.langchain.com',
  apiKey: process.env.LANGSMITH_API_KEY!,
});
```

**Rules:**

- Every agent run is traced — tool calls, inputs, outputs, latency
- Trace ID propagated through all agent functions for correlation
- Traces used for debugging agent behavior, not for production monitoring dashboards
- Never log PII or payment data in traces — use `user_id` references only

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

---

## Pydantic v2 (Agent Wire Models & State Snapshots)

### Configuration and Strictness (`extra="forbid"`)

Pydantic v2 models define wire contracts and state persistence schemas for the Python Agent service (`apps/agent`). To prevent field smuggling, parameter injection, and schema drift, all wire and domain models MUST configure `ConfigDict(extra="forbid")`:

```python
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal, Optional, Dict, Any, List

# Wire Event Payload
class ActionHandoffPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = 1
    action: str = "begin_checkout"
    handoffToken: str
    expiresAt: str
    display: Dict[str, Any]

# Tagged Wire Event Model
class ActionHandoffEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: Literal["ACTION_HANDOFF"] = "ACTION_HANDOFF"
    data: ActionHandoffPayload

# Domain Snapshot State Model
class TrustedSearchSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    snapshotVersion: int = Field(gt=0)
    selectionAttestation: str
    offers: List[SafeFlightResult]
    createdAt: datetime
    expiresAt: datetime
```

### Discriminated Union Parsing & Serialization

Authoritative SSE event streams use tagged discriminated unions for safe polymorphic serialization:

```python
from pydantic import TypeAdapter
from typing import Annotated, Union

ChatTurnEvent = Annotated[
    Union[
        TokenEvent,
        ToolCallEvent,
        ToolResultEvent,
        FlightResultsEvent,
        ActionHandoffEvent,
        ActionRequiredEvent,
        DoneEvent,
        ErrorEvent,
    ],
    Field(discriminator="event"),
]

# Parsing untrusted wire event data
adapter = TypeAdapter(ChatTurnEvent)
event_instance = adapter.validate_python(raw_event_dict)

# Strict JSON serialization for SSE
sse_data = event_instance.model_dump_json(exclude_none=True)
```

**Rules:**

- Every payload model, envelope model, and snapshot domain model MUST specify `model_config = ConfigDict(extra="forbid")`.
- Passing unrecognized keys throws `pydantic.ValidationError` immediately (fail-closed).
- Never use `extra="allow"` or `extra="ignore"` on agent wire protocols.
- Use `TypeAdapter(ChatTurnEvent)` for safe polymorphic parsing of union types.
- Datetime fields in domain models must be timezone-aware UTC (`datetime.now(timezone.utc)`).

---

## Zod (Shared Schema & Type Inference Synchronization)

### Schema Definition & Type Inference Pattern

Shared validation contracts in `packages/shared/src/types/` use Zod as the single source of truth. TypeScript types are always inferred from schemas rather than maintained in parallel:

```typescript
import { z } from 'zod';

// 1. Primitive schemas with explicit constraints
const MoneyAmountSchema = z.string().regex(/^\d+(\.\d{1,2})?$/);
const IsoDateTimeSchema = z.string().datetime({ offset: true });

// 2. Strict object schemas (.strict() forbids unexpected keys)
export const BookingAirlineViewSchema = z
  .object({
    name: z.string().min(1),
    iataCode: z.string().min(1),
    logoUrl: z.string().url().optional(),
  })
  .strict();

export const BookingSegmentViewSchema = z
  .object({
    airline: BookingAirlineViewSchema,
    flightNumber: z.string().min(1),
    departureAirport: BookingAirportViewSchema,
    arrivalAirport: BookingAirportViewSchema,
    departureAt: IsoDateTimeSchema,
    arrivalAt: IsoDateTimeSchema,
    duration: z.string().min(1),
  })
  .strict();

// 3. Inferred TypeScript types derived directly from schemas
export type BookingAirlineView = z.infer<typeof BookingAirlineViewSchema>;
export type BookingSegmentView = z.infer<typeof BookingSegmentViewSchema>;
```

### Discriminated Outcome Patterns

Server-seam operations use generic discriminated outcome schemas to guarantee typed success and failure paths:

```typescript
export const BookingManagementFailureReasonSchema = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'STALE_REVISION',
  'INVALID_COMMAND',
  'UPSTREAM_UNAVAILABLE',
]);

export function BookingManagementOutcomeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      data: dataSchema,
    }),
    z.object({
      ok: z.literal(false),
      reason: BookingManagementFailureReasonSchema,
      message: z.string(),
      retryable: z.boolean(),
    }),
  ]);
}

export type BookingManagementOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: z.infer<typeof BookingManagementFailureReasonSchema>;
      message: string;
      retryable: boolean;
    };
```

**Rules:**

- All object schemas defining browser or wire views MUST chain `.strict()` to prevent property smuggling or unintended payload forwarding.
- Monetary values MUST be formatted as decimal strings (`/^\d+(\.\d{1,2})?$/`), never JavaScript `number`, to eliminate floating-point precision issues.
- Datetime strings MUST enforce ISO 8601 offset strings via `z.string().datetime({ offset: true })`.
- Types must NEVER be declared as independent interfaces and then separately cast; use `z.infer<typeof Schema>` exclusively.
- Upstream NestJS responses in `apps/web/lib/server/` must be validated with `Schema.safeParse(await response.json())` before returning outcomes.
