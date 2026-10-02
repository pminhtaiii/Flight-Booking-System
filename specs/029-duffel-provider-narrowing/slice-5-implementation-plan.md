# Slice 5 implementation plan

Approved design: 2026-10-02. Scope: T042–T043 only. Review baseline: `62f1e286e4aea755b3afeed356f287a5118893cd`.

## T042 — Decommission the monolith

1. Inspect all monolith callers and compare legacy behavior coverage with supplier capability suites. Preserve order creation, ancillary cache/freshness, missing-map fallback, budget denial, compensation, and privacy assertions.
2. Add one regression to the existing search adapter suite proving the injected `DUFFEL_SDK` handles searches even when an unrelated legacy provider exists. Run the focused case and record RED before removing the legacy fallback.
3. Remove the `DuffelService` constructor dependency and private SDK access in `duffel-search.adapter.ts`; use the injected SDK directly. No port signatures change.
4. Remove `DuffelModule` import/registration from `app.module.ts`. Delete the five files named in GOAL.md. Keep `duffel.types.ts` and `cancellation-confirmation.ts`.
5. Migrate the manual-order characterization in `duffel-order.adapter.spec.ts` to `DuffelOrderAdapter` with its existing SDK configuration token. Preserve request-body, idempotency, headers, and budget assertions. Remove obsolete legacy module/cleanup assertions explicitly authorized by GOAL.md. Migrate the additional supplier ancillary suite from `DuffelService` to the real ancillary adapter/service/normalizer using Nest testing injection and external boundary doubles; preserve every assertion.
6. Run focused tests, compiler, and API lint. Mark T042 complete only after all pass. Have one independent task reviewer check coverage and boundaries; resolve blocking findings. Commit T042.

Consumed interfaces: `DUFFEL_SDK`, `DUFFEL_SDK_CONFIGURATION`, existing budget/cache providers. Produced interfaces: unchanged supplier search/order/ancillary capabilities; no monolith runtime dependency.

Commands:

```powershell
pnpm --filter @api/backend exec jest --runInBand src/supplier
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
pnpm --filter @api/backend lint
rg -n '\b(DuffelService|DuffelModule|DuffelCleanupService)\b' apps/api/src
```

The reference audit distinguishes stale test labels from runtime imports and the retained `DuffelServiceLine` wire type. No broad renaming belongs to this slice.

## T043 — Verify the Phase 5 checkpoint

1. Run quickstart Section 3 and all supplier capability suites. Verify module exports expose the existing ports/concrete lifecycle services while SDK/core providers stay internal to supplier modules.
2. Run the change-aware API local gate: API/shared lint, shared tests, compiler, full API suite with network guard, and static CI contracts. Run existing order/consumer E2E suites using the established disposable test database setup; do not create migrations or change schemas.
3. Record exact commands, exit codes, suite/test counts, boundary results, and any limitations in `slice-5-verification.md`. Mark T043 complete only when its checkpoint passes. Update relevant context status and topology for the removed monolith. Have one independent reviewer verify T043 evidence; commit T043.

Commands:

```powershell
pnpm --filter @api/backend exec jest --runInBand src/supplier/order src/payment-fulfillment src/cancellation src/booking-lifecycle src/disruption
pnpm --filter @shared/types test
node --test tests/ci/ci-workflow.contract.test.mjs
$env:NODE_OPTIONS = "--require=$PWD/tests/ci/node-network-guard.cjs"
pnpm --filter @api/backend run test:ci
```

## Completion gates

Run scoped `speckit-converge` for T042–T043; Phases 6–7 remain pending. Run `code-review` with independent Standards and Spec agents on `git diff 62f1e286e4aea755b3afeed356f287a5118893cd...HEAD`. Resolve blocking findings, then push/update the existing draft PR and run CI convergence. Never weaken tests or retry the same persistent failure more than once.

Self-review: exact scope and files defined; interfaces unchanged; no placeholders; checks cover behavior and boundaries; task commits remain separate.
