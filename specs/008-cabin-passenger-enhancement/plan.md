# Implementation Plan: Cabin Class & Passenger Type Enhancement

**Branch**: `008-cabin-passenger-enhancement` | **Date**: 2026-07-09 | **Spec**: [spec.md](file:///c:/Booking%20Systems/specs/008-cabin-passenger-enhancement/spec.md)

**Input**: Grilling session decisions from [research](file:///c:/Booking%20Systems/research/cabin-passenger-enhancement-decisions.md)

> **Context**: This feature extends the completed 006-flight-search-service. The search pipeline, Duffel integration, caching, budget tracking, persistence, and frontend are all in place. This plan adds cabin class selection, passenger type diversity, and mixed-cabin validation.

## Summary

Extend the flight search pipeline to support user-selectable cabin classes (`economy`, `premium_economy`, `business`, `first`) and passenger type breakdown (`adults`, `children`, `infants`). Add a deterministic three-tier cabin match classification (`full`/`mixed`/`downgraded`) with per-segment mismatch details. Update the agent gateway with honest degradation for unsupported requests.

## Technical Context

**Language/Version**: TypeScript / Node.js

**Primary Dependencies**: NestJS, Next.js, Prisma, Redis, Duffel API (`@duffel/api` SDK)

**Storage**: PostgreSQL (schema migration), Redis (cache key expansion)

**Testing**: Jest (backend E2E), Playwright (frontend E2E)

**Target Platform**: Web application (Frontend + API)

**Performance Goals**: No regression from current <5s uncached, <1s cached

**Constraints**: Duffel rate limit (120 req/60s), expanded cache key space, 2000/month budget cap

## Constitution Check

*GATE: Passed.*

- **I. Flight-First Architecture**: ✅ Extends core flight search — cabin class and passenger types are fundamental search parameters.
- **II. Deterministic Transaction Boundary**: ✅ All changes are in the deterministic pipeline. Cabin match classification uses a deterministic algorithm (longest-duration segment rule). No AI involvement.
- **III. API Budget Discipline**: ✅ Cache key expansion is correct (different cabins = different offers). Budget caps remain unchanged. Cache still prevents duplicate calls.
- **IV. Observability & Operational Visibility**: ✅ Audit logging already captures search parameters — will now include cabin class and passenger breakdown. Agent keyword triggers logged for analytics.
- **V. Incremental Delivery**: ✅ Feature is independently testable. Backward compatible with economy/adults defaults.

## Project Structure

### Documentation (this feature)

```text
specs/008-cabin-passenger-enhancement/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Architectural decisions
├── data-model.md        # Schema changes
├── quickstart.md        # E2E validation scenarios
└── contracts/
    └── api.md           # API contract changes
```

### Source Code Changes

```text
apps/api/
├── prisma/
│   └── schema.prisma           # MODIFIED: passengers → adults/children/infants + cabinClass
├── src/
│   ├── duffel/
│   │   ├── duffel.service.ts   # MODIFIED: cabin_class param, passenger mapper, cache key
│   │   └── duffel.types.ts     # MODIFIED: add cabin class types if needed
│   ├── flights/
│   │   ├── flights.service.ts  # MODIFIED: cabin match classification, mismatch details
│   │   ├── flights.controller.ts # MODIFIED: accept new DTO fields
│   │   └── dto/
│   │       ├── search-flight.dto.ts  # MODIFIED: flat passenger fields, cabinClass, mismatch DTOs
│   │       └── detail-flight.dto.ts  # MODIFIED: cabin match fields
│   └── agent-gateway/
│       ├── agent-gateway.service.ts  # MODIFIED: keyword detection, same DTO shape
│       └── agent-gateway.constants.ts # NEW: keyword lists for cabin/passenger detection
└── test/
    ├── flights-search.e2e-spec.ts    # MODIFIED: cabin class + passenger type tests
    ├── flights-detail.e2e-spec.ts    # MODIFIED: 410 recovery with cabin/passenger data
    └── agent-gateway.e2e-spec.ts     # MODIFIED: keyword detection tests

apps/web/
├── components/
│   └── search/
│       ├── SearchPageClient.tsx       # MODIFIED: cabin selector, passenger picker, mismatch badges
│       └── FlightDetailPageClient.tsx # MODIFIED: cabin match display
└── tests/
    └── search.spec.ts                # MODIFIED: cabin class + passenger type E2E
```

---

## Implementation Phases

### Phase 1: Database Schema Migration

> **Foundation** — schema must be in place before any service changes.
> **Estimated scope**: ~2 files modified + 1 migration

| Task | Status | Notes |
|------|--------|-------|
| Modify `schema.prisma`: replace `passengers` with `adults`, `children`, `infants`, `cabinClass` on `FlightOffer` | ☐ | Add defaults for backward compat |
| Modify `schema.prisma`: same changes on `SearchHistory` | ☐ | Same pattern |
| Run `npx prisma migrate dev` (or `prisma migrate reset` since dev-only data) | ☐ | Generate migration |
| Verify Prisma client types regenerated correctly | ☐ | `npx prisma generate` |

**Exit criteria**: Migration applied, both tables have new columns, old `passengers` column removed, Prisma client types reflect changes.

---

### Phase 2: DuffelService — Cabin Class & Passenger Mapper

> **Core plumbing** — DuffelService is the shared foundation for both FlightsModule and AgentGateway.
> **Estimated scope**: ~3 files modified

| Task | Status | Notes |
|------|--------|-------|
| Create isolated `mapPassengersToDuffel(adults, children, infants)` function | ☐ | Single seam for future type additions |
| Modify `searchFlights()` signature to accept `cabinClass` and `adults/children/infants` | ☐ | Replace `passengers: number` param |
| Pass `cabin_class` to `duffel.offerRequests.create()` | ☐ | Currently hardcoded to `economy` |
| Pass mapped passenger array to `duffel.offerRequests.create()` | ☐ | Currently hardcoded to all adults |
| Update cache key SHA-256 to include `cabinClass`, `adults`, `children`, `infants` | ☐ | Remove old `passengers` from key |
| Update mock data generation for test environments | ☐ | Include `cabin_class` in mock segments |
| Update `duffel.types.ts` if Duffel SDK types need extension | ☐ | Check `cabin_class` on segment types |

**Exit criteria**: `DuffelService.searchFlights()` accepts cabin class and passenger breakdown, passes them to Duffel API, cache key is correctly expanded.

---

### Phase 3: FlightsModule — Cabin Match Classification & DTOs

> **Core feature** — the deterministic cabin match algorithm and updated response DTOs.
> **Estimated scope**: ~5 files modified

| Task | Status | Notes |
|------|--------|-------|
| Update `FlightSearchRequestDto`: replace `passengers` with `adults`, `children`, `infants`, add `cabinClass` | ☐ | class-validator decorators + cross-field validation |
| Add custom validator: `infants ≤ adults`, `total ≤ 9` | ☐ | Cross-field validation decorator |
| Add `cabinClass` to `FlightSegmentDto` | ☐ | From Duffel segment's `passengers[0].cabin_class` |
| Add `requestedCabinClass`, `cabinClassMatch`, `cabinMismatchDetails` to `FlightOfferDto` | ☐ | New fields |
| Create `CabinMismatchDetail` interface | ☐ | segmentIndex, leg, expected, actual, route |
| Implement cabin match classification in `flights.service.ts` | ☐ | Deterministic: longest-segment rule |
| Update `mapSegment()` to extract per-segment `cabinClass` | ☐ | From Duffel's segment passenger cabin_class |
| Update `mapOffer()` to compute classification and mismatch details | ☐ | Iterate all segments, find longest, classify |
| Update `search()` to pass new fields to `DuffelService` | ☐ | cabinClass, adults, children, infants |
| Update async write-behind to persist new fields | ☐ | adults, children, infants, cabinClass on FlightOffer + SearchHistory |
| Update `FlightDetailResponseDto` with cabin match fields | ☐ | Same classification on re-priced offer |
| Update `getFlightDetail()` to compute cabin match on live offer | ☐ | Re-classify from live Duffel data |
| Update 410 recovery response with cabin/passenger data | ☐ | From SearchHistory new columns |

**Exit criteria**: Search returns offers with cabin match classification, per-segment cabin class, and mismatch details. Detail page shows the same. 410 recovery includes cabin/passenger data.

---

### Phase 4: Agent Gateway — Honest Degradation

> **Trust layer** — prevent silent downgrades in the chatbot.
> **Estimated scope**: ~3 files modified/created

| Task | Status | Notes |
|------|--------|-------|
| Create `agent-gateway.constants.ts` with keyword lists | ☐ | Cabin keywords: business, first, premium; Passenger keywords: child, kid, infant, baby, toddler |
| Add keyword detection function in `AgentGatewayService` | ☐ | Scan user message before search execution |
| Add honest limitation response when keywords detected | ☐ | Clear message directing to search page |
| Log keyword triggers with structured metadata | ☐ | For future upgrade analytics |
| Update `AgentGatewayService.searchFlights()` to use same DTO shape | ☐ | Map to new request shape: `adults` derived from the incoming passenger count, `children: 0, infants: 0, cabinClass: 'economy'` |
| Verify agent gateway E2E tests still pass | ☐ | Regression check |

**Exit criteria**: Agent detects unsupported requests, responds honestly, logs triggers. Normal searches work unchanged. Same DTO shape as frontend.

---

### Phase 5: Frontend Integration

> **User experience** — cabin selector, passenger picker, mismatch badges.
> **Estimated scope**: ~3 files modified

| Task | Status | Notes |
|------|--------|-------|
| Add cabin class dropdown to search form | ☐ | economy/premium_economy/business/first |
| Add passenger type picker (adults/children/infants) | ☐ | Replace single passenger count input |
| Add client-side validation (infants ≤ adults, total ≤ 9) | ☐ | Inline error messages |
| Update search API call to send new fields | ☐ | cabinClass, adults, children, infants |
| Display `cabinClassMatch` badge on each result card | ☐ | Yellow for mixed, red for downgraded, hidden for full |
| Add expandable mismatch details on result cards | ☐ | Show per-segment cabin info |
| Update flight detail page with cabin match display | ☐ | Same badge + details on detail page |
| Update 410 recovery redirect to include cabin/passenger params | ☐ | Pre-fill search form with correct values |
| Handle "no results" for premium cabins with helpful message | ☐ | Suggest trying a different cabin class |

**Exit criteria**: Full search flow works with cabin selection and passenger types. Mismatch badges display correctly. Recovery pre-fills all fields.

---

### Phase 6: E2E Testing & Verification

> **Quality gate** — comprehensive tests for all new functionality.
> **Estimated scope**: ~4 test files modified

| Task | Status | Notes |
|------|--------|-------|
| Backend E2E: cabin class search (economy, business, first) | ☐ | Verify `cabin_class` passed to Duffel |
| Backend E2E: mixed-cabin classification | ☐ | Mock mixed-cabin response, verify classification |
| Backend E2E: downgraded classification | ☐ | Mock longest-segment mismatch |
| Backend E2E: passenger type validation (infants > adults, total > 9) | ☐ | 400 errors |
| Backend E2E: passenger breakdown in Duffel request | ☐ | Verify mapper output |
| Backend E2E: cache separation by cabin class | ☐ | Same route, different cabin = cache miss |
| Backend E2E: 410 recovery with cabin/passenger data | ☐ | Verify recovery object |
| Backend E2E: agent gateway keyword detection | ☐ | "business class" triggers limitation |
| Backend E2E: agent gateway normal search (no keywords) | ☐ | Search proceeds with defaults |
| Agent-gateway regression: existing tests still pass | ☐ | No breakage |
| Frontend Playwright: cabin selector + passenger picker | ☐ | UI interaction test |
| Frontend Playwright: mismatch badge display | ☐ | Visual verification |

**Exit criteria**: All E2E tests pass. No regression on existing functionality.

---

## Environment Variables

No new environment variables required. Existing variables are sufficient:

| Variable | Default | Impact |
|----------|---------|--------|
| `DUFFEL_ACCESS_TOKEN` | — | Already exists — now sends `cabin_class` in requests |
| `DUFFEL_BUDGET_LIMIT_*` | 1800/1200/2000 | Unchanged — cache key expansion accepted |

## Verification Plan

### Automated Tests

```bash
# Backend E2E — all flight tests
npm run test:e2e --workspace=apps/api -- --testPathPattern=flights

# Agent-gateway regression
npm run test:e2e --workspace=apps/api -- --testPathPattern=agent-gateway

# Frontend Playwright
npx playwright test --config=apps/web/tests/playwright.config.ts
```

### Manual Verification

- Search SGN → NRT in economy, then business — verify different results and cache separation
- Search with 2 adults + 1 child — verify price differs from 3 adults
- Look for mixed-cabin offers on multi-leg routes — verify yellow badge with per-segment details
- Test "find me business class" in chatbot — verify honest limitation response
- Delete a flight offer from DB, reload detail page — verify 410 recovery includes cabin/passenger data
- Try infants > adults — verify 400 validation error in both API and frontend
