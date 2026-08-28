# Research: Authenticated Booking Dashboard

## Decision 1: Use a dedicated dashboard aggregate endpoint

**Decision**: Add authenticated `GET /api/dashboard/summary` in a dedicated NestJS `DashboardModule`.

**Rationale**: The dashboard has a stable aggregate contract that should not inherit pagination and payload changes from booking-management endpoints. One call also avoids multiple Server Component round trips.

**Alternatives considered**: Compose existing booking/profile calls was rejected for over-fetching and coupling. Adding the read to `BookingManagementService` was rejected because the aggregate is an independent boundary.

## Decision 2: Query PostgreSQL directly with no Redis cache

**Decision**: Inject `PrismaService`, run four indexed counts and one five-row recent query per request, and use `cache: 'no-store'` in Next.js.

**Rationale**: Expected per-user volumes are small, indexes already cover the filters, and freshness matters more than avoiding inexpensive local reads.

**Alternatives considered**: Redis summary caching and a materialized dashboard table were rejected because both add invalidation/consistency work without demonstrated need.

## Decision 3: Keep booking-only metrics

**Decision**: Display `totalBookings`, `upcomingBookings`, `completedBookings` and `cancelledBookings` using one captured request time and the repository's canonical status family.

**Rationale**: These metrics are deterministic from the canonical Booking entity and need no exchange-rate, trip, profile or AI subsystem.

**Alternatives considered**: Disruption Shield, total spent, trips planned and average match score were rejected or deferred because no approved deterministic calculation exists today.

**Schema reconciliation**: The ADR's illustrative `BookingStatus.CANCELLED` does not exist in the current Prisma enum, and the booking lifecycle can move past travel from `CONFIRMED` to `COMPLETED`. To preserve the approved business meaning without a migration:

- `upcomingBookings` counts `CONFIRMED` with `departureAt >= now`.
- `completedBookings` counts canonical `COMPLETED` plus `CONFIRMED` with `departureAt < now` (the latter covers records not yet reconciled by lifecycle completion).
- `cancelledBookings` counts `CANCELLATION_PENDING`, `CANCELLED_PENDING_REFUND`, `CANCELLED_AND_REFUNDED`, `CANCELLED_NO_REFUND`, and `REFUND_FAILED_NEEDS_ATTENTION` because each represents an explicitly initiated cancellation at a different settlement stage.

Counting only the two terminal cancellation states was rejected because it would make the dashboard count drop or lag while cancellation/refund processing is underway. Referencing a nonexistent aggregate `CANCELLED` enum or introducing one was rejected because it violates the canonical-enum and no-migration guardrails.

## Decision 4: Return five PII-safe recent booking projections

**Decision**: Return five records ordered by `createdAt desc`, containing only booking ID, status, timestamps and nullable route/airline display fields.

**Rationale**: This supports the approved timeline and direct booking links without creating a generic activity stream or exposing raw snapshots/provider IDs.

**Alternatives considered**: A generic audit feed and full booking detail DTOs were rejected as unsupported and over-broad.

## Decision 5: Use a shared Zod contract as the only response definition

**Decision**: Define dashboard response schemas/types in `packages/shared/src/types/dashboard.types.ts`; both API and Next.js import them.

**Rationale**: Runtime validation is required at the server boundary, while a shared definition prevents DTO drift and ad-hoc status strings.

**Alternatives considered**: Duplicate Nest DTO and web interfaces were rejected because they can diverge silently.

## Decision 6: Preserve prototype hierarchy through semantic production tokens

**Decision**: Adapt the approved glassmorphic layout, stats grid, action grid and recent timeline; create semantic dashboard surface/text/action tokens with light/dark/fallback behavior.

**Rationale**: The prototype is the visual source, while repository rules forbid copying hardcoded hex values or raw Tailwind colors into production.

**Alternatives considered**: Copying prototype CSS verbatim was rejected due to mock content, inline styles, hardcoded colors and prototype routes. A generic card page was rejected because it discards the approved direction.

## Decision 7: Keep the server/client credential boundary

**Decision**: Fetch summary data only from `apps/web/lib/server/dashboard.ts`; pass validated display data into UI components.

**Rationale**: This matches existing booking-management architecture and prevents JWT/backend topology from entering client bundles.

**Alternatives considered**: Client-side `useSession` fetching was rejected; a same-origin route handler is unnecessary without client polling or mutations.

## Decision 8: Make root authentication routing server-side

**Decision**: Convert `apps/web/app/page.tsx` to an async Server Component that checks the existing session, redirects authenticated users to `/dashboard`, and otherwise renders `LandingPage`.

**Rationale**: It avoids a visible client redirect and does not need a dashboard API call.

**Alternatives considered**: A client effect and broad middleware redirect were rejected as inferior or overly broad for one route.

## Resolved Unknowns

- No new third-party dependency or database migration is needed.
- No external API or AI request is needed.
- The local Next.js installation does not ship `node_modules/next/dist/docs`; implementation must follow existing repository App Router patterns and validate against installed Next.js 14.2.3 types/build.
- The ADR owns data semantics when static prototype content conflicts with supported live data.
- The prototype's `/prototype/chat` action links have no production counterpart. The global layout already mounts `ChatWidget`, so the assistant remains accessible there. The quick-action grid always offers `/search`, `/bookings?tab=upcoming`, and `/bookings?tab=past`; `/profile` is added only when the existing server-side `isBookingReadinessEnabled()` helper returns true. Dashboard rollout does not require booking readiness. A generic disruption-center tile is deferred until a real production route and contract exist.
- The approved dashboard sidebar conflicts with the older project-overview rule of top-navigation-only pages. Treat the approved prototype/ADR as the later, feature-specific decision: use a dashboard-scoped desktop sidebar and compact mobile navigation without changing the global shell of other pages.
