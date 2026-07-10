# Research: Cabin Class & Passenger Type Enhancement

**Feature**: 008-cabin-passenger-enhancement
**Date**: 2026-07-09
**Source**: Grilling session decisions — `research/cabin-passenger-enhancement-decisions.md`

## R0: Cabin Class — Request-Level vs Post-Filter

**Decision**: Request-level filtering — pass `cabin_class` to Duffel's `offerRequests.create()`.

**Rationale**: Duffel optimizes search results internally for the requested cabin. Post-filtering wastes API budget and may miss premium cabin offers only returned when explicitly requested.

**Alternatives considered**:
- Post-filtering (request all cabins, filter client-side) — budget-inefficient, inaccurate for rare cabins.

---

## R1: Mixed-Cabin Offer Handling

**Decision**: Flexible validation — keep mixed-cabin offers, flag them with specific per-segment details.

**Rationale**: Regional feeder flights often lack premium cabins. Discarding entire itineraries is too aggressive and kills valid multi-leg journeys. Industry standard is to keep and warn.

**Alternatives considered**:
- Strict discard — too aggressive, yields zero results on complex routes.
- Threshold-based filtering — incorporated into the three-tier status instead.

---

## R2: Three-Tier Cabin Match Classification

**Decision**: Deterministic, single-rule classification: `full` / `mixed` / `downgraded`.

**Algorithm**:
```
1. Find the longest-duration segment across all slices
2. If that segment's cabinClass ≠ requestedCabinClass → "downgraded"
3. Else if any other segment's cabinClass ≠ requestedCabinClass → "mixed"
4. Else → "full"
5. Worst case wins
```

**Rationale**: No magic thresholds, no tunables, no ambiguity from segment ordering. "Longest segment" alone resolves feeder-leg-vs-main-flight correctly without requiring a buffer multiplier.

**Alternatives considered**:
- Two-tier (full/mixed only) — user said keep `downgraded` because "feeder in economy but long-haul in business" is fundamentally different from "main flight itself is economy".
- 2× duration buffer for "primary segment" detection — rejected by user as an unjustifiable tunable constant.

---

## R3: Passenger Type DTO — Flat Fields

**Decision**: Flat fields (`adults`, `children`, `infants`) on the request DTO, not a structured array.

**Rationale**: Eliminates cache-key ordering issues by construction. Simple to validate. Covers adult/child/infant which is the aviation industry standard.

**Alternatives considered**:
- Structured array `passengers: { type, count }[]` — more flexible but introduces ordering-dependent cache keys requiring normalization.

---

## R4: Isolated Passenger Mapper

**Decision**: Single mapper function in `DuffelService` converts flat DTO fields → Duffel's passenger array.

**Rationale**: If Duffel adds `young_adult` or `senior`, only this small function changes. No DTO, controller, or frontend changes needed.

---

## R5: Cache Key Expansion

**Decision**: Accept the expanded cache key space. SHA-256 of `{ origin, destination, departureDate, returnDate, adults, children, infants, cabinClass }`.

**Rationale**: Different cabins genuinely return different offers — separate cache entries are correct. Flat fields = deterministic ordering by construction (no normalization needed). Budget impact accepted — 2,000/month is sufficient for development/early production.

**Alternatives considered**:
- Cache warming for popular combinations — rejected as premature optimization.
- Raising budget limits — not needed yet.

---

## R6: Schema Migration — Flat Columns

**Decision**: Replace `passengers Int` with `adults Int`, `children Int @default(0)`, `infants Int @default(0)`, `cabinClass String @default("economy")` on `FlightOffer` and `SearchHistory`.

**Rationale**: Early development stage — clean migration is trivial. Flat columns enable rich analytics queries (`GROUP BY cabinClass`, `WHERE children > 0`) without JSON extraction.

**Alternatives considered**:
- JSON `passengerBreakdown` column — rejected as a code smell for known-shape structured data.
- Keep `passengers` as denormalized total — not needed, can be computed as `adults + children + infants`.

---

## R7: Agent Gateway — Honest Degradation

**Decision**: Default to economy/all-adults. Add keyword detection for unsupported requests. Respond honestly. Log triggers for upgrade analytics. Use same DTO shape as frontend.

**Rationale**: NLP extraction is separate work in a different service (Python agent). Keyword detection is a lightweight, low-risk way to prevent silent degradation. Same DTO shape ensures zero interface migration when the full upgrade ships.

**Future upgrade trigger**: >10% of chatbot queries mention non-economy cabins or child/infant passengers (measured from keyword trigger logs).
