# Research: Duffel Flight Search Service

**Feature**: 006-flight-search-service
**Date**: 2026-07-07
**Provider Migration**: Amadeus Self-Service → Duffel API

## R0: API Provider Migration (Amadeus → Duffel)

**Decision**: Switch from Amadeus Self-Service API to Duffel API as the flight data provider.

**Rationale**: Amadeus Self-Service is no longer available for non-enterprise developers. Duffel offers: self-serve signup with sandbox access, an official TypeScript SDK (`@duffel/api`), simpler Bearer token auth (no OAuth2 refresh), a richer data model (slices → segments), and pay-as-you-go pricing (1500:1 search-to-book ratio instead of a hard monthly cap).

**Alternatives considered**:

- Stay on Amadeus → not viable, API access restricted to enterprise contracts.
- Kiwi.com Tequila API → less mature SDK, weaker data model, complex pricing.
- Skyscanner API → deprecated self-serve program.

**Impact on architecture**: Minimal. The abstraction boundary (`DuffelService` replacing `AmadeusService`) means all consumers (FlightsModule, AgentGatewayModule) are unaffected. Auth simplifies (no token refresh). Round-trip support improves (multi-slice native concept vs. query parameter). Budget tracking semantics remain identical — we still use a shared Redis counter with priority thresholds.

---

## R1: DuffelService Extraction Pattern

**Decision**: Create a standalone `DuffelModule` at `apps/api/src/duffel/` that exports `DuffelService`. Both the new `FlightsModule` (user-facing) and the existing `AgentGatewayModule` (chatbot) import from it.

**Rationale**: Same as the original AmadeusService extraction rationale — avoid duplicating API client initialization, caching, and budget tracking. The Duffel SDK simplifies this further since there's no OAuth2 token lifecycle to manage.

**Implementation detail**: `DuffelService` initializes the `@duffel/api` SDK with `DUFFEL_ACCESS_TOKEN`. It imports `CacheModule` for Redis access. Exports: `searchFlights(query, caller)` which handles caching, budget, and raw API calls.

---

## R2: Caching at Raw Response Level

**Decision**: Cache the raw Duffel `OfferRequest` response (including all offers) inside `DuffelService`, before any consumer-specific transformation.

**Rationale**: Identical to the Amadeus decision — if each consumer caches independently, identical queries from the chatbot and user search would make two separate API calls.

**Implementation detail**: Cache key = `flights:raw:${SHA-256(JSON.stringify({origin, destination, departureDate, returnDate, passengers}))}`. TTL = 900 seconds (15 minutes). The raw response includes the full offer list; consumers transform it independently.

---

## R3: Budget Priority Thresholds

**Decision**: Single shared Redis counter (`budget:duffel:YYYY-MM`) with caller-aware thresholds.

**Rationale**: Unchanged from Amadeus decision. User-facing searches must never be blocked by chatbot usage. Duffel's rate model (1500:1 search-to-book + 120 req/60s) is more generous than Amadeus's 2,000/month cap, but budget tracking remains valuable for cost control and prioritization.

**Implementation detail**: `DuffelService.searchFlights()` accepts `caller: 'user' | 'agent'`. Default thresholds: user cap = 1800, agent cap = 1200, total hard cap = 2000 (all configurable via env vars).

---

## R4: Round-Trip via Duffel Multi-Slice

**Decision**: Round-trip searches use Duffel's native multi-slice `offer_request`. One-way = 1 slice, round-trip = 2 slices.

**Rationale**: Duffel natively supports multi-slice journeys in a single API call. No need for separate one-way searches or special query parameters.

**Implementation detail**: The `searchFlights()` method builds a `slices` array:

- One-way: `[{ origin, destination, departure_date }]`
- Round-trip: `[{ origin, destination, departure_date }, { origin: destination, destination: origin, departure_date: returnDate }]`

Each offer in the response contains matching slices with segments.

---

## R5: Persistence Strategy — Hybrid Redis + PostgreSQL

**Decision**: Unchanged from Amadeus decision. Redis for hot lookup (900s TTL), PostgreSQL for durability with async write-behind. Two tables: `flight_offers` (raw blob, hard-purged after 7 days) and `search_history` (lightweight metadata, kept forever).

---

## R6: Flight Detail Re-pricing via Duffel

**Decision**: Re-price when the user loads the flight detail page using Duffel's `GET /air/offers/{offer_id}` endpoint.

**Rationale**: Duffel offers have built-in expiry tracking. Fetching a specific offer by ID returns its current availability and pricing. If the offer has expired on Duffel's side, the API returns an error — which maps cleanly to our 410 Gone recovery pattern.

**Implementation detail**: `GET /api/flights/:id` → look up raw offer from Redis/PostgreSQL → extract `duffelOfferId` → call `duffel.offers.get(duffelOfferId)` → return confirmed pricing. If Duffel returns an error (offer expired), fall through to the 410 recovery path.

---

## R7: Expired Offer Recovery (410 Gone)

**Decision**: Unchanged from Amadeus decision. Return 410 with original search parameters from `search_history`. Frontend shows guided recovery with pre-filled search form. No auto-re-execute.

---

## R8: Duffel SDK Integration Pattern

**Decision**: Use the official `@duffel/api` TypeScript SDK instead of raw HTTP calls.

**Rationale**: The SDK provides full TypeScript types, handles request/response serialization, and simplifies pagination. Unlike Amadeus (which had no official SDK), Duffel's SDK is maintained and well-typed.

**Implementation detail**:

```typescript
import { Duffel } from '@duffel/api';

const duffel = new Duffel({ token: process.env.DUFFEL_ACCESS_TOKEN });

// Search
const response = await duffel.offerRequests.create({
  data: {
    slices: [{ origin, destination, departure_date }],
    passengers: [{ type: 'adult' }],
    cabin_class: 'economy',
  },
});

// Re-price (get single offer)
const offer = await duffel.offers.get(duffelOfferId);
```
