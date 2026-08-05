# Quickstart Validation: Disruption & Flight-Change Management

This guide validates the feature end to end after implementation. It does not contain implementation code.

## Prerequisites

1. Node.js 20+ and pnpm 9+.
2. Docker Desktop with project PostgreSQL and Redis running.
3. Existing API/web environment files configured.
4. Feature 14 configuration present with no secret committed:
   - `DUFFEL_WEBHOOK_SECRET`
   - ingestion/processor/reconciliation/customer-surfacing/outbox feature flags
   - webhook replay tolerance and raw-payload retention settings
5. Test mode Duffel webhook registered for `order.airline_initiated_change_detected` when performing a real-provider smoke test.

## Install and database preparation

```powershell
pnpm install --frozen-lockfile
docker compose up -d
pnpm --filter @api/backend exec prisma migrate dev
pnpm --filter @api/backend exec prisma generate
```

Before enabling execution flags, run the Feature 14 data-quality/bootstrap report and verify:

- no duplicate non-null Duffel order ID blocks the unique constraint;
- every eligible booking has a usable original snapshot and current/next/final timing;
- excluded bookings appear in the admin data-quality result;
- bootstrap notification/outbox creation is disabled.

## Static and migration verification

```powershell
pnpm --filter @shared/types build
pnpm --filter @api/backend build
pnpm --filter @web/frontend typecheck
pnpm lint
```

Validate the migration from a database shaped like the completed cancellation/refund feature, including legacy snapshot JSON without segment IDs. Do not validate only against an empty database.

## Focused automated tests

### Pure matcher/classifier and service tests

```powershell
pnpm --filter @api/backend test -- disruption
```

Expected coverage:

- exact segment ID, flight/date/origin, route/time, ambiguity, and one-to-one matching;
- exactly 60/120-minute boundaries, exact MCT, date/overnight, DST, invalid connection, and multi-slice behavior;
- incremental and cumulative material baselines;
- fingerprint A→B→A behavior;
- owned booking/inbox lease acquisition and release;
- outbox decisions 1/2/3/4 around a UTC boundary.

### API E2E

```powershell
pnpm run test:e2e --workspace=apps/api -- disruption.e2e-spec.ts
```

The E2E harness must stop registered cron jobs and invoke public handlers directly. Expected scenarios:

1. Signed webhook inserts before fast 200; invalid/stale signatures insert nothing.
2. Verified duplicate and unsupported events converge correctly.
3. Unchanged supplier payload updates coverage without revision.
4. Material/non-material/cumulative changes commit correct revision, segments, status, audit, and outbox atomically.
5. Concurrent webhook and reconciliation produce one canonical version.
6. Crash/stale leases recover; fifth inbox failure escalates.
7. Owner actions, other-owner denial, active-revision idempotency, and stale 409 work.
8. Supplier-confirmed cancellation resolves disruption and wins a synchronization race.
9. Reconciliation chooses at most 20 fair eligible records, includes return legs, and yields on budget denial.
10. Admin monitoring, retry, manual resolution, and data-quality endpoints enforce ADMIN.

Run the full backend suite afterward:

```powershell
pnpm run test:e2e --workspace=apps/api
```

### Frontend Playwright

First verify the plan’s frontend-foundation gate produced the required Playwright configuration and protected booking pages. Then run:

```powershell
npx playwright test --config=apps/web/tests/playwright.config.ts
```

Expected journeys:

- current versus original itinerary and detected banner;
- acknowledge, accept, and stale-revision refresh;
- newer material revision resets the view;
- minor revision appears only in history;
- cancellation action remains available and its success resolves the alert;
- cross-user booking URL leaks no data;
- regular user denied admin surface;
- admin failed-event retry/manual resolution;
- keyboard/focus/alert behavior and 375 px layout.

## Manual local smoke test

1. Start the stack using the commands in the project `AGENTS.md`.
2. Keep all execution flags off and verify migrations/read compatibility.
3. Enable ingestion only and send a Duffel test ping/change fixture; verify durable inbox acknowledgement.
4. Enable the processor for a test booking and verify the booking page shows the current revision with no raw supplier data.
5. Replay the identical event and verify revision/outbox counts remain unchanged.
6. Process two sub-threshold earlier moves that cumulatively exceed 60 minutes; verify the second revision becomes material due to `CUMULATIVE`.
7. Acknowledge then accept; verify no Duffel request occurs and audit metadata is present.
8. Create a newer material revision and submit the old revision action; verify HTTP 409 and UI refresh.
9. Race synchronization with supplier-first cancellation; verify cancellation leaves `RESOLVED/BOOKING_CANCELLED` and no later outbox.
10. Exceed three material revisions in one UTC day; verify third warning, fourth suppression, attention flag, and continued history.

## Observability acceptance

Verify dashboards/alerts expose:

- webhook accepted/invalid/duplicate and acknowledgement p95;
- inbox depth, oldest age, retries, terminal failures, and processor heartbeat;
- sync latency/result, Duffel calls, lock contention/stale takeover, and reconciliation backlog/coverage;
- revision/material reason counts, outbox written/suppressed, active disruption age, and attention flags;
- trace/correlation linkage without raw payload or PII.

Trigger one controlled terminal inbox failure and confirm the alert and admin row arrive within the configured SLO.

## Rollout and rollback validation

Enable in order:

1. additive schema/dormant readers;
2. webhook ingestion;
3. canary inbox processor;
4. bootstrap/reporting with customer/outbox disabled;
5. reconciliation;
6. customer and admin UI;
7. outbox creation.

Rollback disables Duffel delivery or ingestion, processor, reconciliation, outbox, and UI flags in that order. Preserve inbox/revision/audit rows. Re-enable processing only after confirming queued events will be revalidated against current supplier and booking state.

## Success checklist

- [ ] Valid webhook durable acknowledgement p95 <500 ms.
- [ ] Processed material change visible p95 <2 minutes.
- [ ] Missed eligible event caught within 35 minutes when budget is available.
- [ ] Identical/concurrent inputs produce one revision and at most one outbox row.
- [ ] No post-cancellation revision/outbox/state mutation.
- [ ] Booking detail/history make zero supplier calls and meet local-read p95 target.
- [ ] Terminal failures, throttle flags, and data gaps are fully visible to ADMIN.
- [ ] Logs and APIs contain no raw payload/passenger/payment PII.
- [ ] Full existing test suites remain green.
