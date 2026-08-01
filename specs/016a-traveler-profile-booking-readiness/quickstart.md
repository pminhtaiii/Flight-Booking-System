# Quickstart Validation: Traveler Profile & Booking Readiness

## Prerequisites

- PostgreSQL and Redis running from `docker compose up -d`
- Test environment variables from existing API, web, and agent test setup
- Matching `JWT_SECRET`, `AGENT_SERVICE_API_KEY`, and `CLAIM_TOKEN_SECRET`
- A seeded user, domestic offer, international offer, and airport country data

## Focused validation sequence

1. Apply the feature migration and seed profiles representing empty, domestic-ready, international-ready, expired, and near-expiry documents.
2. Run profile unit/integration tests; verify owner-only round trip, revision conflicts, atomic document update, dual-write/backfill rollback safety, masking, no-store headers, and PII-safe audit metadata.
3. Run evaluator tests; verify domestic, every-segment international detection, missing airport country, expired document, advisory warning, and optional middle name.
4. Run booking-intent tests; verify profile/inline source resolution, expected-profile revision, cross-user rejection, zero writes on failure, AAD-bound immutable snapshots, masked reads, and the route/response compatibility matrix.
5. Run agent tests; verify the gateway/tool/SSE allowlists reject injected PII fields and emit only ordinal/type/status metadata.
6. Run browser E2E: incomplete profile → secure correction → ready → intent → `/checkout/[intentId]/ancillaries`; then verify inline/multi-passenger chat handoff.
7. Run final-order tests with expired, corrupted, cross-record-swapped, concurrent, and lease-lost snapshots; assert Duffel is called only once by the existing claim owner or not called.
8. Run the warmed local performance profile and verify readiness p95 <300 ms and profile p95 <500 ms across 100 requests.
9. Verify dashboard/alert/runbook contracts, trace propagation, required structured fields, metric increments, and a negative PII corpus across logs/audits/traces.

## Commands

From the repository root:

```powershell
pnpm --filter @shared/types build
pnpm --filter @api/backend test -- booking-readiness.evaluator.spec.ts --runInBand
pnpm --filter @api/backend test -- booking-intent.service.spec.ts --runInBand
npm run test:e2e --workspace=apps/api
npm run test:e2e --workspace=apps/api -- booking-readiness.performance.e2e-spec.ts
npx playwright test --config=apps/web/tests/playwright.config.ts
pnpm --filter @api/backend build
pnpm --filter @web/frontend typecheck
pnpm --filter @web/frontend build
```

From `apps/agent/`:

```powershell
uv run pytest tests/test_tools.py tests/test_nestjs_client.py tests/test_sse_integration.py
```

## Expected outcomes

- Advisory and authoritative checks agree for identical inputs.
- Every rejected authoritative request leaves intent/passenger counts unchanged.
- Profile edits after intent creation do not alter the snapshot.
- No profile values appear in agent-gateway responses, SSE, logs, audit metadata, traces, URLs, route state, local/session storage, cacheable responses, or errors.
- Invalid final passenger data prevents any Duffel order call.
- Concurrent final submissions converge through the existing idempotency owner and produce at most one supplier call.
- Existing singular intent callers continue working during migration; all new first-party calls use plural routes and both GET paths return the same safe response after client cutover.

See [API contracts](contracts/api.md) and [data model](data-model.md) for exact shapes and migration rules.
