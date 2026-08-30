# Research: Map Integration

**Feature**: 005-map-integration | **Date**: 2026-07-05

---

## 1. Map Library Selection

### Decision: MapLibre GL JS with react-map-gl

**Rationale**: MapLibre GL JS is the open-source fork of Mapbox GL JS. It provides WebGL-powered vector tile rendering with zero API key requirements, free tile sources, and the best React integration via Uber's `react-map-gl` library.

**Alternatives Considered**:

| Library            | Pricing                       | Bundle Size    | Arc Support                 | Dark Mode          | TypeScript         | Verdict                                                  |
| ------------------ | ----------------------------- | -------------- | --------------------------- | ------------------ | ------------------ | -------------------------------------------------------- |
| **MapLibre GL JS** | Free & open-source            | ~200KB gzipped | Via deck.gl ArcLayer        | Full style control | Excellent          | **Selected**                                             |
| Mapbox GL JS       | 50K loads free/mo, then $5/1K | ~220KB gzipped | Native arc support          | Full style control | Excellent          | Rejected: Proprietary license since v2, API key required |
| Leaflet            | Free & open-source            | ~40KB gzipped  | Via plugins (Leaflet.curve) | CSS themes only    | @types/leaflet     | Rejected: Raster-based, no WebGL, poor zoom performance  |
| Google Maps        | $200/mo credit (~28K loads)   | ~200KB gzipped | Via polylines only          | Limited            | @types/google.maps | Rejected: Usage-based pricing, no free dark mode tiles   |

### Why MapLibre + react-map-gl:

1. **Cost**: Zero API fees. Free vector tile sources (OpenFreeMap, Protomaps, MapTiler free tier)
2. **Performance**: WebGL rendering handles thousands of airport markers smoothly
3. **React Integration**: `react-map-gl` (by Uber/Vis.gl) provides declarative React components — same API works for both Mapbox and MapLibre
4. **Dark Mode**: Full style JSON control — can switch between light/dark tile styles
5. **Arc Rendering**: Use `@turf/great-circle` for beautiful curved flight routes rendered as GeoJSON layers
6. **SSR Safety**: Map components are client-only (`"use client"` directive), tiles load on mount — no SSR hydration issues
7. **TypeScript**: First-class TypeScript support in both MapLibre and react-map-gl

### Free Tile Sources:

- **OpenFreeMap**: Fully free, no API key, both light and dark styles
- **Protomaps**: Self-hosted PMTiles, one-time download, zero ongoing cost
- **MapTiler**: Free tier with 100K tile requests/month, beautiful styles

---

## 2. Flight Route Visualization

### Decision: GeoJSON Great-Circle Arcs

**Rationale**: Use the `@turf/great-circle` library to compute great-circle arcs between origin and destination airports, rendered as GeoJSON LineString layers on the map.

**Alternatives Considered**:

- **deck.gl ArcLayer**: 3D raised arcs, visually stunning, but adds ~150KB to bundle and requires deck.gl integration layer
- **Custom bezier curves**: Manual SVG overlay, full control, but complex math and poor projection handling
- **Turf.js great-circle**: Lightweight (~5KB for the module), geographically accurate, native GeoJSON output, renders as a standard map layer

**Implementation Approach**:

```typescript
import greatCircle from '@turf/great-circle';

const arc = greatCircle(
  [originAirport.lng, originAirport.lat],
  [destAirport.lng, destAirport.lat],
  { npoints: 100 },
);
// Render as a GeoJSON Source + Layer on the map
```

**Animation**: Use CSS transitions on the line-dasharray property to animate the route drawing progressively.

---

## 3. Airport Geolocation Data

### Decision: OurAirports CSV → PostgreSQL Seed

**Rationale**: Import the OurAirports dataset into a PostgreSQL `airports` table via a Prisma seed script. The dataset contains ~7,700 airports with scheduled commercial service worldwide.

**Alternatives Considered**:

- **Static JSON bundle**: Ship airports.json with the frontend (~800KB). Rejected: bloats initial page load, hard to query server-side
- **Amadeus Airport API**: Real-time lookups. Rejected: Consumes API budget (2,000 calls/month), unnecessary for static data
- **PostGIS spatial queries**: Full GIS extension. Rejected: Overkill for point-radius queries on <10K records. Haversine formula on plain lat/lng columns is sufficient

**OurAirports Dataset Fields** (airports.csv):
| Field | Use |
|-------|-----|
| `ident` | Internal ID |
| `type` | Filter: `large_airport`, `medium_airport` |
| `name` | Display name |
| `latitude_deg` | Latitude coordinate |
| `longitude_deg` | Longitude coordinate |
| `elevation_ft` | Optional metadata |
| `iso_country` | Country code |
| `iso_region` | Region code |
| `municipality` | City name |
| `iata_code` | IATA code (primary lookup key) |

**Filtering Strategy**: Only import airports with a non-empty `iata_code` AND `type` in (`large_airport`, `medium_airport`). This reduces ~75,000 total records to ~7,700 commercially relevant airports.

**Storage**: Plain `FLOAT` columns for `latitude` and `longitude`. No PostGIS needed — Haversine distance formula handles nearby-airport queries efficiently at this scale.

---

## 4. Backend API Design

### Decision: New AirportsModule in NestJS

**Endpoints**:
| Endpoint | Method | Purpose | Cache |
|----------|--------|---------|-------|
| `/airports/search` | GET | Autocomplete by name/IATA code (query param `q`) | Redis 24h |
| `/airports/:iataCode` | GET | Single airport details with coordinates | Redis 24h |
| `/airports/nearby` | GET | Find airports within radius of lat/lng point | Redis 1h |
| `/airports/all` | GET | Lightweight list (code + name + coords only) for frontend map | Redis 24h |

**Caching Strategy**: Airport data is essentially static (airports don't move). Use aggressive Redis caching with 24-hour TTL. The `/airports/all` endpoint returns a lightweight payload (~300KB gzipped) for the frontend map to render all markers.

**No Amadeus API budget impact**: All airport data served from PostgreSQL seed data. Zero external API calls for map functionality.

---

## 5. Frontend Architecture

### Decision: Client Components with Lazy Loading

**Rationale**: Maps require WebGL and browser APIs — they must be client components. Use Next.js `dynamic()` with `ssr: false` to prevent hydration errors.

**Component Hierarchy**:

```
MapContainer ("use client", dynamic import)
├── ReactMapGL (MapLibre provider)
│   ├── AirportMarkerLayer (clustered markers)
│   ├── FlightRouteLayer (great-circle arcs)
│   ├── AirportPopup (details on click)
│   └── MapControls (zoom, style toggle)
└── MapSearchOverlay (search integration)
```

**Integration Points**:

- **Search Page** (`/search`): Map shows origin and destination airports with route arc after search
- **Flight Details Page** (`/search/[flightId]`): Map shows the specific flight route with all stops
- **Homepage** (`/`): Optional decorative world map with popular route animations

---

## 6. Competitive Analysis

### How Others Do It:

| Platform           | Map Usage                                                                       | Tech                      |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------- |
| **Google Flights** | Interactive destination explorer, route arcs on selection, price bubbles on map | Google Maps (proprietary) |
| **Skyscanner**     | "Explore Everywhere" map with price pins, clicking a country shows deals        | Mapbox GL JS              |
| **Kiwi.com**       | Full-screen route map with animated flight paths, multi-city visualization      | Mapbox GL JS              |
| **Kayak**          | Explore map with price bubbles, heatmap overlay for deals                       | Google Maps               |

**Key Takeaways**:

1. Map is primarily used for **destination exploration** and **route visualization**, not as the main search interface
2. Flight route arcs are universally curved (great-circle) lines
3. Airport markers use clustering at low zoom levels
4. Price information overlaid on destination markers adds significant value
5. Dark mode maps are increasingly standard

---

## 7. Risk Assessment

| Risk                                | Mitigation                                                    |
| ----------------------------------- | ------------------------------------------------------------- |
| MapLibre tile source reliability    | Configure fallback tile URLs; Protomaps self-hosted as backup |
| Large airport dataset slowing seed  | Batch insert with `createMany`, only run once                 |
| WebGL not supported on old browsers | Graceful fallback: show text-based airport selector           |
| Map bundle size impacting LCP       | `dynamic()` with `ssr: false` + code splitting                |
| Free tile source rate limits        | Monitor usage; switch providers if needed                     |
