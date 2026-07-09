# Quickstart: Cabin Class & Passenger Type Enhancement

**Feature**: 007-cabin-passenger-enhancement
**Date**: 2026-07-09

## Prerequisites

- Docker Desktop running (PostgreSQL + Redis)
- `DUFFEL_ACCESS_TOKEN` set in environment (live or test mode)
- Database migrated with new schema
- Airports seeded

## Setup

```bash
# From workspace root
docker compose up -d
npx prisma migrate dev --schema=apps/api/prisma/schema.prisma
npx prisma db seed --schema=apps/api/prisma/schema.prisma
pnpm dev
```

---

## Validation Scenarios

### Scenario 1: Cabin Class Selection — Economy (Baseline)

**Action**: `POST /api/flights/search` with `cabinClass: "economy"`, `adults: 1`

**Expected**: Results returned with `cabinClassMatch: "full"` for all offers. Each segment has `cabinClass: "economy"`. Behavior is identical to current (backward compatible).

### Scenario 2: Cabin Class Selection — Business

**Action**: `POST /api/flights/search` with `origin: "SGN"`, `destination: "NRT"`, `cabinClass: "business"`, `adults: 1`

**Expected**: Results prioritize business class. Some offers may be `cabinClassMatch: "mixed"` or `"downgraded"` with populated `cabinMismatchDetails`.

### Scenario 3: Mixed-Cabin Detection

**Action**: Search a multi-leg route (e.g., SGN → HAN → NRT, business class) where feeder segments may lack business class.

**Expected**: Offers with feeder segments in economy have `cabinClassMatch: "mixed"` (if the longest segment matches business) or `"downgraded"` (if the longest segment is economy). `cabinMismatchDetails` shows the specific mismatched segment with route.

### Scenario 4: Passenger Type Breakdown

**Action**: `POST /api/flights/search` with `adults: 2, children: 1, infants: 1`

**Expected**: Duffel returns pricing for 2 adults + 1 child + 1 infant. Price differs from 4 adults on the same route.

### Scenario 5: Passenger Validation — Infants > Adults

**Action**: `POST /api/flights/search` with `adults: 1, infants: 2`

**Expected**: 400 error: "Number of infants cannot exceed number of adults"

### Scenario 6: Passenger Validation — Total > 9

**Action**: `POST /api/flights/search` with `adults: 5, children: 3, infants: 2`

**Expected**: 400 error: "Maximum 9 passengers per search"

### Scenario 7: Cache Separation by Cabin Class

**Action**: Search SGN → NRT economy, then SGN → NRT business (same route/dates/passengers).

**Expected**: Second search is a cache miss (`cached: false`). Budget counter increments by 1 for each search.

### Scenario 8: 410 Recovery with Cabin/Passenger Data

**Action**: View a flight detail, then delete the offer from the database, then reload the detail page.

**Expected**: 410 response includes `recovery.cabinClass` and `recovery.adults/children/infants`. Frontend pre-fills search form with correct cabin and passenger breakdown.

### Scenario 9: Agent Gateway — Keyword Detection

**Action**: Send "find me business class flights from SGN to NRT for 2 adults and 1 child" to the chatbot.

**Expected**: Agent responds with limitation message. Keyword trigger logged. No flight search executed with business class.

### Scenario 10: Agent Gateway — Normal Search (No Keywords)

**Action**: Send "find flights from SGN to HAN tomorrow" to the chatbot.

**Expected**: Search proceeds normally with economy/adults defaults. No limitation message.

---

## Automated Test Commands

```bash
# Backend E2E — flight search (includes cabin class + passenger type tests)
npm run test:e2e --workspace=apps/api -- --testPathPattern=flights-search

# Backend E2E — flight detail (includes 410 recovery with cabin/passenger data)
npm run test:e2e --workspace=apps/api -- --testPathPattern=flights-detail

# Backend E2E — agent gateway regression
npm run test:e2e --workspace=apps/api -- --testPathPattern=agent-gateway

# Frontend Playwright
npx playwright test --config=apps/web/tests/playwright.config.ts
```
