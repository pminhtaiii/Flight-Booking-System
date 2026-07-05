# Quickstart: Map Integration Validation

**Feature**: 005-map-integration | **Date**: 2026-07-05

---

## Prerequisites

1. PostgreSQL database running and accessible
2. Redis server running
3. NestJS API server (`apps/api`) running on port 3001
4. Next.js frontend (`apps/web`) running on port 3000
5. Airport seed data loaded (see Scenario 1)

---

## Scenario 1: Database Seed Verification

**Goal**: Verify airport data is seeded correctly into PostgreSQL.

**Steps**:
```bash
# 1. Run the Prisma migration
npm run prisma:migrate --workspace=apps/api

# 2. Run the seed script
npm run prisma:seed --workspace=apps/api

# 3. Verify count
cd apps/api && npx prisma studio
# → Open airports table → Expect ~7,700 rows
```

**Expected Outcome**: Airports table contains ~7,700 records. Spot check: HAN (Hanoi), NRT (Tokyo Narita), LHR (London Heathrow) all present with correct coordinates.

---

## Scenario 2: Airport API Endpoints

**Goal**: Verify all airport REST endpoints return correct data.

**Steps**:
```bash
# 1. Search by name
curl http://localhost:3001/airports/search?q=Tokyo
# → Expect NRT, HND in results

# 2. Search by IATA code
curl http://localhost:3001/airports/search?q=LHR
# → Expect London Heathrow

# 3. Get single airport
curl http://localhost:3001/airports/HAN
# → Expect full airport details for Noi Bai

# 4. Nearby airports
curl "http://localhost:3001/airports/nearby?lat=21.0285&lng=105.8542&radius=100"
# → Expect HAN (Noi Bai) in results

# 5. All airports (lightweight)
curl http://localhost:3001/airports/all | jq '.count'
# → Expect ~7,700
```

**Expected Outcome**: All endpoints return 200 with correctly structured JSON responses matching the API contract.

---

## Scenario 3: Map Rendering

**Goal**: Verify the interactive map renders on the search page.

**Steps**:
1. Navigate to `http://localhost:3000/search`
2. Verify the map container is visible (no blank space, no errors in console)
3. Verify map tiles load (world geography visible)
4. Verify zoom and pan controls work
5. Verify the map responds to touch gestures on mobile (use Chrome DevTools mobile emulator)

**Expected Outcome**: Interactive vector tile map renders without errors, WebGL context created successfully.

---

## Scenario 4: Search → Map Route Arc

**Goal**: Verify end-to-end flow from search to route visualization.

**Steps**:
1. Navigate to `http://localhost:3000/search`
2. Enter origin: "HAN" (Hanoi)
3. Enter destination: "NRT" (Tokyo Narita)
4. Click Search
5. Verify the map shows:
   - Green marker at HAN coordinates
   - Red marker at NRT coordinates
   - Curved arc line connecting them
   - Map viewport fits both markers

**Expected Outcome**: Both airport markers visible, great-circle arc drawn between them, map auto-zoomed to fit.

---

## Scenario 5: Dark Mode

**Goal**: Verify map theme switching.

**Steps**:
1. Navigate to any page with the map
2. Toggle the app's dark mode setting
3. Verify the map tiles switch from light to dark style
4. Verify markers and arcs remain visible on both themes

**Expected Outcome**: Map tile style changes smoothly without reloading, all overlays visible on both themes.

---

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| Map blank / no tiles | Check tile URL in MapContainer config. Try alternate tile source. |
| "WebGL not supported" | Test in a modern browser (Chrome, Firefox, Edge). Safari may need WebGL enabled. |
| Airports not loading | Verify seed ran: `SELECT COUNT(*) FROM airports;`. Check API server is running. |
| CORS errors on tile fetch | Tile sources should be public. Check for proxy configuration issues. |
| SSR hydration error | Ensure map components use `dynamic()` with `ssr: false`. |
