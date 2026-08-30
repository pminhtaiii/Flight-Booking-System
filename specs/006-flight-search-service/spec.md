# Feature Specification: Duffel Flight Search Service

**Feature Branch**: `006-flight-search-service`

**Created**: 2026-07-07

**Status**: Draft

**Input**: User description: "Build the deterministic Duffel Flight Search Service — the core user-facing flight search pipeline with caching, budget management, persistence, and flight detail re-pricing."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Search for Flights (Priority: P1)

A traveler visits the search page, enters their origin airport, destination airport, travel dates (one-way or round-trip), and number of passengers, then clicks "Search Flights." The system returns a list of available flight offers with pricing, airline details, duration, stops, and fare information — displayed within seconds.

**Why this priority**: This is the core value proposition of the entire platform. Without flight search, the system has no reason to exist. Every downstream feature (booking, payment, trip assembly) depends on search working first.

**Independent Test**: Can be fully tested by entering a valid route (e.g., HAN → SGN, Jul 15) and verifying that flight results appear with accurate pricing and airline details. Delivers immediate user value — the ability to discover and compare flights.

**Acceptance Scenarios**:

1. **Given** a logged-in user on the search page, **When** they enter a valid origin, destination, departure date, and passenger count and click Search, **Then** the system displays up to 20 flight offers sorted by relevance, each showing airline name, flight number, departure/arrival times, duration, number of stops, price, currency, fare class, and baggage allowance.

2. **Given** a logged-in user searching for a round-trip, **When** they enter a departure date and a return date, **Then** the system returns flight offers that include both outbound and return itineraries.

3. **Given** a logged-in user searching for a one-way flight, **When** they omit the return date, **Then** the system returns one-way flight offers only.

4. **Given** a user submits a search identical to one performed recently, **When** the cached results are still valid, **Then** the system returns results faster (from cache) without consuming an additional API call against the monthly budget.

5. **Given** the monthly API budget has been exhausted, **When** a user attempts to search, **Then** the system displays a clear, friendly message explaining that search capacity has been temporarily reached and suggests trying again later.

---

### User Story 2 - View Flight Details with Live Pricing (Priority: P2)

A traveler sees a flight they're interested in from the search results and clicks "View Details." The system shows a comprehensive detail page with full segment breakdown, fare details, and a **live re-confirmed price** — ensuring the price the user sees is the price they'll pay if they proceed to booking.

**Why this priority**: Users need confidence in pricing before committing to a booking. Showing stale prices that change at checkout erodes trust. This story bridges search and booking.

**Independent Test**: Can be tested by searching for flights, clicking "View Details" on any result, and verifying that the detail page displays enriched information including a price that matches or updates from the search result.

**Acceptance Scenarios**:

1. **Given** a user clicks "View Details" on a search result, **When** the detail page loads, **Then** the system displays the full flight information: airline, flight number, aircraft type (if available), departure and arrival airports with terminals, times, duration, stops with layover details, fare class, baggage allowance, and a live re-confirmed price.

2. **Given** the underlying price has changed since the search was performed, **When** the user views the detail page, **Then** the system shows the updated price with a clear indicator that the price has changed from the original search result.

3. **Given** a flight offer has expired (no longer available from the data source), **When** the user navigates to its detail page, **Then** the system shows a clear "This offer has expired" notice and pre-fills the search form with the original search parameters so the user can re-search with one click.

---

### User Story 3 - Search History & Analytics Capture (Priority: P3)

Every flight search performed by a user is recorded as lightweight metadata (route, dates, price range observed) for future use in dashboard analytics, "Top Destinations" insights, and potential "Recently Searched" functionality — without storing bulky raw data indefinitely.

**Why this priority**: Analytics power the dashboard charts (Top Destinations, Spending by Month) and future AI match scoring. However, the platform delivers value without this — it's an enhancement over the core search experience.

**Independent Test**: Can be tested by performing multiple searches and verifying that the dashboard or analytics queries can surface "most searched routes" and "price ranges observed" data.

**Acceptance Scenarios**:

1. **Given** a user performs a flight search, **When** the results are returned, **Then** the system records the search metadata (origin, destination, dates, passenger count, number of results, price range) without blocking the response to the user.

2. **Given** multiple searches have been recorded over time, **When** the dashboard analytics queries the search history, **Then** it can surface aggregated data such as most-searched routes and average price ranges per route.

3. **Given** raw flight offer data older than the retention window, **When** the scheduled cleanup runs, **Then** the raw data is permanently removed while the lightweight search history metadata is preserved indefinitely.

---

### Edge Cases

- What happens when the user enters an invalid airport code or a code that doesn't exist in the system?
- How does the system handle the external flight data provider being completely down or timing out?
- What happens when the search returns zero results (e.g., no flights on that route/date)?
- How does the system behave when the user searches for a past departure date?
- What happens when the monthly API budget is nearly exhausted and both the user search and the AI chatbot compete for remaining capacity?
- How does the system handle extremely long layovers or multi-stop flights with >2 stops?
- What happens if the user navigates to a flight detail URL that has never existed (invalid UUID)?

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: System MUST allow authenticated users to search for flights by specifying origin airport, destination airport, departure date, number of passengers, and optionally a return date (round-trip).
- **FR-002**: System MUST return up to 20 flight offers per search, each displaying airline name, flight number, departure and arrival times, duration, number of stops, price, currency, fare class, and baggage allowance.
- **FR-003**: System MUST cache search results so that identical queries within the cache window return results without consuming an additional external API call.
- **FR-004**: System MUST track external API usage against a configurable monthly budget and reject searches that would exceed the budget with a user-friendly message.
- **FR-005**: System MUST apply different budget thresholds for user-initiated searches (higher priority) versus AI chatbot-initiated searches (lower priority), ensuring user searches are never blocked by chatbot usage.
- **FR-006**: System MUST persist raw flight offer data for a configurable retention period to support flight detail retrieval and re-pricing.
- **FR-007**: System MUST persist lightweight search metadata (route, dates, price range, result count) indefinitely for analytics and dashboard features.
- **FR-008**: System MUST write persistent data asynchronously after returning the search response to the user, ensuring zero additional latency on the user's critical path. This write-behind job MUST be queued durably (e.g., using a Redis-backed job queue or transactional outbox) to ensure that the data is eventually persisted and not lost in case of a process exit.
- **FR-009**: System MUST provide a flight detail view that retrieves the full flight offer and re-confirms the live price from the external data source before displaying it to the user.
- **FR-010**: System MUST return a clear "offer expired" response when a flight detail is requested for an offer that has been removed from both cache and persistent storage, including the original search parameters to enable one-click re-search.
- **FR-011**: System MUST validate all search inputs (valid airport codes, future departure dates, passenger count within allowed range) and return clear error messages for invalid inputs.
- **FR-012**: System MUST log all search operations with structured audit records including the user's internal opaque ID, search parameters, result count, and response time — explicitly redacting and forbidding names, emails, IP addresses, or other personal identifiers to prevent logging any PII.
- **FR-013**: System MUST automatically purge expired raw flight offer data on a scheduled basis according to the configured retention window.

### Key Entities

- **Flight Search Request**: Represents a user's search query — origin, destination, departure date, optional return date, passenger count.
- **Flight Offer**: A specific flight option returned by the search — includes airline, routing, timing, pricing, fare class, and baggage details. Has a limited lifespan tied to the retention window.
- **Search History Record**: Lightweight metadata about a completed search — the route, dates, price range observed, and result count. Preserved indefinitely for analytics.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Users can search for flights and receive results within 5 seconds for uncached queries and within 1 second for cached queries.
- **SC-002**: 100% of flight search results display accurate pricing that matches the external data source at the time of retrieval.
- **SC-003**: Repeated identical searches within the cache window consume zero additional external API calls, preserving the monthly budget.
- **SC-004**: User-initiated searches are never blocked by AI chatbot API usage — the system always reserves capacity for user-facing searches.
- **SC-005**: Flight detail pages display a live re-confirmed price before the user enters any booking or payment flow.
- **SC-006**: Expired flight offers produce a guided recovery experience (pre-filled re-search) rather than a dead-end error page.
- **SC-007**: All search operations are fully auditable — every search can be traced with user identity, parameters, timing, and outcome.
- **SC-008**: The system gracefully handles external data source downtime with clear user-facing error messages and no unhandled failures.
- **SC-009**: Raw flight offer data is automatically cleaned up after the retention window, while search history metadata is preserved indefinitely for analytics.

## Assumptions

- Users have an authenticated session before accessing the flight search feature (existing auth system is reused).
- The external flight data source (Duffel API) provides real-time pricing and availability data with a pay-as-you-go model (1500:1 search-to-book ratio, 120 requests per 60 seconds rate limit).
- The existing airport database (IATA codes, names, coordinates) is already populated and available for input validation and autocomplete.
- The existing caching infrastructure (Redis) and database (PostgreSQL) are operational and available.
- The AI chatbot's flight search tool already calls the same underlying data source — this feature shares the API client and budget counter with it.
- Mobile-specific optimizations are out of scope for this feature; the responsive web experience is sufficient.
- The booking and payment flows are out of scope for this feature — "Proceed to Booking" is a placeholder action that will be wired in a future feature.
