# Feature Specification: Cabin Class & Passenger Type Enhancement

**Feature Branch**: `008-cabin-passenger-enhancement`

**Created**: 2026-07-09

**Status**: Draft

**Input**: Grilling session decisions from `research/cabin-passenger-enhancement-decisions.md`

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Select Cabin Class for Flight Search (Priority: P1)

A traveler visits the search page and selects their preferred cabin class (Economy, Premium Economy, Business, or First) before searching. The system sends this preference to Duffel and returns offers matching the selected cabin. If some segments in a returned offer have a different cabin than requested, the system clearly flags the mismatch with specific per-segment details so the user can make an informed decision.

**Why this priority**: Without cabin class selection, the search engine is unusable for any traveler who isn't looking for economy. This is table-stakes for a production flight search.

**Independent Test**: Search for "SGN → NRT, Business class" and verify that results are predominantly business class. If any mixed-cabin offers appear, verify the mismatch badge shows which specific segments are in a different cabin.

**Acceptance Scenarios**:

1. **Given** a logged-in user on the search page, **When** they select "Business" from the cabin class selector and search, **Then** the system passes `cabin_class: 'business'` to the Duffel API and returns offers prioritizing business class.

2. **Given** a search returns a mixed-cabin offer (e.g., feeder segment in economy, long-haul in business), **When** the results are displayed, **Then** the offer shows a yellow "Mixed Cabin" badge next to the price with expandable details showing which segment is in a different cabin.

3. **Given** a search returns a downgraded offer (the longest-duration segment mismatches the requested cabin), **When** the results are displayed, **Then** the offer shows a red "Downgraded" badge next to the price with specific segment details.

4. **Given** all segments match the requested cabin, **When** the results are displayed, **Then** no cabin mismatch badge is shown (status: `full`).

5. **Given** the user searches with cabin class "First", **When** Duffel returns zero results, **Then** the system displays a clear message suggesting to try a different cabin class.

---

### User Story 2 - Specify Passenger Types (Priority: P1)

A traveler specifies the number of adults, children (ages 2–11), and infants (under 2, on lap) for their search. The system sends the correct passenger breakdown to Duffel and returns offers with pricing that accounts for child/infant fares.

**Why this priority**: Families traveling with children or infants get incorrect pricing when all passengers are treated as adults. This is a correctness issue, not a nice-to-have.

**Independent Test**: Search for "1 adult + 1 child + 1 infant, SGN → NRT" and verify the returned price differs from "3 adults, SGN → NRT".

**Acceptance Scenarios**:

1. **Given** a user sets 2 adults, 1 child, and 1 infant, **When** they search, **Then** the system sends the correct passenger breakdown to Duffel and returns offers with age-appropriate pricing.

2. **Given** a user sets 2 infants and 1 adult, **When** they try to search, **Then** the system rejects the search with a validation error: "Number of infants cannot exceed number of adults."

3. **Given** a user sets passengers totaling more than 9, **When** they try to search, **Then** the system rejects with: "Maximum 9 passengers per search."

4. **Given** no children or infants are specified, **When** the search executes, **Then** the system defaults to the specified number of adults only (backward compatible with current behavior).

---

### User Story 3 - Agent Gateway Honest Degradation (Priority: P2)

When a chatbot user mentions non-economy cabins or child/infant passengers in their message, the agent responds honestly about its current limitations instead of silently returning economy/adult-only results. These triggers are logged for future upgrade prioritization.

**Why this priority**: Silent degradation erodes trust. Logging triggers provides data to justify the NLP upgrade investment.

**Independent Test**: Send "find me business class flights from SGN to NRT for 2 adults and 1 child" to the chatbot and verify it responds with a limitation message and logs the trigger.

**Acceptance Scenarios**:

1. **Given** a chatbot user says "find business class flights to Tokyo", **When** the agent processes the message, **Then** it responds with: "I can currently only search economy class for adult passengers. For other cabin classes or passenger types, please use the search page."

2. **Given** a chatbot user says "flights for 2 adults and 1 kid", **When** the agent processes the message, **Then** it detects the "kid" keyword and responds with the limitation message.

3. **Given** a chatbot user says "cheap flights from SGN to HAN", **When** the agent processes the message, **Then** no keyword is triggered and the search proceeds normally with economy/adults defaults.

---

### Edge Cases

- What happens if Duffel returns no offers for a premium cabin class on a route that has economy availability?
- How does the cabin mismatch logic handle offers with only one segment (direct flights)?
- What happens if a segment has `cabin_class: null` in the Duffel response?
- How does the system handle an infant passenger on a very long flight (>8 hours)?
- What happens if the user changes cabin class and re-searches — does the cache correctly separate the results?

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: System MUST allow users to select a cabin class (`economy`, `premium_economy`, `business`, `first`) before searching. Default: `economy`.
- **FR-002**: System MUST pass the selected cabin class to the Duffel `offerRequests.create()` API call as a request-level filter.
- **FR-003**: System MUST compute a `cabinClassMatch` status for each offer using the deterministic rule: longest-duration segment mismatch → `downgraded`; any other segment mismatch → `mixed`; no mismatches → `full`.
- **FR-004**: System MUST include per-segment `cabinClass` in the response DTO and offer-level `cabinMismatchDetails` array for mixed/downgraded offers.
- **FR-005**: System MUST display cabin mismatch badges next to the price: yellow for `mixed`, red for `downgraded`, with expandable per-segment details.
- **FR-006**: System MUST accept passenger breakdown as flat fields: `adults` (required, ≥1), `children` (optional, default 0), `infants` (optional, default 0).
- **FR-007**: System MUST validate: `infants ≤ adults`, `adults + children + infants ≤ 9`, `adults ≥ 1`.
- **FR-008**: System MUST use an isolated mapper function in `DuffelService` to convert flat passenger fields to Duffel's passenger array format.
- **FR-009**: System MUST include `cabinClass` and passenger breakdown (`adults`, `children`, `infants`) in the cache key SHA-256 hash.
- **FR-010**: System MUST migrate database schema: replace `passengers Int` with `adults Int`, `children Int`, `infants Int`, `cabinClass String` on `FlightOffer`, `SearchHistory`.
- **FR-011**: Agent gateway MUST default to `economy`/all-adults and use the same DTO shape as the frontend.
- **FR-012**: Agent gateway MUST detect keyword triggers for unsupported cabin/passenger requests and respond honestly.
- **FR-013**: Agent gateway MUST log keyword triggers for future upgrade analytics.
- **FR-014**: The 410 Gone recovery response MUST include `cabinClass` and passenger breakdown in the recovery object.

### Key Entities

- **Flight Search Request**: Extended with `cabinClass`, `adults`, `children`, `infants`.
- **Flight Offer**: Extended with per-segment `cabinClass`, offer-level `cabinClassMatch`, `cabinMismatchDetails`.
- **Search History Record**: Extended with `adults`, `children`, `infants`, `cabinClass` for analytics.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Users can select any of 4 cabin classes and receive results matching their preference.
- **SC-002**: Mixed-cabin offers are flagged with specific per-segment details — users never assume the whole itinerary matches their requested cabin.
- **SC-003**: Passenger type breakdown produces correct age-appropriate pricing from Duffel.
- **SC-004**: Cache correctly separates results by cabin class and passenger breakdown — no cross-contamination.
- **SC-005**: Agent gateway never silently downgrades — users are informed of limitations.
- **SC-006**: Keyword trigger logs accumulate data for future NLP upgrade prioritization.
- **SC-007**: All existing E2E tests continue to pass (backward compatible with economy/adults default).

## Assumptions

- The Duffel API's `cabin_class` parameter is a preference, not a hard filter — mixed-cabin offers may be returned.
- The Duffel API supports `adult`, `child`, and `infant_without_seat` passenger types.
- The existing search page UI can accommodate a cabin class dropdown and passenger type picker without a full redesign.
- Schema migration is trivial at this development stage — no production data to preserve.
