# Secure profile UI prototype

## Question

Does a single page make it more convenient for travelers to review and correct every profile field before booking?

## Approved direction

The browser review selected the first direction: a sectioned single-page editor with identity, contact, travel document, and preferences shown together. It uses a completion summary, section-level status labels, a privacy notice, and one persistent save action.

## SaaS workspace direction

The refinement keeps the approved single-page editor, but frames it as a compact operational workspace: a local brand/workspace header, readiness breadcrumb, session/sync status, account chip, and a concise profile-health strip. These cues are intentionally disposable and non-functional; they explain the product surface without creating navigation or API commitments.

The palette direction is navy for trust and structure, sky for focus and active context, green for healthy/safe states, and a warm action accent for save/attention moments. Purple is intentionally excluded so this prototype does not inherit the legacy application header accent.

## Disposable boundary

- Route: `/prototype/profile`
- Data: in-memory mock values only; no API calls, persistence, URL state, or analytics.
- Save behavior: simulated success followed by a revision-conflict state on the next save.
- This prototype does not replace the planned production `/profile` route.
- The workspace shell is a visual prototype only and should not be promoted directly into production without product and brand review.

## Refinement

- Country code and phone number now share one labeled field group while retaining separate in-memory values for the planned API shape.
- The visual treatment now uses modern system typography and theme-token-based glassmorphism: translucent surfaces, blur, soft glows, and inset highlights.
- The prototype now uses a darker ocean background with previous-header-inspired primary navigation for Dashboard, Search Flights, My Bookings, and the active Profile view.
