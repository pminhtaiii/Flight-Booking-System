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

