# Quickstart: Duffel Flight Search Service

**Feature**: 006-flight-search-service
**Date**: 2026-07-07

## Prerequisites

1. Docker Desktop running (PostgreSQL + Redis via `docker compose up -d`)
2. Prisma migrations applied: `npx prisma migrate dev --schema=apps/api/prisma/schema.prisma`
3. Database seeded: `npx prisma db seed --schema=apps/api/prisma/schema.prisma`
4. Duffel API credentials configured in `apps/api/.env`:
   ```
   DUFFEL_ACCESS_TOKEN=duffel_test_xxxxxxxxxxxxx
   ```
5. Budget thresholds configured (optional, defaults apply):
   ```
   DUFFEL_BUDGET_LIMIT_USER=1800
   DUFFEL_BUDGET_LIMIT_AGENT=1200
   DUFFEL_BUDGET_LIMIT_TOTAL=2000
   FLIGHT_OFFERS_RETENTION_DAYS=7
   ```

## Starting the Services

```bash
# Start infrastructure
docker compose up -d

# Start NestJS backend (port 3001)
pnpm --filter @api/backend start:dev

# Start Next.js frontend (port 3000)
pnpm --filter @web/frontend dev
```

## Validation Scenarios

### Scenario 1: One-Way Flight Search (P1 — Core Value)

**Steps**:

1. Log in to the frontend at `http://localhost:3000/login`
2. Navigate to the Search page
3. Enter origin: LHR, destination: JFK, departure date: (any future date), passengers: 1
4. Leave return date empty (one-way)
5. Click "Search Flights"

**Expected outcome**:

- Up to 20 flight results appear below the search form
- Each result shows: airline name, flight number, times, duration, stops, price, fare class, baggage
- Response time: < 5 seconds for first search, < 1 second for repeated identical search (cache hit)

**Verification commands** (backend-only, without frontend):

```bash
# Direct API call
curl -X POST http://localhost:3001/api/flights/search \
  -H "Authorization: Bearer <jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{"origin":"LHR","destination":"JFK","departureDate":"2026-07-15","passengers":1}'
```

> **Note**: In Duffel test mode, use "Duffel Airways" routes. Popular test routes include LHR↔JFK, LHR↔CDG, JFK↔LAX.

---

### Scenario 2: Round-Trip Flight Search (P1)

**Steps**:

1. Same as Scenario 1, but toggle to "Round-trip" and enter a return date
2. Click "Search Flights"

**Expected outcome**:

- Results include both outbound and return itinerary segments
- Each result has `segments` (outbound) and `returnSegments` (return)

**Verification command**:

```bash
curl -X POST http://localhost:3001/api/flights/search \
  -H "Authorization: Bearer <jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{"origin":"LHR","destination":"JFK","departureDate":"2026-07-15","returnDate":"2026-07-20","passengers":2}'
```

---

### Scenario 3: Flight Detail with Live Re-pricing (P2)

**Steps**:

1. Perform a search (Scenario 1 or 2)
2. Copy the `id` field from any result
3. Navigate to `/search/<id>` or click "View Details"

**Expected outcome**:

- Detail page shows full flight information with `confirmedPrice` (live from Duffel)
- If price changed, a `priceChanged: true` flag is present with both `originalPrice` and `confirmedPrice`
- Duffel-specific data like `expiresAt` and `conditions` (refundable/changeable) are displayed

**Verification command**:

```bash
curl http://localhost:3001/api/flights/<uuid> \
  -H "Authorization: Bearer <jwt-token>"
```

---

### Scenario 4: Expired Offer Recovery (P2)

**Steps**:

1. Wait for a flight offer to be purged (or manually delete it from the database for testing)
2. Navigate to `/search/<expired-uuid>`

**Expected outcome**:

- HTTP 410 response with `code: "OFFER_EXPIRED"`
- Response includes `recovery` object with original search parameters
- Frontend shows "Offer expired" notice with pre-filled search form

**Verification command**:

```bash
# Should return 410 with recovery params
curl -i http://localhost:3001/api/flights/00000000-0000-0000-0000-000000000000 \
  -H "Authorization: Bearer <jwt-token>"
```

---

### Scenario 5: Budget Exhaustion Handling

**Steps**:

1. Temporarily set `DUFFEL_BUDGET_LIMIT_USER=1` in `.env` and restart the backend
2. Perform two flight searches

**Expected outcome**:

- First search succeeds
- Second search returns HTTP 429 with a friendly message
- Agent/chatbot searches should be throttled before user searches

---

### Scenario 6: Cache Hit Verification

**Steps**:

1. Perform a search
2. Immediately perform the exact same search again

**Expected outcome**:

- Second response includes `meta.cached: true`
- Response time is significantly faster (< 1 second)
- Redis budget counter only incremented once (not twice)

**Verification**:

```bash
# Check budget counter
redis-cli GET "budget:duffel:2026-07"
# Should be 1, not 2
```

---

### Scenario 7: Async Persistence Verification

**Steps**:

1. Perform a search
2. Query the database for newly created records

**Expected outcome**:

- `flight_offers` table has rows with matching `searchHash`
- `search_history` table has a row with the user's ID and search metadata
- Both were created after the response was returned (non-blocking)

**Verification**:

```bash
# Check tables via Prisma Studio
npx prisma studio --schema=apps/api/prisma/schema.prisma
# Navigate to FlightOffer and SearchHistory tables
```

---

## E2E Test Commands

```bash
# Backend E2E tests
npm run test:e2e --workspace=apps/api

# Specific flight search tests (once written)
npm run test:e2e --workspace=apps/api -- --testPathPattern=flights

# Agent-gateway regression
npm run test:e2e --workspace=apps/api -- --testPathPattern=agent-gateway
```

## Troubleshooting

| Issue                                   | Solution                                                              |
| --------------------------------------- | --------------------------------------------------------------------- |
| "Duffel access token is not configured" | Check `DUFFEL_ACCESS_TOKEN` in `apps/api/.env`                        |
| 502 Bad Gateway on search               | Duffel API may be down; check https://www.duffelstatus.com            |
| 429 Too Many Requests                   | Budget exhausted; check Redis key `budget:duffel:YYYY-MM` or reset it |
| Empty search results                    | In test mode, use Duffel Airways routes (LHR↔JFK, LHR↔CDG)            |
| "Rate limit exceeded" from Duffel       | You're exceeding 120 req/60s; add backoff or check for runaway loops  |
