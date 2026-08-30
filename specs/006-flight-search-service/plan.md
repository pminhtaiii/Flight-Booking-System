# Implementation Plan: Duffel Flight Search Service

**Branch**: `006-flight-search-service` | **Date**: 2026-07-07 | **Spec**: [spec.md](file:///c:/Booking%20Systems/specs/006-flight-search-service/spec.md)

**Input**: Feature specification from `/specs/006-flight-search-service/spec.md`

> **Migration note**: Switched from Amadeus Self-Service API to Duffel API. Amadeus is no longer available for non-enterprise developers. Duffel provides simpler auth (Bearer token), an official TypeScript SDK (`@duffel/api`), and a richer data model (slices/segments). All architectural decisions remain valid — only the upstream provider changes.

## Summary

Build the deterministic Duffel Flight Search Service — the core user-facing flight search pipeline with caching, budget management, async persistence (hybrid Redis/PostgreSQL), and flight detail re-pricing. The entire pipeline is strictly deterministic — no AI agents participate.

## Technical Context

**Language/Version**: TypeScript / Node.js

**Primary Dependencies**: NestJS, Next.js, Prisma, Redis, Duffel API (`@duffel/api` SDK)

**Storage**: PostgreSQL (durability), Redis (caching and budget)

**Testing**: Jest (backend E2E), Playwright (frontend E2E)

**Target Platform**: Web application (Frontend + API)

**Project Type**: web-service + frontend application

**Performance Goals**: < 5 seconds for uncached searches, < 1 second for cached searches

**Constraints**: Duffel rate limit (120 req/60s), 1500:1 search-to-book ratio; strict deterministic boundary

**Scale/Scope**: V1 MVP (Core booking flow)

## Constitution Check

_GATE: Passed._

- **I. Flight-First Architecture**: ✅ Feature is entirely focused on the core flight search pipeline.
- **II. Deterministic Transaction Boundary**: ✅ Feature explicitly excludes all AI agents; implements a strict deterministic pipeline.
- **III. API Budget Discipline**: ✅ Implements caching at the raw response level and strict budget tracking with priority thresholds.
- **IV. Observability & Operational Visibility**: ✅ Implements structured audit logging for search operations.
- **V. Incremental Delivery**: ✅ Feature is independently testable and isolated from the booking/payment steps.

## Project Structure

### Documentation (this feature)

```text
specs/006-flight-search-service/
├── plan.md              # This file
├── research.md          # Architectural decisions and research
├── data-model.md        # Prisma schema updates
├── quickstart.md        # E2E validation scenarios
└── contracts/
    └── api.md           # API endpoints and DTOs
```

### Source Code (repository root)

```text
apps/api/
├── src/
│   ├── duffel/          # NEW: Shared Duffel service with cache/budget
│   ├── flights/         # NEW: Deterministic flights controller & service
│   └── agent-gateway/   # MODIFIED: Refactored to import DuffelModule
├── prisma/
│   └── schema.prisma    # MODIFIED: Added FlightOffer and SearchHistory
└── test/
    └── flights.e2e-spec.ts # NEW: E2E tests for search endpoints

apps/web/
├── app/
│   └── search/
│       └── [flightId]/  # NEW: Flight detail page
├── components/
│   └── search/          # MODIFIED: Search forms and result lists
└── tests/
    └── search.spec.ts   # NEW: Frontend E2E test
```

**Structure Decision**: Monorepo layout. Backend changes concentrate in a new `duffel/` module (replaces `agent-gateway/amadeus/`) and a new `flights/` module. Frontend changes are localized to search pages and components.

---

## Implementation Phases

### Phase 1: DuffelService & Shared Module Extraction

> **Foundation phase** — everything else depends on this.
> **Estimated scope**: ~8 files created/modified

| Task                                                   | Status | Notes                                                     |
| ------------------------------------------------------ | ------ | --------------------------------------------------------- |
| Install `@duffel/api` SDK                              | ☐      | `pnpm add @duffel/api --filter @api/backend`              |
| Create `apps/api/src/duffel/duffel.module.ts`          | ☐      | NestJS module, exports `DuffelService`                    |
| Create `apps/api/src/duffel/duffel.service.ts`         | ☐      | Wraps SDK client; `searchFlights()` with caching + budget |
| Create `apps/api/src/duffel/duffel.types.ts`           | ☐      | TypeScript interfaces for raw Duffel responses            |
| Implement raw response caching in `DuffelService`      | ☐      | SHA-256 cache key, 900s TTL in Redis                      |
| Implement budget counter with priority thresholds      | ☐      | `budget:duffel:YYYY-MM`, env-configurable caps            |
| Add round-trip support via multi-slice offer_request   | ☐      | 1 slice = one-way, 2 slices = round-trip                  |
| Refactor `AgentGatewayModule` to import `DuffelModule` | ☐      | Remove local AmadeusService provider                      |
| Refactor `AgentGatewayService.searchFlights()`         | ☐      | Call `DuffelService`, transform to 5-result DTO           |
| Delete `apps/api/src/agent-gateway/amadeus/` directory | ☐      | Clean removal of old Amadeus code                         |
| Update `app.module.ts` to import `DuffelModule`        | ☐      | Global availability                                       |
| Verify agent-gateway E2E tests pass                    | ☐      | Regression check                                          |

**Exit criteria**: `DuffelService` is injectable, caching works, budget tracks, agent-gateway E2E passes.

---

### Phase 2: Database Schema — `flight_offers` & `search_history`

> **Data layer** — persistence foundation for detail pages and analytics.
> **Estimated scope**: ~3 files created/modified + 1 migration

| Task                                                          | Status | Notes                                                                    |
| ------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| Add `FlightOffer` model to `schema.prisma`                    | ☐      | UUID PK, searchHash, duffelOfferId, rawOffer (JSON), route fields, price |
| Add `SearchHistory` model to `schema.prisma`                  | ☐      | UUID PK, userId FK, route fields, resultCount, price range               |
| Add `searchHistory` relation to `User` model                  | ☐      | One-to-many, cascade delete                                              |
| Add indexes: `searchHash`, `createdAt`, `[userId, createdAt]` | ☐      | Performance for lookups and cleanup                                      |
| Run `npx prisma migrate dev`                                  | ☐      | Generate and apply migration                                             |
| Implement daily cron for `flight_offers` cleanup              | ☐      | `FLIGHT_OFFERS_RETENTION_DAYS` env var (default: 7)                      |

**Exit criteria**: Migration applied, both tables exist, cron deletes expired rows.

---

### Phase 3: FlightsModule — User-Facing Search Endpoint

> **Core feature** — the deterministic search pipeline.
> **Estimated scope**: ~6 files created + E2E tests

| Task                                                        | Status | Notes                                                                 |
| ----------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| Create `apps/api/src/flights/flights.module.ts`             | ☐      | Imports `DuffelModule`, `PrismaModule`, `CacheModule`, `AuditModule`  |
| Create `FlightSearchRequestDto` with validation             | ☐      | origin, destination, departureDate, returnDate (optional), passengers |
| Create `FlightOfferDto` and `FlightSearchResponseDto`       | ☐      | Rich 20-result DTOs with segments, pricing, internal UUID             |
| Create `flights.controller.ts` — `POST /api/flights/search` | ☐      | JWT-protected, class-validator validation                             |
| Create `flights.service.ts` — search orchestration          | ☐      | Calls DuffelService, transforms, returns response                     |
| Implement async write-behind persistence                    | ☐      | `setImmediate` → `Promise.all([writeOffers, writeHistory])`           |
| Register `FlightsModule` in `app.module.ts`                 | ☐      | —                                                                     |
| Write backend E2E tests for search endpoint                 | ☐      | Valid search, validation errors, budget exhausted, upstream down      |

**Exit criteria**: `POST /api/flights/search` returns transformed offers, async persistence writes complete, E2E passes.

---

### Phase 4: Flight Detail & Re-price Endpoint

> **Trust builder** — live pricing before booking commitment.
> **Estimated scope**: ~3 files modified + E2E tests

| Task                                                    | Status | Notes                                                            |
| ------------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| Add `GET /api/flights/:id` to `flights.controller.ts`   | ☐      | JWT-protected, UUID path param                                   |
| Implement `FlightsService.getFlightDetail()`            | ☐      | Redis → PostgreSQL fallback lookup chain                         |
| Implement Duffel re-price call (`GET /air/offers/{id}`) | ☐      | Live confirmed price on detail page load                         |
| Implement 410 Gone recovery pattern                     | ☐      | Query `search_history` for original params, return recovery data |
| Create `FlightDetailResponseDto`                        | ☐      | originalPrice, confirmedPrice, priceChanged flag, full segments  |
| Write backend E2E tests for detail endpoint             | ☐      | Valid offer, expired 410, never-existed 404, invalid UUID 400    |

**Exit criteria**: Detail page returns live pricing; expired offers return 410 with recovery params; E2E passes.

---

### Phase 5: Frontend Integration

> **User experience** — wiring the UI to the new API.
> **Estimated scope**: ~5 files created/modified

| Task                                                  | Status | Notes                                                       |
| ----------------------------------------------------- | ------ | ----------------------------------------------------------- |
| Wire search form to `POST /api/flights/search`        | ☐      | Origin, destination, dates, passengers, loading state       |
| Add round-trip toggle (one-way ↔ round-trip)          | ☐      | Shows/hides return date picker                              |
| Render flight results list below search form          | ☐      | Airline, times, duration, stops, price, fare class, baggage |
| Add "View Details" navigation to `/search/[flightId]` | ☐      | Internal UUID in URL                                        |
| Create flight detail page (`/search/[flightId]`)      | ☐      | Segment breakdown, confirmed price, price-changed indicator |
| Handle 410 expired offer with recovery UX             | ☐      | "Offer expired" notice + pre-filled search form             |
| Add "Book" placeholder button on detail page          | ☐      | Wired in future booking feature                             |

**Exit criteria**: Full search → results → detail page flow works E2E; expired offer recovery UX functions.

---

### Phase 6: E2E Testing & Verification

> **Quality gate** — comprehensive regression and smoke tests.
> **Estimated scope**: ~3 test files

| Task                                                             | Status | Notes                                           |
| ---------------------------------------------------------------- | ------ | ----------------------------------------------- |
| Backend E2E: search endpoint (valid, invalid, budget, upstream)  | ☐      | Jest                                            |
| Backend E2E: detail endpoint (valid, expired 410, not-found 404) | ☐      | Jest                                            |
| Backend E2E: cache hit verification                              | ☐      | Same query → no budget increment                |
| Backend E2E: async write-behind verification                     | ☐      | `flight_offers` + `search_history` rows created |
| Agent-gateway regression: chatbot search still works             | ☐      | Shared DuffelService, shared budget             |
| Agent-gateway regression: budget priority enforcement            | ☐      | Agent throttled before user                     |
| Frontend smoke: search → results → detail flow                   | ☐      | Playwright                                      |
| Frontend smoke: expired offer recovery UX                        | ☐      | Playwright                                      |

**Exit criteria**: All E2E tests pass; agent-gateway regression clean; frontend flows verified.

---

## Environment Variables

| Variable                       | Default | Purpose                                                                     |
| ------------------------------ | ------- | --------------------------------------------------------------------------- |
| `DUFFEL_ACCESS_TOKEN`          | —       | Duffel API access token (replaces `AMADEUS_API_KEY` + `AMADEUS_API_SECRET`) |
| `DUFFEL_BUDGET_LIMIT_USER`     | 1800    | User-facing search throttle threshold                                       |
| `DUFFEL_BUDGET_LIMIT_AGENT`    | 1200    | Agent/chatbot throttle threshold                                            |
| `DUFFEL_BUDGET_LIMIT_TOTAL`    | 2000    | Absolute monthly cap                                                        |
| `FLIGHT_OFFERS_RETENTION_DAYS` | 7       | Days before cron purges `flight_offers` rows                                |

## Verification Plan

### Automated Tests

```bash
# Backend E2E
npm run test:e2e --workspace=apps/api -- --testPathPattern=flights

# Agent-gateway regression
npm run test:e2e --workspace=apps/api -- --testPathPattern=agent-gateway

# Frontend Playwright
npx playwright test --config=apps/web/tests/playwright.config.ts
```

### Manual Verification

- Search for flights via the frontend (one-way and round-trip)
- Verify cache hits on repeated searches (response time < 1s)
- Click "View Details" and verify live re-confirmed pricing
- Test budget exhaustion by setting low thresholds
- Test expired offer recovery (delete offer from DB, navigate to detail URL)
- Verify chatbot still returns 5-result flight search through agent-gateway
