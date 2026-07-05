# Implementation Plan: Map Integration

**Branch**: `feature/005-map-integration` | **Date**: 2026-07-05 | **Spec**: [spec.md](file:///c:/Booking%20Systems/specs/005-map-integration/spec.md)

**Input**: Feature specification from `/specs/005-map-integration/spec.md`

## Summary

Add interactive map visualization to the Flight Booking System, enabling users to see airport locations, flight route arcs, and destination context on an interactive WebGL-powered map. The backend serves airport geolocation data from a seeded PostgreSQL table; the frontend renders maps using MapLibre GL JS via react-map-gl.

## Technical Context

**Language/Version**: TypeScript 5.x (frontend + backend)

**Primary Dependencies**: MapLibre GL JS, react-map-gl (v7+), @turf/great-circle, maplibre-gl

**Storage**: PostgreSQL (airports table via Prisma), Redis (query caching)

**Testing**: Jest (API E2E), Playwright (UI), React Testing Library (components)

**Target Platform**: Web browser (desktop + mobile), NestJS server (Node.js)

**Project Type**: Full-stack web application (monorepo: apps/api + apps/web)

**Performance Goals**: Map render < 2s on 4G, autocomplete < 200ms p95

**Constraints**: Zero Amadeus API budget consumption, < 500KB added bundle size

**Scale/Scope**: ~7,700 airports in DB, rendered as clustered markers on map

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Flight-First Architecture | ✅ PASS | Map enhances the flight search experience — does not block or complicate the booking pipeline. Map is an overlay on existing pages. |
| II. Deterministic Transaction Boundary | ✅ PASS | Map is purely visual/informational. No AI involvement, no transactional impact. Airport data is static and deterministic. |
| III. API Budget Discipline | ✅ PASS | Zero Amadeus API calls for map/airport data. All airport geolocation served from local PostgreSQL seed. No external API consumption. |
| IV. Observability & Operational Visibility | ✅ PASS | Airport endpoints will follow existing logging patterns. Health checks will include airport data availability. |
| V. Incremental Delivery | ✅ PASS | Feature is sliced into 7 phases, each delivering a working increment. Phase 1 (data model) → Phase 2 (API) → Phase 3 (map component) → etc. |

## Project Structure

### Documentation (this feature)

```text
specs/005-map-integration/
├── plan.md              # This file
├── research.md          # Phase 0 output — library comparison, data analysis
├── data-model.md        # Phase 1 output — Airport entity, Prisma schema
├── quickstart.md        # Phase 1 output — validation guide
├── contracts/           # Phase 1 output — API contracts
│   └── airports-api.md  # Airport REST API contract
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
apps/api/
├── prisma/
│   ├── schema.prisma        # + Airport model
│   ├── seed/
│   │   └── airports.ts      # OurAirports CSV → DB seed script
│   └── migrations/          # + Airport table migration
└── src/
    └── airports/
        ├── airports.module.ts
        ├── airports.controller.ts
        ├── airports.service.ts
        ├── dto/
        │   ├── search-airports.dto.ts
        │   └── nearby-airports.dto.ts
        └── airports.constants.ts   # Haversine formula, cache keys

apps/web/
├── components/
│   └── map/
│       ├── MapContainer.tsx         # Main map wrapper ("use client")
│       ├── AirportMarkerLayer.tsx   # Clustered airport markers
│       ├── FlightRouteLayer.tsx     # Great-circle arc rendering
│       ├── AirportPopup.tsx         # Click popup with airport details
│       ├── MapControls.tsx          # Zoom, style toggle
│       └── map-utils.ts            # Great-circle arc computation, viewport fitting
├── app/
│   └── search/
│       └── page.tsx                 # + Map integration into search results
└── lib/
    └── airport-service.ts           # Frontend API client for airport endpoints

packages/shared/
└── src/
    └── types/
        └── airport.ts               # Shared Airport type definition

research/
└── map-integration-architecture.md  # Architecture research document
```

**Structure Decision**: Follows the existing monorepo pattern — new `airports` module in NestJS backend, new `map/` component directory in Next.js frontend, shared types in `packages/shared`.

## Implementation Phases

### Phase 1: Airport Data Model & Database Seed (Backend)

**Delivers**: Airport table in PostgreSQL, seeded with OurAirports data, shared type definitions.

**Tasks**:
1. Add `Airport` model to Prisma schema (iataCode, name, city, country, latitude, longitude, type, region)
2. Create Prisma migration for the airports table
3. Write seed script to parse OurAirports CSV → filter by IATA + type → batch insert
4. Add `Airport` shared type to `packages/shared/src/types/airport.ts`
5. Verify seed: run migration + seed, confirm ~7,700 airports inserted

**Verification**: `npx prisma db seed` completes without errors, `SELECT COUNT(*) FROM airports` returns ~7,700

---

### Phase 2: Airport REST API Endpoints (Backend)

**Delivers**: NestJS AirportsModule with search, detail, nearby, and list endpoints.

**Tasks**:
1. Create `AirportsModule`, `AirportsController`, `AirportsService`
2. Implement `GET /airports/search?q=` — case-insensitive IATA/name search with limit 10
3. Implement `GET /airports/:iataCode` — single airport by IATA code
4. Implement `GET /airports/nearby?lat=&lng=&radius=` — Haversine distance query
5. Implement `GET /airports/all` — lightweight list (code, name, lat, lng) for map rendering
6. Add Redis caching to all endpoints (24h TTL for static, 1h for nearby)
7. Add DTOs with class-validator decorators
8. Add E2E tests for all endpoints

**Verification**: `npm run test:e2e --workspace=apps/api` passes all airport endpoint tests

---

### Phase 3: Map Component Foundation (Frontend)

**Delivers**: Reusable MapContainer component with MapLibre GL JS rendering.

**Tasks**:
1. Install dependencies: `maplibre-gl`, `react-map-gl`
2. Create `MapContainer.tsx` — "use client" component wrapping ReactMapGL
3. Configure free tile source (OpenFreeMap or MapTiler)
4. Create `MapControls.tsx` — zoom buttons, fullscreen toggle
5. Add Next.js `dynamic()` wrapper with `ssr: false` for safe importing
6. Add responsive sizing and loading skeleton
7. Add light/dark style switching based on app theme

**Verification**: Map renders on a test page with zoom/pan working, no SSR errors

---

### Phase 4: Airport Markers & Popups (Frontend)

**Delivers**: Airport markers on the map with click-to-view popups.

**Tasks**:
1. Create `AirportMarkerLayer.tsx` — renders markers from airport data
2. Implement marker clustering using MapLibre's built-in cluster source
3. Create `AirportPopup.tsx` — shows airport details on marker click
4. Create `airport-service.ts` — frontend API client fetching from NestJS
5. Implement viewport auto-fitting when airports are loaded
6. Style markers with custom icons (airplane/pin SVG)

**Verification**: Search page shows airport markers, clicking opens popup with correct data

---

### Phase 5: Flight Route Arc Rendering (Frontend)

**Delivers**: Great-circle arc lines between airports showing flight routes.

**Tasks**:
1. Install `@turf/great-circle` and `@turf/helpers`
2. Create `FlightRouteLayer.tsx` — renders GeoJSON LineString arcs
3. Create `map-utils.ts` — great-circle computation, viewport bound calculation
4. Style arcs: solid for confirmed routes, dashed for preview routes
5. Add animation: progressive line-dasharray animation for route drawing
6. Handle multi-stop routes (multiple arcs with different colors per segment)
7. Handle antimeridian-crossing routes

**Verification**: Search results page shows animated arc between origin and destination airports

---

### Phase 6: Search Page Integration (Frontend)

**Delivers**: Map fully integrated into the flight search results page.

**Tasks**:
1. Add map panel to `/search` page layout (collapsible sidebar or split view)
2. Wire search form selection → map marker placement (origin/destination preview)
3. Wire search results → map route arc rendering
4. Add airport autocomplete integration with map preview
5. Mobile responsive: map as expandable section below results
6. Add smooth transitions between search states (selecting, searching, results)

**Verification**: Full search flow works: type airports → see markers → search → see route arc → click result → see detail route

---

### Phase 7: Flight Details Page Map & Polish (Frontend)

**Delivers**: Route map on flight details page, dark mode support, final polish.

**Tasks**:
1. Add map to `/search/[flightId]` page showing the specific flight route
2. Distinguish markers: origin (green), stops (amber), destination (red)
3. Show layover details on stop marker hover
4. Implement dark mode tile switching
5. Add WebGL fallback detection and graceful degradation
6. Performance optimization: code splitting, lazy loading, bundle analysis
7. Write Playwright E2E tests for map interactions

**Verification**: `npx playwright test` passes all map-related UI tests, bundle size delta < 500KB

## Complexity Tracking

> No constitution violations — no complexity justification needed.
