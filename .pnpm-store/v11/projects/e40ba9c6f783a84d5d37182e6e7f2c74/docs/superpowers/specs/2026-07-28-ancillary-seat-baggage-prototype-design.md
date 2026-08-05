# Ancillary Seat and Baggage Prototype Design

## Question

What single-screen layout makes flight-specific seat selection and baggage selection easy to understand while keeping prices visible?

This is a throwaway, development-only UI prototype for Feature 15 plan phases 4 and 5. It explores the browsing and price-summary experience only. It does not call ancillary, payment, or booking APIs.

## Host and Variants

The prototype lives at `/prototype/ancillary-selection`. Three structurally different layouts are selected with `?variant=A|B|C` and a development-only floating switcher:

- **A — Cabin Studio (recommended):** wide working area with a sticky detailed price summary.
- **B — Focused Journey:** centered single-column flow with a compact total after the active section.
- **C — Travel Wallet:** persistent navigation rail beside the active section.

All variants show one checkout screen with two semantic tabs: **Seats** and **Baggage**. Switching tabs preserves all in-memory selections.

## Seat Experience

The prototype demonstrates that aircraft layouts are flight-segment data, not fixed UI structure:

- One segment uses a `3–aisle–3` cabin.
- A second segment uses a narrower `2–aisle–2` cabin.
- The renderer inserts aisle and non-seat elements without replacing or dropping seats.
- Segment and passenger controls allow free switching while keeping selections isolated by segment and passenger.

Seat services have segment-specific prices. Each segment derives its own ordered price legend from the services available on that segment. Four visually distinct example price bands demonstrate the concept without making production assumptions about fixed tier names.

Color is supplementary. Every seat also exposes its designator, price, and state through text, symbols, accessible names, and disabled/pressed semantics. The prototype distinguishes available seats, the active passenger's selection, another group passenger's selection, and unavailable seats.

## Baggage Experience

The Baggage tab shows in-memory, passenger-specific baggage choices with clear journey-wide or segment-only coverage. Quantity changes update the estimate immediately. The prototype explains that final availability and overlap validation are supplier-controlled; it does not simulate server persistence or payment validation.

## Price Summary

Every variant keeps an estimated breakdown available:

- Base flight fare
- Seat total
- Baggage total
- Estimated grand total

The estimate updates locally with zero repricing requests. A disabled **Continue (prototype)** action makes the non-production boundary explicit. Phase 5's authoritative repricing, immutable selection binding, Stripe authorization, and Duffel ordering remain outside this visual prototype.

## State and Navigation

Variant and active service are shareable URL search parameters. Segment, passenger, seat, and baggage selections stay in React memory and reset on reload. The prototype uses mock catalog data shaped around the normalized ancillary contract; it does not persist or mutate production checkout state.

## Accessibility

- Seats and Baggage use tab/tablist/tabpanel semantics.
- Segment and passenger choices expose selected state.
- Seat controls use grid semantics, visible focus, disabled state, accessible labels, and non-color indicators.
- All interactive controls remain keyboard reachable.
- Price changes are announced politely.
- Desktop-first seat maps may scroll horizontally at narrow widths without hiding the service controls or total.

## Verification

Before handoff:

- Run the web TypeScript and lint checks relevant to the prototype.
- Verify all three variants render.
- Verify both service tabs preserve selections.
- Verify the `3–3` and `2–2` maps render every seat with a real aisle between columns.
- Verify segment legends reflect different segment price data.
- Verify the total responds to seat and baggage changes without network calls.

## Cleanup

After review, record the preferred variant or combination in the prototype notes. Delete losing variants and the development switcher before translating the selected direction into production components.
