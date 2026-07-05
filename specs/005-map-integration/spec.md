# Feature Specification: Map Integration

**Feature Branch**: `feature/005-map-integration`

**Created**: 2026-07-05

**Status**: Draft

**Input**: User description: "Interactive map integration for flight search with airport visualization, route display, and destination exploration across frontend and backend"

## User Scenarios & Testing

### User Story 1 - Airport Map Visualization on Search (Priority: P1)

When a user performs a flight search, the search results page displays an interactive map showing the origin airport, destination airport, and a curved flight route arc between them. The map provides spatial context for the journey.

**Why this priority**: The map is meaningless without flight search context. This story is the anchor — connecting the existing search flow to a visual map representation delivers the highest immediate value.

**Independent Test**: Can be fully tested by performing a flight search (e.g., HAN → NRT) and verifying that the map renders with both airport markers and a connecting arc. Delivers immediate visual value even without other stories.

**Acceptance Scenarios**:

1. **Given** a user has searched for flights from HAN to NRT, **When** the search results load, **Then** the map displays markers for both airports and a curved great-circle arc connecting them
2. **Given** the map is visible on the search results page, **When** the user clicks an airport marker, **Then** a popup shows airport name, IATA code, city, and country
3. **Given** a flight search returns results, **When** the map renders, **Then** the map automatically fits the viewport to show both origin and destination airports
4. **Given** the user is on a mobile device, **When** the search results load, **Then** the map is responsive and touch-interactive (pinch-to-zoom, drag-to-pan)

---

### User Story 2 - Airport Autocomplete with Map Preview (Priority: P2)

When a user types in the origin or destination field on the search page, an autocomplete dropdown suggests airports. Selecting an airport places a marker on the map in real-time, giving the user spatial feedback before searching.

**Why this priority**: Enhances the search input experience by connecting text input to visual map feedback. Builds on Story 1's map infrastructure.

**Independent Test**: Can be tested by typing "Tok" in the destination field and verifying that Tokyo airports (NRT, HND) appear in the dropdown with IATA codes, and selecting one places a marker on the map.

**Acceptance Scenarios**:

1. **Given** the user starts typing "Lon" in the destination field, **When** at least 2 characters are entered, **Then** the autocomplete shows matching airports (LHR, LGW, STN, LTN, LCY) with name, IATA code, and city
2. **Given** the user selects "LHR - London Heathrow" from the autocomplete, **When** the selection is made, **Then** a marker appears on the map at Heathrow's coordinates and the map pans smoothly to show it
3. **Given** both origin and destination are selected, **When** both markers are on the map, **Then** a dashed preview arc connects them before the user clicks Search

---

### User Story 3 - Flight Route Details Map (Priority: P2)

When a user views a specific flight's details page, the map shows the complete route including all intermediate stops (layovers) with distinct markers and connecting arcs.

**Why this priority**: Provides valuable spatial context for multi-stop flights. Requires Story 1's map infrastructure.

**Independent Test**: Can be tested by navigating to a multi-stop flight detail page and verifying all airports (origin, stops, destination) are shown with connecting arcs.

**Acceptance Scenarios**:

1. **Given** a user views a non-stop flight (HAN → NRT), **When** the details page loads, **Then** the map shows two markers and one arc
2. **Given** a user views a 1-stop flight (HAN → ICN → NRT), **When** the details page loads, **Then** the map shows three markers (origin green, stop amber, destination red) and two connecting arcs
3. **Given** the flight details map is visible, **When** the user hovers over a stop marker, **Then** a tooltip shows the layover airport name, IATA code, and layover duration

---

### User Story 4 - Map Dark Mode & Style Toggle (Priority: P3)

The map supports both light and dark visual styles, synced with the application's theme preference. A toggle allows manual style switching.

**Why this priority**: Nice-to-have polish that enhances the visual experience. The project already uses dark mode throughout.

**Independent Test**: Can be tested by toggling the app theme and verifying the map tiles switch between light and dark styles.

**Acceptance Scenarios**:

1. **Given** the application is in dark mode, **When** the map renders, **Then** it uses dark-themed map tiles
2. **Given** the user toggles the theme, **When** the theme changes, **Then** the map style transitions smoothly without reloading

---

### User Story 5 - Destination Explorer Map (Priority: P3)

On the homepage or a dedicated explore page, users can browse a world map with popular destination markers. Clicking a destination pre-fills the search form.

**Why this priority**: Future-looking feature that adds discovery value. Depends on Stories 1-2.

**Independent Test**: Can be tested by clicking a destination marker on the explorer map and verifying the search form is pre-filled with that airport as the destination.

**Acceptance Scenarios**:

1. **Given** the user is on the explore page, **When** the map loads, **Then** popular destinations are shown as markers with city names
2. **Given** the user clicks a destination marker (e.g., Tokyo), **When** the marker is clicked, **Then** the search form opens with "NRT" pre-filled as the destination

---

### Edge Cases

- What happens when the browser doesn't support WebGL? → Show a graceful fallback (text-based airport info, no map)
- What happens when the free tile server is down? → Show a fallback empty map with airport markers using a minimal style
- What happens when an airport has no IATA code? → Exclude from the dataset entirely (only import airports with IATA codes)
- What happens when origin and destination are the same airport? → Show a single marker with a note, no arc
- What happens when the flight route crosses the International Date Line? → Turf.js great-circle handles antimeridian crossing correctly
- What happens on very slow connections? → Show a loading skeleton for the map container, lazy-load tiles

## Requirements

### Functional Requirements

- **FR-001**: System MUST render an interactive map using MapLibre GL JS with vector tiles on the flight search results page
- **FR-002**: System MUST display airport markers for origin and destination airports with clickable popups showing airport details
- **FR-003**: System MUST render great-circle arc routes between connected airports using GeoJSON line layers
- **FR-004**: System MUST provide a backend airport search endpoint (`GET /airports/search?q=`) returning matching airports by name or IATA code
- **FR-005**: System MUST store airport geolocation data (IATA code, name, coordinates, city, country) in PostgreSQL, seeded from the OurAirports dataset
- **FR-006**: System MUST support nearby airport queries (`GET /airports/nearby?lat=&lng=&radius=`) using Haversine distance calculation
- **FR-007**: System MUST cache airport query results in Redis with appropriate TTLs (24h for static data, 1h for proximity queries)
- **FR-008**: System MUST lazy-load map components using Next.js `dynamic()` with `ssr: false` to prevent server-side rendering errors
- **FR-009**: System MUST support both light and dark map tile styles, synced with the application theme
- **FR-010**: System MUST automatically fit the map viewport to show all relevant airports when displaying search results
- **FR-011**: System MUST cluster airport markers at low zoom levels when displaying many airports
- **FR-012**: System MUST NOT consume any Amadeus API budget for map/airport functionality — all airport data comes from the local database

### Key Entities

- **Airport**: Represents a commercial airport with IATA code, name, city, country, latitude, longitude, and type (large/medium). Primary lookup key is the IATA code.
- **FlightRoute**: A visual representation of a flight path between airports, defined as a great-circle arc with origin, destination, and optional intermediate stops. Not persisted — computed on-the-fly.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Map renders within 2 seconds of page load on a 4G connection (LCP target)
- **SC-002**: Airport autocomplete returns results within 200ms (p95)
- **SC-003**: Zero Amadeus API calls consumed by any map or airport functionality
- **SC-004**: Map is fully interactive on mobile devices (touch gestures work correctly)
- **SC-005**: Airport dataset covers 95%+ of airports served by Amadeus flight search results
- **SC-006**: Map tile loading adds less than 500KB to the initial page bundle (code-split)

## Assumptions

- Users have a modern browser with WebGL support (95%+ of current browsers)
- The OurAirports CSV dataset is stable and comprehensive for commercial airports
- Free tile sources (OpenFreeMap, MapTiler free tier) provide sufficient availability
- Map is a visual enhancement, not a primary navigation tool — text-based search remains the primary flow
- Mobile support is important but the map may be collapsed by default on small screens
- The existing NestJS module pattern, Redis caching, and Prisma ORM will be extended (not replaced)
