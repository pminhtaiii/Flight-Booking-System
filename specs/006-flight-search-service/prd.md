# PRD: Duffel Flight Search Service

**Feature**: 006-flight-search-service
**Date**: 2026-07-07
**Status**: Ready for Development
**Priority**: P1 — Core Platform Feature

## Problem Statement

Travelers currently have no way to search for flights directly on the platform. The only path to flight data is through the AI chatbot, which returns a limited 5-result summary via an internal tool — no browsing, no detail pages, no price confirmation, and no ability to compare options side-by-side. If a user wants to explore routes, compare airlines, or verify pricing before committing, the platform offers nothing. The chatbot also quietly consumes API budget with no priority distinction, meaning heavy chatbot usage could silently exhaust search capacity for real users trying to book travel. Without a dedicated flight search experience, the platform's core value proposition — helping travelers plan and book trips — is incomplete.

## Solution

A full, deterministic flight search pipeline that gives travelers direct control over discovering and evaluating flights. Users fill out a search form (origin, destination, dates, passengers), receive up to 20 rich flight offers with pricing, airline details, durations, stops, fare classes, and baggage info — all within seconds. Clicking any result opens a detail page with a live re-confirmed price so users always see the real cost before moving toward booking.

The search is fast: repeated queries hit a shared cache and return instantly without burning API budget. Budget is managed intelligently — user-facing searches get priority over chatbot usage, so real travelers are never blocked. Results are persisted behind the scenes for detail page lookups and analytics, while expired offers are handled gracefully with a guided recovery flow instead of a dead-end error page. Round-trip and one-way searches are supported from day one. The entire pipeline is deterministic — no AI agents touch any part of search, caching, pricing, or persistence.

## User Stories

1. **As a traveler**, I want to enter my origin, destination, travel dates, and passenger count into a search form so that I can discover available flights on my route.

2. **As a traveler**, I want to see up to 20 flight results with airline name, flight number, departure/arrival times, duration, number of stops, price, currency, fare class, and baggage allowance so that I can compare options at a glance.

3. **As a traveler**, I want to toggle between one-way and round-trip search so that I can find flights that match my travel plans without performing separate searches.

4. **As a traveler searching round-trip**, I want to see both outbound and return itineraries bundled in each result so that I can evaluate the full journey as a single unit.

5. **As a traveler**, I want to click "View Details" on any search result to see a comprehensive flight breakdown — full segment details, layover information, terminal assignments, aircraft type, and a live re-confirmed price — so that I can make an informed decision before proceeding toward booking.

6. **As a traveler**, I want to see a clear indicator if the price has changed since my search so that I am never surprised by a different price at checkout.

7. **As a traveler**, I want my repeated identical searches to return results instantly (from cache) so that browsing back and forth between results is fast and seamless.

8. **As a traveler**, I want cached searches to not consume additional API calls so that the platform's monthly budget is preserved for new unique searches.

9. **As a traveler**, I want my searches to be prioritized over chatbot-initiated searches so that I am never blocked from searching because the AI assistant consumed all the API capacity.

10. **As a traveler**, I want a clear, friendly message when search capacity has been temporarily reached so that I understand the situation and know to try again later rather than seeing a cryptic error.

11. **As a traveler**, I want expired flight offers to show a guided recovery screen with my original search parameters pre-filled so that I can re-search with one click instead of starting from scratch.

12. **As a traveler**, I want validation feedback when I enter an invalid airport code, a past departure date, or an out-of-range passenger count so that I can correct my input before wasting time on a failed search.

13. **As a traveler**, I want the search to handle zero-result scenarios gracefully — with a clear "no flights found" message — so that I know the route or date has no availability rather than thinking the system is broken.

14. **As a traveler**, I want the system to handle external data source outages with a clear error message so that I understand it is a temporary issue and not a platform bug.

15. **As a platform owner**, I want every search to be recorded as lightweight metadata (route, dates, price range, result count) so that dashboard analytics can surface "Top Destinations" and "Spending by Month" insights.

16. **As a platform owner**, I want raw flight offer data to be automatically purged after a configurable retention window so that the database does not grow unbounded with stale data.

17. **As a platform owner**, I want search history metadata to be preserved indefinitely (even after raw offers are purged) so that long-term analytics and "Recently Searched" features remain functional.

18. **As a platform owner**, I want all search operations to be fully auditable — with structured logs including user identity, search parameters, result count, and response time — so that operational issues can be traced without logging PII.

19. **As a chatbot user**, I want the AI assistant's flight search to continue working exactly as before — returning its 5-result summary — so that the new user-facing search does not break the existing chatbot experience.

20. **As a platform owner**, I want a single shared budget counter across user and chatbot searches so that total API usage is easy to monitor and never exceeds the hard monthly cap.

21. **As a traveler**, I want the system to respond quickly even though search data is being persisted to the database — persistence should never add latency to my search results.

## Implementation Decisions

### DuffelService Extraction to Shared Module
The existing flight data API client is currently embedded within the agent-gateway module, making it inaccessible to other consumers without violating module encapsulation. The service will be extracted into its own standalone shared module (`DuffelModule`) that both the new user-facing flights module and the existing agent-gateway module import. This eliminates the need to duplicate API client initialization, caching logic, or budget tracking. The shared service becomes the single point of contact with the Duffel API — no other service makes direct HTTP calls to Duffel. Unlike the previous Amadeus integration which required OAuth2 token refresh, Duffel uses a simple Bearer token, simplifying the service significantly.

### Raw Response Caching Strategy
Caching happens at the raw Duffel offer response level inside the shared service — before any consumer-specific transformation. The cache key is a SHA-256 hash of the normalized search parameters (origin, destination, departureDate, returnDate, passengers). TTL is 900 seconds (15 minutes). Each consumer receives the raw response and independently transforms it into its own DTO shape (20 rich results for user search, 5 simplified results for chatbot). This ensures identical queries from different consumers share a single cached result and never double-spend API budget.

### Budget Priority Thresholds
A single shared Redis counter (`budget:duffel:YYYY-MM`) tracks all API calls. The service accepts a caller type parameter (`user` or `agent`) and applies different thresholds: user-facing searches are allowed up to a higher configurable cap (default 1,800), agent/chatbot searches are throttled at a lower cap (default 1,200), and a hard total cap (default 2,000) stops all callers. This guarantees user-facing searches are never blocked by chatbot usage while keeping budget tracking simple with a single counter. All thresholds are configurable via environment variables, not hardcoded. Note: Duffel's actual rate model is 120 req/60s + 1500:1 search-to-book ratio, which is more generous than the old Amadeus 2,000/month cap — but budget tracking remains valuable for cost control.

### Hybrid Persistence (Redis + PostgreSQL)
Redis provides sub-millisecond hot lookups during active browsing sessions (self-expiring at 900s TTL). PostgreSQL provides durability beyond the Redis TTL for the flight detail page and for analytics. This hybrid approach gives the best of both worlds: fast reads during the browsing session and durable storage for detail pages and history.

### Async Write-Behind for Zero-Latency Persistence
After the search response is returned to the user, persistence to PostgreSQL happens asynchronously in a post-response hook. Both the `flight_offers` rows (raw offer blobs) and the `search_history` row (lightweight metadata) are written simultaneously in the async step. This ensures the database write never adds latency to the user's critical response path.

### Two-Table Design
Flight data is split across two tables with different lifecycles. The `flight_offers` table stores raw offer blobs and is hard-purged by a daily cron job after a configurable retention window (default 7 days). The `search_history` table stores lightweight metadata (route, dates, price range, result count) and is preserved indefinitely for dashboard analytics and future "Recently Searched" features. No foreign key constraint links them — they share a conceptual `searchHash` link but have independent retention policies.

### Flight Detail Re-Pricing Trigger Timing
The re-price call to the Duffel API (`GET /air/offers/{id}`) happens when the user loads the flight detail page — not at the final booking confirmation step. This ensures users see the real, confirmed price before entering any payment flow. Duffel offers have built-in expiry tracking, making the re-price call a natural fit — if the offer has expired on Duffel's side, the API returns an error which maps cleanly to our 410 Gone recovery pattern.

### Expired Offer 410 Gone Recovery Pattern
When a flight offer UUID is requested but the offer has been purged from both Redis and PostgreSQL, the system returns HTTP 410 Gone (not 404). The response includes the original search parameters recovered from the `search_history` table, which always retains metadata. The frontend uses these parameters to pre-fill the search form, offering one-click re-search. The system does not auto-re-execute the search because the user's plans may have changed.

### Internal UUID vs Duffel Offer IDs
All API contracts and URLs use internally generated UUIDs from the `flight_offers` table — never raw Duffel offer IDs. This decouples the frontend from the external data source, prevents leaking third-party identifiers, and ensures stable URLs even if the upstream ID format changes.

### Round-Trip Support via Duffel Multi-Slice
Round-trip is supported from day one by constructing a multi-slice `offer_request`. One-way uses a single slice; round-trip uses two slices (outbound + return). Duffel natively supports this in a single API call — no need for two separate one-way searches. The return date is included in cache key normalization and is validated to be on or after the departure date.

## Testing Decisions

### Testing Philosophy
All tests target external behavior (API contracts, HTTP status codes, response shapes, observable side effects) — not internal implementation details. Tests should be resilient to refactors; changing how a service is internally structured should not break tests as long as the behavior is preserved.

### Backend E2E Tests
The backend API E2E test suite will cover the full search and detail lifecycle:
- **Search endpoint**: Valid search returns correctly shaped results with all required fields; missing or invalid fields return 400 with descriptive errors; budget-exhausted state returns 429 with a user-friendly message; upstream unavailability returns 502.
- **Detail endpoint**: Valid offer UUID returns enriched details with confirmed pricing; expired offer UUID returns 410 with recovery parameters; never-existed UUID returns 404; invalid UUID format returns 400.
- **Cache behavior**: Two identical searches in succession — the second must return results without incrementing the budget counter, verifying the cache is working.
- **Budget counter**: Searches increment the shared counter; caller-type thresholds are enforced correctly.
- **Async persistence**: After a search response is returned, the `flight_offers` and `search_history` rows must eventually appear in the database (verified with a short poll or event-based assertion).

### Frontend Smoke Tests
Frontend tests will verify the critical user flows end-to-end:
- Search form submission renders results with expected data fields.
- Clicking "View Details" navigates to the detail page and displays confirmed pricing.
- An expired offer triggers the recovery UX with a pre-filled search form.
- Round-trip toggle correctly shows/hides the return date picker and adjusts the API call.

### Agent-Gateway Regression Tests
The existing agent-gateway E2E tests must continue to pass after the DuffelService extraction. Additional regression tests will verify:
- The chatbot's `search_flights` tool still returns its 5-result simplified format.
- The shared budget counter is incremented by both user and chatbot searches.
- The chatbot is throttled at its lower threshold while user searches continue.

## Out of Scope

- **Booking and payment flow** — "Proceed to Booking" is a placeholder action; the full booking, payment, and ticketing pipeline is a separate future feature.
- **Mobile-specific optimization** — the responsive web experience is sufficient for this feature; native mobile apps or mobile-specific UX are not included.
- **Hotel and restaurant integration** — the search feature covers flights only; other travel verticals are separate features.
- **AI-powered search ranking** — results are returned in the order provided by the Amadeus API; AI-driven personalization or re-ranking is not part of this feature.
- **Multi-city flights** — only one-way and round-trip itineraries are supported; complex multi-city routing is out of scope.
- **Seat selection** — the search and detail views show fare class and baggage but do not support seat map browsing or seat assignment.
- **Ancillary services** — add-ons such as extra baggage, lounge access, travel insurance, or meal selection are not part of this feature.

## Further Notes

### 6-Phase Delivery Plan
The feature is structured into six sequential phases: (1) DuffelService extraction and shared module setup using the `@duffel/api` TypeScript SDK, (2) database schema creation for `flight_offers` and `search_history` with migration and cron cleanup, (3) user-facing search endpoint with async write-behind persistence, (4) flight detail and re-price endpoint with expired offer recovery, (5) frontend integration including search form, results list, detail page, and round-trip toggle, (6) E2E testing and verification across backend, frontend, and agent-gateway regression.

### Environment Variable Configuration
Five environment variables control runtime behavior without code changes: `DUFFEL_ACCESS_TOKEN` (required, replaces the old `AMADEUS_API_KEY` + `AMADEUS_API_SECRET` pair), `DUFFEL_BUDGET_LIMIT_USER` (default 1,800), `DUFFEL_BUDGET_LIMIT_AGENT` (default 1,200), `DUFFEL_BUDGET_LIMIT_TOTAL` (default 2,000), and `FLIGHT_OFFERS_RETENTION_DAYS` (default 7). All budget thresholds and retention windows are configurable — nothing is hardcoded.

### Architecture Invariants
Five invariants are enforced throughout the implementation: (1) AI agents never call the flights service or controller directly — agent data access goes through the agent-gateway only, (2) the shared `DuffelService` is the single point of contact with the Duffel API, (3) the shared service owns all caching and budget logic — no consumer manages its own, (4) the frontend never sees Duffel offer IDs — all contracts use internal UUIDs, (5) the re-price call happens on detail page load, not at booking confirm.

### Dependency on Existing Systems
The feature assumes users have an authenticated session (existing auth system reused), the airport database is populated with IATA codes for input validation, Redis and PostgreSQL infrastructure are operational, and the AI chatbot's existing flight search tool already calls the same underlying data source. No new infrastructure provisioning is required. The switch from Amadeus to Duffel requires only a Duffel account with a test/live access token.
