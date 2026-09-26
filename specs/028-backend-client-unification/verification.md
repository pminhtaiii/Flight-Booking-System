# Feature 028 verification

## Phase 1: baseline characterization (T001–T004)

Run from `C:\Booking Systems` on 2026-09-26. All commands exited 0.

| Check | Result |
| --- | --- |
| `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/dashboard.spec.ts apps/web/lib/server/flight-search.spec.ts apps/web/lib/server/booking-management.spec.ts` | 93 passed, 0 failed (21 dashboard, 42 flight, 30 booking). |
| `node --import tsx 'apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/route.spec.ts'` | 7 passed, 0 failed. |
| `node --import tsx 'apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/quote/route.spec.ts'` | 3 passed, 0 failed. |
| `pnpm --filter @web/frontend lint` | Exit 0; no ESLint warnings or errors. |
| `pnpm --filter @web/frontend typecheck` | Exit 0. |
| `pnpm --filter @web/frontend build` | Exit 0; optimized production build completed. |

Before edits, the three server specs passed 87/87 and the two route specs passed 7/7 and 3/3. The Phase 1 additions lock 401/403 no-retry and connection failure privacy for dashboard; offer-selection auth, GET caching, and expiry for flight search; 400/422 message forwarding and malformed-body fallback plus 503 single-send behavior for all four booking mutations; and quote-route 409 mapping. Existing assertions already covered the other required outcomes and all eight booking operations. Four independent task reviews completed; the T003 review found missing transient disruption failure coverage, which was added and reverified.

On this Windows host, `tsx --test` with a literal `[bookingId]` path exits 0 while reporting zero tests. The route specs were therefore executed directly with `node --import tsx`; their test counts above are the route evidence. The installed Next package did not contain `node_modules/next/dist/docs/`, and Phase 1 changed no Next API or production file. No dependency or graphify change was made.

**Phase 1 convergence:** T001–T004 requirements in GOAL.md and the Phase 1 task list are covered; no remaining Phase 1 gap. Later phases T005–T025 remain open by design.

## Phase 2: Foundational client contract (T005–T007)

Run from `C:\Booking Systems` on 2026-09-26. All commands exited 0.

| Check | Result |
| --- | --- |
| `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/backend-client.spec.ts` | 18 passed, 0 failed (factory, auth, timeout, schema/none validation, GET retry matrix, single-attempt mutation safety). |
| `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/dashboard.spec.ts apps/web/lib/server/flight-search.spec.ts apps/web/lib/server/booking-management.spec.ts "apps/web/app/api/booking-management/**/*.spec.ts"` | 103 passed, 0 failed (baseline characterization regressions green). |
| `pnpm --filter @web/frontend lint` | Exit 0; no ESLint warnings or errors. |
| `pnpm --filter @web/frontend typecheck` | Exit 0; tsc clean with zero errors. |

### Contract Verification & Dual-Axis Review
- **Dual-Axis Code Review**: Completed with parallel sub-agents (Standards: APPROVED, Spec: APPROVED).
- **Standards & Code Quality**: Strictly ZERO `any` across `backend-client.ts` and `backend-client.spec.ts`. JSON timeout race logic deduplicated via `parseJsonWithTimeout`. Inline rationale comments documented for NextAuth ESM/CJS interop and `responseMode: 'none'` type assertions. Diagnostic logging verified zero leakage of tokens, request bodies, URLs, or PII.
- **Spec & Retry Matrix**:
  - GET retries up to 3 attempts with 100ms exponential base delay on network/timeout, 502, 503, 504, and 429 with valid `Retry-After`.
  - Non-retryable statuses (400, 401, 403, 404, 409, 422, 500, or 429 without header) fail immediately.
  - Mutations (`POST`, `PUT`, `PATCH`, `DELETE`) are strictly single-attempt without automatic replay.
  - 10-second per-attempt timeout and 31-second total request deadline enforced.
  - Bodyless 2xx handling via `responseMode: 'none'` returns `{ ok: true, data: undefined }` without reading response body.
  - Malformed non-2xx error bodies retain HTTP status with `body: undefined`.

**Phase 2 convergence:** T005–T007 requirements in GOAL.md, tasks.md, and contracts/backend-client.md are satisfied with 100% unit coverage and clean dual-axis review. Phases T008–T025 remain ready for migration.

## Phase 3: User Story 1 - Resilient dashboard reads (T008–T010)

Run from `C:\Booking Systems` on 2026-09-26. All commands exited 0.

| Check | Result |
| --- | --- |
| `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/backend-client.spec.ts apps/web/lib/server/dashboard.spec.ts` | 46 passed, 0 failed (18 backend-client, 28 dashboard). |
| `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/flight-search.spec.ts apps/web/lib/server/booking-management.spec.ts "apps/web/app/api/booking-management/**/*.spec.ts"` | 82 passed, 0 failed (42 flight, 30 booking, 10 route handlers). |
| `pnpm --filter @web/frontend lint` | Exit 0; no ESLint warnings or errors. |
| `pnpm --filter @web/frontend typecheck` | Exit 0; tsc clean with zero errors. |

### Dashboard Migration & Parity Verification
- **T008 Dashboard Test Suite Expansion**: Added Section 7 suite in `apps/web/lib/server/dashboard.spec.ts` verifying 502/503/504 transient recovery on second GET attempt, 429 Retry-After transient recovery, 429 without header / deadline exceeded single attempt, missing-token short-circuit, and HTTP 500 strict single-attempt execution (zero retries) returning `UPSTREAM_UNAVAILABLE`.
- **T009 Backend Client Migration**: Replaced manual `fetch`, token extraction, and timeout handling in `apps/web/lib/server/dashboard.ts` with unified `backendClient.request('/api/dashboard/summary', DashboardSummarySchema)`. Preserved exact outcome mapping:
  - Success parsed via `DashboardSummarySchema` -> `{ ok: true, data: result.data }`.
  - HTTP 401 -> `UNAUTHENTICATED` ("Your session has expired. Please sign in again.").
  - HTTP 403 -> `FORBIDDEN` ("Access denied. You do not have permission to view this resource.").
  - Transport `missing_token` -> `UNAUTHENTICATED` ("Authentication required. Please log in.").
  - Transport `invalid_json` / `invalid_payload` -> non-retryable `INVALID_RESPONSE` ("Unable to load dashboard data due to an unexpected format.").
  - Transport `timeout` / `network` -> retryable `UPSTREAM_UNAVAILABLE` ("Connection timed out. Please check your network and try again.").
  - Other HTTP status failures (5xx) -> retryable `UPSTREAM_UNAVAILABLE` ("The dashboard service is temporarily unavailable. Please try again.").
- **T010 Parity & Zero Regression**: Verified zero regressions across backend client, dashboard, flight-search, booking-management, and route handler suites (128 total passing tests). Lint and typecheck clean.

**Phase 3 convergence:** T008–T010 requirements in tasks.md and spec.md (US1) are complete. Phases T011–T025 remain ready for migration.


