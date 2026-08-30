# Implementation Notes: Authenticated Booking Dashboard

**Feature Branch**: `021-dashboard-building`  
**Base Commit SHA**: `2af59d3` (_fixing the plans_)  
**Created**: 2026-08-28  
**Status**: In Progress

---

## 1. Feature Execution Baseline (Task T001)

This section establishes the execution baseline, tooling matrix, and runtime requirements for feature `021-dashboard-building`.

### 1.1 Source Control & Environment

| Parameter                    | Value                               | Notes                                                                 |
| :--------------------------- | :---------------------------------- | :-------------------------------------------------------------------- |
| **Feature Branch**           | `021-dashboard-building`            | Dedicated feature branch branched from `development`                  |
| **Base Commit SHA**          | `2af59d3`                           | Baseline commit containing finalized and approved spec/plan artifacts |
| **Monorepo Package Manager** | `pnpm 11.9.0`                       | Workspace-aware monorepo package orchestration                        |
| **Node.js Engine**           | `Node.js 20+` (`v24.14.0` local)    | LTS execution target with native `fetch` and ESM support              |
| **Next.js Framework**        | `14.2.3`                            | App Router paradigm (`apps/web`)                                      |
| **NestJS Framework**         | `10.4.22`                           | Backend modular architecture (`apps/api`)                             |
| **Prisma ORM**               | `5.22.0`                            | PostgreSQL client & type generation (`apps/api`)                      |
| **React**                    | `18.2.0`                            | React Server Components & client boundary components                  |
| **TypeScript**               | `5.4.5`                             | Strict type checking across workspace                                 |
| **Schema Validation**        | `Zod 3.23.8`                        | Canonical runtime contract definition & validation                    |
| **CSS & Styling**            | CSS Modules + Tailwind CSS v4 Alpha | Semantic CSS variables; zero hardcoded color literals                 |

---

## 2. Affected-File Tracking Checklist

Comprehensive inventory of all files targeted for creation, modification, or verification across the four monorepo workspaces and documentation areas:

### 2.1 Shared Package (`packages/shared/`)

- [x] [`packages/shared/src/types/dashboard.types.ts`](file:///c:/Booking%20Systems/packages/shared/src/types/dashboard.types.ts): Define `DashboardStatsSchema`, `DashboardRecentBookingSchema`, `DashboardSummarySchema`, inferred TypeScript types (`DashboardStats`, `DashboardRecentBooking`, `DashboardSummary`), and the `DashboardOutcome` tagged failure union.
- [x] [`packages/shared/src/types/dashboard.types.spec.ts`](file:///c:/Booking%20Systems/packages/shared/src/types/dashboard.types.spec.ts): Unit and contract tests for dashboard schemas (valid shapes, non-negative bounds, max 5 recent items, ISO timestamp formats, reject extraneous/PII fields).
- [x] [`packages/shared/src/types/index.ts`](file:///c:/Booking%20Systems/packages/shared/src/types/index.ts): Barrel export of dashboard schemas and types.
- [x] [`packages/shared/package.json`](file:///c:/Booking%20Systems/packages/shared/package.json): Update test scripts to include dashboard schema specifications in package test runner.

### 2.2 Backend API Service (`apps/api/`)

- [x] [`apps/api/src/dashboard/dashboard.controller.ts`](file:///c:/Booking%20Systems/apps/api/src/dashboard/dashboard.controller.ts): Implement `DashboardController` exposing `GET /dashboard/summary` protected by `JwtAuthGuard`, resolving user ID from `req.user.id`.
- [x] [`apps/api/src/dashboard/dashboard.controller.spec.ts`](file:///c:/Booking%20Systems/apps/api/src/dashboard/dashboard.controller.spec.ts): Unit tests for `DashboardController` ensuring authentication guard attachment, user ID forwarding, and response passing.
- [x] [`apps/api/src/dashboard/dashboard.module.ts`](file:///c:/Booking%20Systems/apps/api/src/dashboard/dashboard.module.ts): Declare `DashboardModule` importing `PrismaModule` and providing `DashboardService` + `DashboardController`.
- [x] [`apps/api/src/dashboard/dashboard.service.ts`](file:///c:/Booking%20Systems/apps/api/src/dashboard/dashboard.service.ts): Implement `DashboardService` querying Prisma directly (4 counts + 1 findMany) with a single captured `now` timestamp and pure snapshot mapper.
- [x] [`apps/api/src/dashboard/dashboard.service.spec.ts`](file:///c:/Booking%20Systems/apps/api/src/dashboard/dashboard.service.spec.ts): Unit tests for `DashboardService` covering metric queries, time boundaries, canonical status mappings, descending sort, `take: 5`, and malformed snapshot resilience.
- [x] [`apps/api/src/app.module.ts`](file:///c:/Booking%20Systems/apps/api/src/app.module.ts): Register `DashboardModule` in the root application imports graph.
- [x] [`apps/api/src/app.module.spec.ts`](file:///c:/Booking%20Systems/apps/api/src/app.module.spec.ts): Verify `AppModule` compilation with `DashboardModule` registered.
- [x] [`apps/api/test/dashboard.e2e-spec.ts`](file:///c:/Booking%20Systems/apps/api/test/dashboard.e2e-spec.ts): Integration E2E tests for `GET /api/dashboard/summary` verifying JWT authentication, tenant isolation across multiple users, exact contract shapes, and 401 unauthenticated behavior.

### 2.3 Frontend Web Application (`apps/web/`)

- [x] [`apps/web/app/page.tsx`](file:///c:/Booking%20Systems/apps/web/app/page.tsx): Convert landing page to an async Server Component checking session; redirects authenticated users to `/dashboard` while rendering `LandingPage` for anonymous visitors.
- [x] [`apps/web/app/globals.css`](file:///c:/Booking%20Systems/apps/web/app/globals.css): Define semantic CSS tokens for dashboard glassmorphic surfaces, typography, stats, borders, and interactive states (light/dark/fallback modes).
- [x] [`apps/web/app/dashboard/dashboard.module.css`](file:///c:/Booking%20Systems/apps/web/app/dashboard/dashboard.module.css): Scoped CSS Module providing layout grid, responsive breakpoints (360px, 768px, 1200px+), sidebar layout, and backdrop-filter fallbacks.
- [x] [`apps/web/app/dashboard/error.tsx`](file:///c:/Booking%20Systems/apps/web/app/dashboard/error.tsx): Client error boundary component adhering to Next.js contract (`error`, `reset`) with clean user messaging and no credential/stack trace leaks.
- [x] [`apps/web/app/dashboard/loading.tsx`](file:///c:/Booking%20Systems/apps/web/app/dashboard/loading.tsx): Server-rendered skeleton loading component matching exact layout geometry of `DashboardShell`.
- [x] [`apps/web/app/dashboard/page.tsx`](file:///c:/Booking%20Systems/apps/web/app/dashboard/page.tsx): Authenticated Server Component route fetching summary via `getDashboardSummary()`, handling expired tokens, evaluating `isBookingReadinessEnabled()`, and passing data to `DashboardShell`.
- [x] [`apps/web/components/dashboard/DashboardShell.tsx`](file:///c:/Booking%20Systems/apps/web/components/dashboard/DashboardShell.tsx): Production shell component composing desktop sidebar, sticky topbar, compact mobile navigation, hero banner, quick search, stats grid, quick actions, and recent activity timeline.
- [x] [`apps/web/components/dashboard/DashboardStats.tsx`](file:///c:/Booking%20Systems/apps/web/components/dashboard/DashboardStats.tsx): 2x2 responsive stat cards rendering Total, Upcoming, Completed, and Cancelled bookings with semantic tokens and icons.
- [x] [`apps/web/components/dashboard/DashboardRecentBookings.tsx`](file:///c:/Booking%20Systems/apps/web/components/dashboard/DashboardRecentBookings.tsx): Recent activity feed rendering up to 5 bookings with status chips, route indicators, dates, and links to `/bookings/[bookingId]` and `/bookings`.
- [x] [`apps/web/components/dashboard/DashboardQuickActions.tsx`](file:///c:/Booking%20Systems/apps/web/components/dashboard/DashboardQuickActions.tsx): 2x2 quick action grid linking to production travel tasks (`/search`, `/bookings?tab=upcoming`, `/bookings?tab=past`, and conditionally `/profile`).
- [x] [`apps/web/components/dashboard/DashboardQuickSearch.tsx`](file:///c:/Booking%20Systems/apps/web/components/dashboard/DashboardQuickSearch.tsx): Accessible inline search form validating origin, destination, and departure date before routing to `/search`.
- [x] [`apps/web/components/dashboard/dashboard-actions.ts`](file:///c:/Booking%20Systems/apps/web/components/dashboard/dashboard-actions.ts): Pure utility deriving available quick actions based on the `isBookingReadinessEnabled` flag.
- [x] [`apps/web/components/dashboard/dashboard-actions.spec.ts`](file:///c:/Booking%20Systems/apps/web/components/dashboard/dashboard-actions.spec.ts): Unit tests for quick action list derivation.
- [x] [`apps/web/components/dashboard/dashboard-search.ts`](file:///c:/Booking%20Systems/apps/web/components/dashboard/dashboard-search.ts): Pure search query validation, IATA normalization, and search URL generator.
- [x] [`apps/web/components/dashboard/dashboard-search.spec.ts`](file:///c:/Booking%20Systems/apps/web/components/dashboard/dashboard-search.spec.ts): Unit tests for search query building and validation logic.
- [x] [`apps/web/components/search/SearchFormClient.tsx`](file:///c:/Booking%20Systems/apps/web/components/search/SearchFormClient.tsx): Support optional initial values (`initialOrigin`, `initialDestination`, `initialDepartureDate`) from search parameters.
- [x] [`apps/web/app/search/page.tsx`](file:///c:/Booking%20Systems/apps/web/app/search/page.tsx): Pass sanitized search query parameters into `SearchFormClient`.
- [x] [`apps/web/lib/server/dashboard.ts`](file:///c:/Booking%20Systems/apps/web/lib/server/dashboard.ts): Server-only data loader acquiring JWT session, calling `GET /api/dashboard/summary` with `cache: 'no-store'`, 10s `AbortController` timeout, safe parsing via `DashboardSummarySchema`, and returning `DashboardOutcome`.
- [x] [`apps/web/lib/server/dashboard.spec.ts`](file:///c:/Booking%20Systems/apps/web/lib/server/dashboard.spec.ts): Unit tests for `getDashboardSummary` under success, 401, 403, 500, timeout, malformed payload, and unauthenticated conditions.
- [x] [`apps/web/tests/dashboard.spec.ts`](file:///c:/Booking%20Systems/apps/web/tests/dashboard.spec.ts): Playwright browser tests covering populated state, empty state, navigation links, quick search handoff, flag toggles, root redirect, login redirect, error recovery, responsive viewports (360px, 768px, 1280px), and keyboard focus.
- [x] [`apps/web/tests/dashboard-routing.unit.ts`](file:///c:/Booking%20Systems/apps/web/tests/dashboard-routing.unit.ts): Page routing unit tests covering root page redirect and dashboard session gating.

### 2.4 Context & Specification Documentation

- [ ] [`context/architecture.md`](file:///c:/Booking%20Systems/context/architecture.md): Update architecture documentation to incorporate `DashboardModule`, `GET /api/dashboard/summary`, Server Component data boundary, and direct PostgreSQL read model.
- [ ] [`context/code-standards.md`](file:///c:/Booking%20Systems/context/code-standards.md): Document dashboard CSS token standards and zero hardcoded color rules.
- [ ] [`context/progress-checker.md`](file:///c:/Booking%20Systems/context/progress-checker.md): Update progress status for Feature 021, recording milestones, test passes, and checklist items.
- [ ] [`context/project-overview.md`](file:///c:/Booking%20Systems/context/project-overview.md): Document dashboard-scoped desktop sidebar architecture and removal of prototype mock data.
- [ ] [`specs/021-dashboard-building/implementation-notes.md`](file:///c:/Booking%20Systems/specs/021-dashboard-building/implementation-notes.md): Record baseline, affected files, constraint verifications, test runs, and audit logs.
- [ ] [`specs/021-dashboard-building/checklists/contract.md`](file:///c:/Booking%20Systems/specs/021-dashboard-building/checklists/contract.md): OpenAPI contract conformance checklist.
- [ ] [`specs/021-dashboard-building/checklists/visual.md`](file:///c:/Booking%20Systems/specs/021-dashboard-building/checklists/visual.md): Visual translation, tokenization, responsive design, and accessibility audit checklist.
- [ ] [`specs/021-dashboard-building/tasks.md`](file:///c:/Booking%20Systems/specs/021-dashboard-building/tasks.md): Track task statuses across implementation phases.

---

## 3. Core Architectural Decisions

### 3.1 Direct Prisma Read Model

- **Isolated Service Boundary**: `DashboardService` injects only [`PrismaService`](file:///c:/Booking%20Systems/apps/api/src/prisma/prisma.service.ts). It does not depend on `BookingManagementService`, `ProfileService`, or payment modules.
- **Single Clock Instant (`now`)**: To eliminate time-boundary drift between count filters, `const now = new Date()` is captured once per request and passed identically to all query filters.
- **Concurrent Indexed Execution**: Five database queries run in parallel via `Promise.all`:
  1. `totalBookings`: `prisma.booking.count({ where: { userId } })`
  2. `upcomingBookings`: `prisma.booking.count({ where: { userId, status: BookingStatus.CONFIRMED, departureAt: { gte: now } } })`
  3. `completedBookings`: `prisma.booking.count({ where: { userId, OR: [{ status: BookingStatus.COMPLETED }, { status: BookingStatus.CONFIRMED, departureAt: { lt: now } }] } })`
  4. `cancelledBookings`: `prisma.booking.count({ where: { userId, status: { in: [BookingStatus.CANCELLATION_PENDING, BookingStatus.CANCELLED_PENDING_REFUND, BookingStatus.CANCELLED_AND_REFUNDED, BookingStatus.CANCELLED_NO_REFUND, BookingStatus.REFUND_FAILED_NEEDS_ATTENTION] } } })`
  5. `recentBookings`: `prisma.booking.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5, select: { id: true, status: true, createdAt: true, departureAt: true, flightSnapshot: true } })`
- **Pure Snapshot Display Mapper**: `flightSnapshot` is JSON-parsed defensively through an allowlisted field extractor. Malformed or missing snapshot data falls back to `null` display fields. Raw provider IDs, pricing data, and passenger PII are completely omitted from the projection.

### 3.2 Zero Redis Dashboard Cache

- **Direct PostgreSQL Read**: Realistic user volume is 1–100 bookings. Indexed queries on `(userId, status)` execute in < 2ms.
- **Cache Invalidation Avoidance**: Omitting Redis eliminates complex cache invalidation across booking creation, payment confirmation, cancellation, and schedule disruption handlers.
- **Real-Time Freshness**: Next.js Server Components query with `cache: 'no-store'`, guaranteeing immediate reflect of user actions upon navigation.

### 3.3 Single Server Data Boundary (`apps/web/lib/server/dashboard.ts`)

- **Server-Only Enforcement**: Guarded by `import 'server-only'` to prevent bundling into client-side code.
- **JWT Forwarding**: Extracts the session access token via `getServerSession(authOptions)` and sends `Authorization: Bearer ${token}` server-to-server.
- **Bounded Latency**: Uses `AbortController` with a 10,000 ms timeout to prevent hung requests.
- **Strict Schema Safe-Parsing**: Response payload is validated with [`DashboardSummarySchema.safeParse`](file:///c:/Booking%20Systems/packages/shared/src/types/dashboard.types.ts).
- **Typed Outcome Result**: Returns a discriminated union `DashboardOutcome<DashboardSummary>` (`{ ok: true, data }` or `{ ok: false, reason, message, retryable }`).

### 3.4 Root (`/`) Auth-Aware Server Redirect

- **Instant Hub Routing**: `apps/web/app/page.tsx` checks `getServerSession(authOptions)`.
- If an active session with valid `accessToken` exists, it immediately invokes `redirect('/dashboard')`.
- If unauthenticated, it renders `<LandingPage />` with zero client-side flicker.

### 3.5 Metric Definitions & Canonical Lifecycles

- **No Nonexistent Enums**: Avoids referencing nonexistent `BookingStatus.CANCELLED`.
- **Accurate Cancellation Count**: Covers all five canonical cancellation lifecycle states:
  - `CANCELLATION_PENDING`
  - `CANCELLED_PENDING_REFUND`
  - `CANCELLED_AND_REFUNDED`
  - `CANCELLED_NO_REFUND`
  - `REFUND_FAILED_NEEDS_ATTENTION`
- **Past Confirmed Reconciliation**: Counts both canonical `COMPLETED` and past `CONFIRMED` (`departureAt < now`) without double counting.
- **No Fake Disruption Shield**: Replaces the static prototype Disruption Shield card with the canonical `cancelledBookings` metric.

---

## 4. Next.js 14.2.3 Route & Session Constraint Verification (Task T004)

### 4.1 Server Component Session Loading

In Next.js 14.2.3 and NextAuth 4.x, `getServerSession` must be used inside Server Components and server-only modules. Due to ESM/CJS interop in modern Node.js runtimes:

```typescript
import * as NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth';

export async function getAccessToken(): Promise<string | null> {
  try {
    const sessionFn =
      typeof NextAuth.getServerSession === 'function'
        ? NextAuth.getServerSession
        : (
            NextAuth as unknown as {
              default?: { getServerSession: typeof NextAuth.getServerSession };
            }
          ).default?.getServerSession;
    if (!sessionFn) return null;
    const session = await sessionFn(authOptions);
    if (!session || typeof session !== 'object' || !('accessToken' in session)) return null;
    const token = (session as { accessToken?: unknown }).accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
```

### 4.2 Route Handlers & Server Navigation (`redirect()`)

- **`NEXT_REDIRECT` Exception Handling**: In Next.js 14 App Router, `redirect()` from `next/navigation` works by throwing a special internal error with `digest: 'NEXT_REDIRECT;...'`.
- **Critical Rule**: Never swallow exceptions from `redirect()` in broad `try { ... } catch (e) { ... }` blocks.

```typescript
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const token = await getAccessToken();
  if (!token) {
    // This throws a NEXT_REDIRECT digest error. Must not be inside an untyped catch block!
    redirect('/login');
  }
  // ...
}
```

If a `try/catch` is necessary around async operations in the page:

```typescript
try {
  const outcome = await getDashboardSummary();
  // ...
} catch (error) {
  if (isNextRedirectError(error)) {
    throw error;
  }
  // handle application error
}
```

### 4.3 Dynamic Data Fetching (`cache: 'no-store'`)

- Dynamic user-scoped data must never be cached by Next.js Data Cache.
- All server fetch calls to the NestJS API must explicitly specify:

```typescript
const response = await fetch(`${apiUrl()}/api/dashboard/summary`, {
  method: 'GET',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  },
  cache: 'no-store',
  signal: abortController.signal,
});
```

### 4.4 Zero Client Credential Invariant

- Next.js Client Components (marked with `'use client'`) must never receive JWT access tokens, API secrets, or private backend URLs (`API_URL`) via props or context.
- The Server Component (`apps/web/app/dashboard/page.tsx`) handles all authentication checks and server-side data fetching.
- `DashboardShell` and its child components receive strictly sanitized, validated display models:
  - `stats: DashboardStats`
  - `recentBookings: DashboardRecentBooking[]`
  - `isProfileEnabled: boolean`

### 4.5 Loading and Error Boundaries Contract

- **`loading.tsx`**: Server-rendered React component rendered automatically while `page.tsx` async promise resolves. Uses semantic glassmorphic skeleton placeholders matching the exact dimensions of `DashboardShell`.
- **`error.tsx`**: Must be a Client Component (`'use client'`). Next.js passes `error: Error & { digest?: string }` and `reset: () => void`.
- Sanitization: `error.tsx` must display user-friendly recovery instructions with a "Try Again" action calling `reset()`. It must never render raw error messages, network URLs, HTTP status codes, or stack traces in production.

### 4.6 Browser & E2E Testing Constraints (Windows & CI)

- **Local Port 3101 Fixture**: To ensure deterministic, opaque-box browser testing without requiring a live NestJS daemon or mutating backend databases during Playwright execution, `apps/web/tests/dashboard.spec.ts` utilizes an in-process mock HTTP server listening on port `3101` (`http://127.0.0.1:3101`).
- **Fixture Keying**: The mock server evaluates incoming `Authorization: Bearer <scenario-token>` headers to serve scenarios:
  - `token-populated`: Returns 4 stats and 5 recent bookings.
  - `token-empty`: Returns zero counts and empty `recentBookings: []`.
  - `token-malformed`: Returns invalid JSON / schema-breaking types.
  - `token-expired`: Returns HTTP 401 Unauthorized.
  - `token-server-error`: Returns HTTP 500 Internal Server Error.
- **Port Teardown**: The HTTP mock server must be bound using `server.listen(3101)` in `test.beforeAll` and closed cleanly in `test.afterAll` to prevent port collisions on Windows.
- **Playwright Execution**:
  ```powershell
  $env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3101'
  npx playwright test apps/web/tests/dashboard.spec.ts --config=apps/web/tests/playwright.config.ts
  ```

---

## 5. Verification & Execution Evidence

_(Sections below will be populated as implementation tasks progress)_

### 5.1 Shared Contract Test Execution (Task T008)

- **Command**: `pnpm --filter @shared/types test`
- **Result**: `67/67 PASS` across 12 test suites (0 failures, 0 skipped)
- **Duration**: ~3.7s
- **Exit Code**: `0`
- **Coverage**:
  - Valid `DashboardSummary` parsing with populated and null-projected display models.
  - Strict key enforcement (`.strict()`) on `DashboardStatsSchema`, `DashboardRecentBookingSchema`, and `DashboardSummarySchema`.
  - Non-negative integer validation on all 4 metric counters (`totalBookings`, `upcomingBookings`, `completedBookings`, `cancelledBookings`).
  - Canonical 9-status lifecycle enum validation (`PROCESSING`, `CONFIRMED`, `FAILED`, `COMPLETED`, `CANCELLATION_PENDING`, `CANCELLED_PENDING_REFUND`, `CANCELLED_AND_REFUNDED`, `CANCELLED_NO_REFUND`, `REFUND_FAILED_NEEDS_ATTENTION`).
  - Nullable projections for `departureAt`, `originCode`, `destinationCode`, `airlineCode`, `flightNumber`.
  - Recent booking array cap (`max(5)`).
  - ISO 8601 UTC and offset datetime parsing (`{ offset: true }`).
  - UUID v4 format validation.
  - `DashboardOutcome` discriminated union across all 4 canonical failure reasons (`UNAUTHENTICATED`, `FORBIDDEN`, `UPSTREAM_UNAVAILABLE`, `INVALID_RESPONSE`) and `retryable` boolean flag.
  - Static type inference parity assertions (`Assert<Equal<...>>`).

### 5.2 API Service & Integration Test Execution (Task T019)

- **Unit & Controller Tests**:
  - **Command**: `pnpm --filter @api/backend test -- src/dashboard/dashboard.service.spec.ts src/dashboard/dashboard.controller.spec.ts src/app.module.spec.ts`
  - **Result**: `36/36 PASS` across 3 test suites (0 failures, 0 skipped)
    - `src/dashboard/dashboard.service.spec.ts`: 14/14 tests pass
    - `src/dashboard/dashboard.controller.spec.ts`: 7/7 tests pass
    - `src/app.module.spec.ts`: 15/15 tests pass
  - **Exit Code**: `0`
- **API E2E Integration Suite**:
  - **Command**: `pnpm --filter @api/backend test:e2e -- test/dashboard.e2e-spec.ts`
  - **Result**: `7/7 PASS` across 1 test suite (0 failures, 0 skipped)
    - HTTP 401 Unauthorized (missing header & invalid token)
    - User A vs User B strict tenant isolation
    - Empty state parity for user without bookings
    - Recent 5 limit and descending `createdAt` ordering
    - Negative privacy invariants (0 PII, 0 secrets, 0 raw snapshots, 0 supplier IDs)
    - Private no-store Cache-Control header verification
  - **Exit Code**: `0`
- **Static Gate & Linting**:
  - **Typecheck**: `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` -> Exit `0` (0 errors)
  - **ESLint**: `pnpm exec eslint "apps/api/src/dashboard/**/*.ts" --max-warnings 0` -> Exit `0` (0 warnings)
  - **CI Workflow Contract**: `node --test tests/ci/ci-workflow.contract.test.mjs` -> `20/20 PASS`, Exit `0`

### 5.3 Web Server Loader & UI Unit Test Execution (Task T029)

- **Server Loader Unit Tests**:
  - **Command**: `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/dashboard.spec.ts`
  - **Result**: `20/20 PASS` across 7 test suites (0 failures, 0 skipped, duration ~3.1s)
  - **Exit Code**: `0`
  - **Coverage**:
    - Unauthenticated session detection (null, missing accessToken, empty accessToken).
    - Bearer token header forwarding, `cache: 'no-store'`, dynamic API URL resolution, and trailing slash trimming.
    - 10s `AbortController` timeout handling mapped to `UPSTREAM_UNAVAILABLE` (retryable: true).
    - HTTP status code mapping (401 -> `UNAUTHENTICATED`, 403 -> `FORBIDDEN`, 500/502/503/504 -> `UPSTREAM_UNAVAILABLE`).
    - Zod schema validation rejecting malformed JSON, missing stats, negative counts, invalid status enums, invalid ISO dates, >5 items, and extra keys violating `.strict()`.
    - Zero credential / stack trace leakage across all failure branches.
- **Next.js Lint & Typecheck**:
  - **Lint**: `pnpm --filter @web/frontend lint` -> Exit `0` (0 errors)
  - **Typecheck**: `pnpm --filter @web/frontend typecheck` -> Exit `0` (0 errors)
- **Next.js Production Build**:
  - **Command**: `pnpm --filter @web/frontend build`
  - **Result**: Compiled successfully, static and dynamic pages generated (`ƒ /dashboard` Server Component route: 1.31 kB, First Load JS: 95.2 kB).
  - **Exit Code**: `0`
- **Playwright Dashboard Feature Acceptance (E2E)**:
  - **Command**: `npx playwright test apps/web/tests/dashboard.spec.ts --config=apps/web/tests/playwright.config.ts`
  - **Result**: 4/4 scenarios pass (Populated Overview with 4 cards and 5 items, Empty State with Search CTA, Zero-Mock Anti-Prototype Guardrail, Unauthenticated Redirect to `/login`).
- **CI Workflow Contract**:
  - **Command**: `node --test tests/ci/ci-workflow.contract.test.mjs`
  - **Result**: `20/20 PASS`, Exit `0`

### 5.4 Playwright Browser Suite & Routing Execution (Task T043)

- **Root & Dashboard Page Routing Unit Tests**:
  - **Command**: `& '.\node_modules\.bin\tsx.CMD' --test apps/web/tests/dashboard-routing.unit.ts`
  - **Result**: `6/6 PASS` across 2 suites (0 failures, 0 skipped, duration ~10.3s)
  - **Exit Code**: `0`
  - **Coverage**:
    - Authenticated session redirect from `/` to `/dashboard`.
    - Anonymous session preservation rendering `LandingPage` on `/`.
    - Unauthenticated dashboard session redirect to `/login?callbackUrl=/dashboard`.
    - Non-masked `Error("Unable to load dashboard.")` throw on `UPSTREAM_UNAVAILABLE`.
    - Non-masked `Error("Unable to load dashboard.")` throw on `INVALID_RESPONSE`.
    - Render `DashboardShell` without redirect when summary loader returns `ok: true`.

- **Quick Actions & Quick Search Unit Tests**:
  - **Command**: `& '.\node_modules\.bin\tsx.CMD' --test apps/web/components/dashboard/dashboard-actions.spec.ts apps/web/components/dashboard/dashboard-search.spec.ts`
  - **Result**: `13/13 PASS` (0 failures, 0 skipped, duration ~3.5s)
  - **Exit Code**: `0`
  - **Coverage**:
    - Action derivation omitting `/profile` when readiness is disabled and including `/profile` when enabled.
    - Presence of required fields (`label`, `description`, `icon`, `href`) on every enabled action.
    - Airport code trimming and capitalization (`SGN`, `HAN`).
    - Validation rejecting empty origin/destination, codes < 3 chars, identical origin/dest, and past dates.
    - Acceptance of same-day and future dates.
    - Search URL construction preserving param ordering (`/search?origin=...&destination=...&departureDate=...&adults=1&cabinClass=economy`).

- **Dashboard Server Loader Unit Tests**:
  - **Command**: `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/dashboard.spec.ts`
  - **Result**: `20/20 PASS` across 7 test suites (0 failures, 0 skipped)
  - **Exit Code**: `0`

- **Frontend Lint & Typecheck**:
  - **Lint**: `pnpm --filter @web/frontend lint` -> Exit `0` (0 errors)
  - **Typecheck**: `pnpm --filter @web/frontend typecheck` -> Exit `0` (0 errors)

- **Next.js Production Build**:
  - **Command**: `pnpm --filter @web/frontend build`
  - **Result**: `23/23` static & dynamic pages generated successfully (`ƒ /dashboard` Server Component route: 3.48 kB, First Load JS: 97.4 kB; `ƒ /search`: 3.88 kB; `ƒ /`: 520 B).
  - **Exit Code**: `0`

- **CI Workflow Contract**:
  - **Command**: `node --test tests/ci/ci-workflow.contract.test.mjs`
  - **Result**: `20/20 PASS` (0 failures, 0 skipped)
  - **Exit Code**: `0`

### 5.5 Monorepo Quality Gate Matrix (Task T047)

- Contract: `pnpm --filter @shared/contracts test`
- API Lint & Typecheck: `pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0` && `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`
- Web Lint, Typecheck & Build: `pnpm --filter @web/frontend lint` && `pnpm --filter @web/frontend typecheck` && `pnpm --filter @web/frontend build`
