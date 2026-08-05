# Ancillary Seat and Baggage Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a development-only, single-screen ancillary prototype with three layout variants, flight-specific seat maps and prices, Seats/Baggage tabs, and a live in-memory estimate.

**Architecture:** Keep the existing Server Component prototype page and isolate all interaction in its existing client component. Model each mock segment as ordered seat-map elements so aisles are data, not layout assumptions; derive each segment's legend from that segment's seat services. Reuse existing semantic theme tokens and make no API, persistence, or payment changes.

**Tech Stack:** Next.js App Router 14.2.3, React 18, TypeScript 5, Tailwind CSS 4 project tokens.

## Global Constraints

- The prototype route remains `/prototype/ancillary-selection` and is clearly marked development-only.
- Variants remain shareable as `?variant=A|B|C`; the active service remains shareable as `?service=seats|baggage`.
- The page is one screen with semantic Seats and Baggage tabs.
- Aircraft layout, aisles, seat prices, availability, and legends are segment-specific data.
- Seat state must never rely on color alone.
- Use existing semantic color tokens only; do not add hardcoded hex values or raw Tailwind palette classes.
- State is in memory only. Do not call APIs, write local storage, create payments, or alter production checkout routes.
- This is throwaway prototype code: per the selected `prototype` skill, add no automated tests; verify with lint/type checks and direct browser inspection.
- Do not modify or revert the unrelated `.pnpm-store` worktree change.

---

## File Structure

- Modify `apps/web/app/prototype/ancillary-selection/AncillarySelectionPrototype.tsx`: mock segment model, tab state, passenger/segment switching, dynamic seat rendering, baggage controls, totals, and three layout variants.
- Modify `apps/web/app/prototype/ancillary-selection/NOTES.md`: URLs, behavior, flight-specific layout decision, and cleanup reminder.
- Modify `context/progress-checker.md`: record only that a throwaway Phase 4/5 visual prototype exists and is awaiting a winning variant; do not mark production Phase 4 or Phase 5 complete.

### Task 1: Flight-specific seat-map model and renderer

**Files:**
- Modify: `apps/web/app/prototype/ancillary-selection/AncillarySelectionPrototype.tsx`

**Interfaces:**
- Produces: `PrototypeSegment` and `SeatMapElement` local types.
- Produces: `segmentKey(segmentId, passengerId): string` for strict selection isolation.
- Consumes: existing `BookingIntentDto` mock passenger and currency data.

- [ ] **Step 1: Replace the fixed six-seat row model with ordered segment data**

Define two segments. Each row contains ordered elements, including an explicit aisle:

```tsx
type SeatMapElement =
  | { type: 'seat'; id: string; price: number; band: SeatBand; status: SeatStatus }
  | { type: 'aisle'; id: string };

type PrototypeSegment = {
  id: string;
  origin: string;
  destination: string;
  aircraft: string;
  rows: SeatMapElement[][];
};

const prototypeSegments: PrototypeSegment[] = [
  makeSegment('outbound', 'JFK', 'LHR', 'Airbus A320', ['A', 'B', 'C', '|', 'D', 'E', 'F']),
  makeSegment('connection', 'LHR', 'EDI', 'Embraer E190', ['A', 'B', '|', 'C', 'D']),
];
```

The `makeSegment` helper must assign segment-specific example amounts so the two legends differ.

- [ ] **Step 2: Derive the legend from the active segment**

Build unique price entries from active-segment seat elements, ordered by numeric price. Map the ordered prices to semantic band names for display only; do not assume supplier tier names.

```tsx
const priceLegend = Array.from(
  new Map(activeSegment.rows.flat().flatMap((element) =>
    element.type === 'seat' ? [[element.price, element.band] as const] : []
  )).entries(),
).sort(([left], [right]) => left - right);
```

- [ ] **Step 3: Render every ordered element without dropping a seat**

Render `type === 'aisle'` as a labelled spacer and every `type === 'seat'` as a button. Do not branch on a seat array index. Use flexible row layout so both `3–3` and `2–2` segments work from the same renderer.

- [ ] **Step 4: Replace missing `seat-tier-*` classes with semantic project tokens**

Use a local class map composed only from existing tokens:

```tsx
const seatBandClasses: Record<SeatBand, string> = {
  value: 'border-text-match-fair bg-bg-match-fair text-text-match-fair',
  standard: 'border-text-confirmed bg-bg-confirmed text-text-confirmed',
  comfort: 'border-text-pending bg-bg-pending text-text-pending',
  front: 'border-text-match-weak bg-bg-match-weak text-text-match-weak',
};
```

Unavailable, group-held, and active selections must also retain `×`, passenger initials, or `✓` indicators and descriptive accessible names.

- [ ] **Step 5: Run focused static verification**

Run:

```powershell
pnpm --filter @web/frontend exec eslint app/prototype/ancillary-selection/AncillarySelectionPrototype.tsx
pnpm --filter @web/frontend exec tsc --noEmit --pretty false
```

Expected: the prototype file has no lint errors. If the repository-wide TypeScript check fails only in pre-existing non-prototype files, record those exact paths and confirm no diagnostic references the prototype route.

- [ ] **Step 6: Commit Task 1**

```powershell
git add apps/web/app/prototype/ancillary-selection/AncillarySelectionPrototype.tsx
git commit -m "feat: model flight-specific prototype seat maps"
```

### Task 2: Semantic tabs, scoped selections, baggage, and price estimate

**Files:**
- Modify: `apps/web/app/prototype/ancillary-selection/AncillarySelectionPrototype.tsx`

**Interfaces:**
- Consumes: `PrototypeSegment`, `SeatMapElement`, `segmentKey`, and segment-derived legend from Task 1.
- Produces: in-memory `selectedSeats: Record<string, string>` keyed by segment/passenger.
- Produces: in-memory baggage quantity keyed by passenger and coverage option.

- [ ] **Step 1: Implement semantic service tabs**

Render one `role="tablist"`, two `role="tab"` buttons with `aria-selected` and `aria-controls`, and one active `role="tabpanel"`. Continue to update the `service` URL parameter with `router.replace`.

- [ ] **Step 2: Add segment and passenger controls**

Add segment tabs above passenger choices. Preserve the active passenger when segments change and preserve every selection in `selectedSeats` using:

```tsx
const scope = segmentKey(activeSegment.id, activePassenger.id);
const selectedSeatId = selectedSeats[scope] ?? null;
```

When a seat is selected, reject any seat already selected by the other passenger on the same segment. Render that seat with the other passenger's initials and accessible name.

- [ ] **Step 3: Keep baggage passenger-specific and coverage-labelled**

Show at least one full-journey option and one segment-only option. Controls must identify the passenger, weight, coverage, unit price, and selected quantity. Keep changes in memory and prevent the demo from selecting overlapping equivalent coverage for the same passenger.

- [ ] **Step 4: Compute and announce the live estimate**

Sum every scoped seat selection once and every baggage selection as `price * quantity`. Render base fare, seats, baggage, and grand total in all three variants. Wrap the changing total in `aria-live="polite"` and keep **Continue (prototype)** disabled.

- [ ] **Step 5: Preserve three structurally different variants**

Keep:

- A: working surface plus sticky detailed total.
- B: centered focused surface plus bottom price strip.
- C: left travel-wallet navigation plus active workspace.

Each variant must reuse the same interaction state but retain a materially different page structure.

- [ ] **Step 6: Run focused static verification**

Run the same eslint and TypeScript commands from Task 1. Expected: no diagnostics from the prototype route.

- [ ] **Step 7: Commit Task 2**

```powershell
git add apps/web/app/prototype/ancillary-selection/AncillarySelectionPrototype.tsx
git commit -m "feat: complete ancillary prototype interactions"
```

### Task 3: Document and inspect the prototype

**Files:**
- Modify: `apps/web/app/prototype/ancillary-selection/NOTES.md`
- Modify: `context/progress-checker.md`

**Interfaces:**
- Consumes: final variant and URL behavior from Tasks 1–2.
- Produces: durable prototype handoff and accurate project status.

- [ ] **Step 1: Update prototype notes**

Document these URLs and decisions:

```text
/prototype/ancillary-selection?variant=A&service=seats
/prototype/ancillary-selection?variant=B&service=seats
/prototype/ancillary-selection?variant=C&service=baggage
```

State that the mock segments intentionally demonstrate `3–3` and `2–2` layouts, that their legends come from segment data, and that all selections reset on reload.

- [ ] **Step 2: Update project progress without overstating completion**

Add a note under Feature 15 that a development-only visual prototype is available for review. Keep the current production milestone at Phase 2 complete / Phase 3 next.

- [ ] **Step 3: Start the web app with one command**

Run:

```powershell
pnpm --filter @web/frontend dev
```

Expected: Next.js starts and reports the local frontend URL.

- [ ] **Step 4: Inspect all required behaviors**

Open each variant and verify:

- Seats and Baggage tabs change only the active panel.
- Both passengers and both segments can be selected.
- The outbound map shows all six seats around a real aisle.
- The second map shows all four seats around a real aisle.
- The price legend changes with the segment.
- Seat and baggage changes update the estimate.
- Switching variants preserves the current in-memory choices.
- No ancillary, payment, or booking mutation request is sent.

- [ ] **Step 5: Run final static checks**

Run:

```powershell
pnpm --filter @web/frontend exec eslint app/prototype/ancillary-selection/AncillarySelectionPrototype.tsx app/prototype/ancillary-selection/page.tsx
git diff --check
```

Expected: both commands pass.

- [ ] **Step 6: Commit documentation**

```powershell
git add apps/web/app/prototype/ancillary-selection/NOTES.md context/progress-checker.md
git commit -m "docs: hand off ancillary UI prototype"
```
