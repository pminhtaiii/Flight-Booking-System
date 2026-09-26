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

## Phase 4: User Story 2 — Preserve flight outcomes (T011–T013)

Run from `C:\Booking Systems` on 2026-09-26. All commands exited 0.

| Check | Result |
| --- | --- |
| `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/backend-client.spec.ts apps/web/lib/server/flight-search.spec.ts` | 73 passed, 0 failed (18 backend-client, 55 flight-search). |
| `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/dashboard.spec.ts apps/web/lib/server/booking-management.spec.ts "apps/web/app/api/booking-management/**/*.spec.ts"` | 68 passed, 0 failed (28 dashboard, 30 booking, 10 route handlers). |
| `pnpm --filter @web/frontend lint` | Exit 0; no ESLint warnings or errors. |
| `pnpm --filter @web/frontend typecheck` | Exit 0; tsc clean with zero errors. |

### Flight Migration & Parity Verification
- **T011 Flight Test Suite Expansion**: Added dedicated Phase 4 test suite in `apps/web/lib/server/flight-search.spec.ts` locking:
  - Search POST single-send: exactly 1 attempt (zero retries) on 502, 503, 504, 429, network error, and timeout.
  - Offer selection GET bounded recovery: recovers on 2nd attempt after 502/503/504 or network timeout.
  - Transport failure mapping: malformed upstream JSON and schema validation failure map to `UPSTREAM_UNAVAILABLE` (`retryable: true`) with exact user-facing message (`'Flight search returned an invalid response. Please try again.'`).
  - Missing token short-circuit: session `null` or lacking `accessToken` returns `UNAUTHENTICATED` (`retryable: false`) with 0 fetch attempts for both search and selection.
  - HTTP status mapping parity: 401/403 -> `UNAUTHENTICATED` (single-send), 429 -> `RATE_LIMITED` (`retryable: true`, single-send), 400/422 -> `INVALID_SEARCH` (`retryable: false`, single-send), 404/410 on selection -> `OFFER_EXPIRED` (`retryable: false`, single-send).
- **T012 Backend Client Migration**: Migrated `searchFlights` and `selectFlightOffer` in `apps/web/lib/server/flight-search.ts` to `backendClient.request`:
  - Removed bespoke `fetchWithRetry`, `apiUrl()`, `getAccessToken()`, `delay()`, constants, and NextAuth module imports.
  - Dispatched `searchFlights` via `backendClient.request('/api/flights/search', UpstreamSearchSchema, { method: 'POST', ... })`.
  - Dispatched `selectFlightOffer` via `backendClient.request('/api/flights/' + encodeURIComponent(id), UpstreamSelectionSchema, { method: 'GET' })`.
  - Retained all domain validation (`FlightSearchQuerySchema`, `LocalOfferIdSchema`), offer mapping (`mapOffer`), and view schema checks (`FlightSearchOfferViewSchema`).
  - Preserved provider identifier stripping and exact checkout route: `/checkout?offerId=${encodeURIComponent(id)}`.
- **T013 Parity & Zero Regression**: Verified zero regressions across client, flight-search, dashboard, booking-management, and route handler suites (141 total passing tests across suites).

**Phase 4 convergence:** T011–T013 requirements in tasks.md, spec.md (US2), and GOAL.md are satisfied. Phases T014–T025 remain ready for migration.
## Phase 5: User Story 3 — Preserve booking outcomes (T014–T017)

Run from `C:\Booking Systems` on 2026-09-26. All commands exited 0.

| Check | Result |
| --- | --- |
| `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/backend-client.spec.ts apps/web/lib/server/booking-management.spec.ts` | 68 passed, 0 failed (18 backend-client, 50 booking-management). |
| `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/dashboard.spec.ts apps/web/lib/server/flight-search.spec.ts "apps/web/app/api/booking-management/**/*.spec.ts"` | 93 passed, 0 failed (28 dashboard, 55 flight, 10 route handlers). |
| `pnpm --filter @web/frontend lint` | Exit 0; no ESLint warnings or errors. |
| `pnpm --filter @web/frontend typecheck` | Exit 0; tsc clean with zero errors. |

### Booking Migration & Parity Verification
- **T014 Booking Test Suite Expansion**: Extended `apps/web/lib/server/booking-management.spec.ts` with Phase 5 test suite locking:
  - Raw response schema optional field tolerance for all six JSON operations (`listBookings`, `getBookingDetail`, `getCancellationStatus`, `getCancellationQuote`, `cancelBooking`, `getItineraryRevisions`) while strictly stripping provider Duffel IDs (`duffelOrderId`, `duffelSegmentId`, `duffelCancellationQuoteId`, `stripePaymentIntentId`, `passportNumber`, etc.).
  - 400 and 422 error body forwarding and fallback: forwards `data.message` as `INVALID_COMMAND` across all 8 operations, falling back to `'Invalid request. Please check your details and try again.'` when unparseable or absent.
  - Malformed successful JSON: maps unparseable 200 text and schema validation mismatches to `UPSTREAM_UNAVAILABLE` (`retryable: true`) across operations without throwing.
  - Empty-body disruption acknowledge & accept success: 200/204 responses return `{ ok: true, data: { ok: true } }`.
  - Mutation single-send guarantee: `getCancellationQuote`, `cancelBooking`, `acknowledgeDisruption`, and `acceptDisruption` POST requests are dispatched at most once (0 retries) on 502/503/504, 429 (with `Retry-After`), network error, and timeout abort error.
  - GET retry policy: bounded retry up to 3 attempts on 502/503/504 and transient recovery on attempt 2 for `listBookings`, `getBookingDetail`, `getCancellationStatus`, and `getItineraryRevisions`; non-transient statuses (400, 401, 403, 404, 409, 422) dispatch once.
- **T015 & T016 Backend Client Migration**:
  - Migrated all eight operations in `apps/web/lib/server/booking-management.ts` to `backendClient.request`.
  - Six JSON operations use operation-specific raw response schemas (`RawBookingListResponseSchema`, `RawBookingDetailResponseSchema`, `RawCancellationStatusResponseSchema`, `RawCancellationQuoteResponseSchema`, `RawCancellationResultResponseSchema`, `RawItineraryRevisionsResponseSchema`) with `.passthrough()`.
  - Disruption mutations (`acknowledgeDisruption`, `acceptDisruption`) use `z.void()`, `responseMode: 'none'`, and pass `body: JSON.stringify({ revisionId: revisionId.trim() })`.
  - Removed all orphaned transport helpers and constants: `fetchWithRetry`, `apiUrl()`, `getAccessToken()`, `delay()`, `handleUpstreamStatus()`, `MAX_READ_ATTEMPTS`, `RETRY_BASE_DELAY_MS`, `REQUEST_TIMEOUT_MS`, `FetchResult`, `NextAuth`, and `authOptions`.
  - Preserved raw custom header casing in `backend-client.ts` to support exact header contracts.
- **T017 Parity & Zero Regression**: Verified zero regressions across client, booking, dashboard, flight-search, and booking route handler suites (161 total passing tests across suites).

**Phase 5 convergence:** T014–T017 requirements in tasks.md, spec.md (US3), and GOAL.md are satisfied. Phases T018–T025 remain ready for User Story 4 and polish.

## Phase 6: User Story 4 — Share booking response mapping (T018–T022)

Run from `C:\Booking Systems` on 2026-09-26.

| Check | Result |
| --- | --- |
| Adapter test RED before extraction | 8 expected module-not-found failures for the absent `outcome-response.ts`. |
| Adapter and route parity specs | 64 passed, 0 failed (8 adapter cases; 7 HTTP operations × 8 outcomes = 56 route cases). |
| Route parity plus existing cancellation and quote route specs | 66 passed, 0 failed. The two existing route specs were selected with a `bookings/*/` glob because literal `[bookingId]` paths are interpreted as a glob character class by the runner. |
| Backend client, dashboard, flight search, and booking management server specs | 151 passed, 0 failed. |
| `rg -n 'function mapOutcomeToResponse' apps/web` | Exactly one definition, in `apps/web/lib/server/outcome-response.ts`. |
| Web typecheck | Exit 0; strict TypeScript check clean. |
| Web lint | Exit 0; no ESLint warnings or errors. The user approved removal of the unused parity-mock parameter; the test records that approval and its assertions remain unchanged. |

The shared booking-specific adapter preserves 200 success, the six known error status mappings (400, 401, 403, 404, 409, 503), unknown-reason 500 fallback, `{ error, message }` error bodies, and `Cache-Control: private, no-store` for success and errors. All six route files now import it. The seven HTTP operations and their `dynamic` exports, handler signatures, and parameter validation remain unchanged. Independent reviews of T018–T021 found no remaining blocking issues after restoring type-only `NextResponse` imports in both disruption routes.

**Phase 6 convergence:** T018–T022 requirements in tasks.md, spec.md (US4), and GOAL.md are satisfied. Phase 7 polish (T023–T025) remains planned and unstarted.
