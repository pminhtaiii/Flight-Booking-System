# Feature 029 — Phase 5 Slice 5 verification

Date: 2026-10-03. Scope: T043 checkpoint and scoped T042–T043 / US3 convergence. Approved slice design date: 2026-10-02. Verification baseline: `62f1e286e4aea755b3afeed356f287a5118893cd`. T042 implementation commit: `e1b4f48a`. T058 boundary fix commit: `3f6f88ea`.

## Status

T043's local verification gates pass, including the provider-visibility requirement closed by T058. The independent T058 source/test review and final T043 evidence/context review both returned GO with zero findings. No remote CI result is claimed.

## Verification gates

| Gate | Command / scope | Result |
| --- | --- | --- |
| Shared contracts | `pnpm --filter @shared/types test` | **PASS**, exit 0; 23 suites, 110 tests, 0 failed. The initial sandbox attempt exited 1 before assertions because Node could not spawn test workers (`spawn EPERM`); rerunning with approved process escalation passed. Shared code was unchanged after this run. |
| Static CI contract | `node --test tests/ci/ci-workflow.contract.test.mjs` | **PASS**, exit 0; 23 tests, 0 failed. The initial sandbox attempt hit the same pre-test `spawn EPERM`; rerunning with approved process escalation passed. CI contract files were unchanged after this run. |
| T042 supplier suites | `pnpm --filter @api/backend exec jest --runInBand src/supplier/core src/supplier/search src/supplier/ancillary src/supplier/order` | **PASS**, exit 0; 18 suites, 328 tests, before T058. |
| T042 module composition/readiness | `pnpm --filter @api/backend exec jest --runInBand src/app.module.spec.ts src/booking-intent/booking-readiness.service.spec.ts src/ancillaries/ancillaries.module.spec.ts` | **PASS**, exit 0; 3 suites, 42 tests, before T058. |
| T043 order checkpoint | `pnpm --filter @api/backend exec jest --runInBand src/supplier/order src/payment-fulfillment src/cancellation src/booking-lifecycle src/disruption` | **PASS**, exit 0; 25 suites, 500 tests, before T058. The post-T058 guarded full API run passed this scope too. |
| T043 ancillary checkpoint | `pnpm --filter @api/backend exec jest --runInBand src/supplier/ancillary src/ancillaries src/payment/ancillary-payment-validation.service.spec.ts` | **PASS**, exit 0; 11 suites, 153 tests, before T058. The post-T058 guarded full API run passed this scope too. |
| T058 boundary regression | `pnpm --filter @api/backend exec jest --runInBand src/supplier/core/duffel-core.module.spec.ts -t 'does not expose DUFFEL_SDK to an unrelated module'` | **PASS after T058**, exit 0; 1 selected test passed, 10 skipped. Against the pre-fix `@Global()` module it was a genuine RED: `.rejects.toThrow(/DUFFEL_SDK/)` received a resolved `TestingModule`; after removing `@Global()` it passed. |
| T058 capability module specs | Core plus search, ancillary, order, and AppModule composition specs | **PASS**, 5 suites, 30 tests. |
| API TypeScript | `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` | **PASS after T058**, exit 0. |
| API lint | `pnpm --filter @api/backend lint` | **PASS after T058**, exit 0. |
| API/shared ESLint | `pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0` | **PASS**, exit 0; no warnings or errors. Shared files were unchanged after this run. |
| Full API with network guard | Set `NODE_OPTIONS` to require `tests/ci/node-network-guard.cjs`, then `pnpm --filter @api/backend run test:ci` | **PASS after T058**, exit 0; 130 suites, 2,326 tests, 0 failed. This is a local run, not remote CI. |
| Core-provider privacy boundary | Inspect `apps/api/src/supplier/core/duffel-core.module.ts`, capability imports, and the negative composition test against plan/contract | **PASS after T058**: the core module is not global; search, ancillary, and order modules explicitly import it; an unrelated module cannot resolve `DUFFEL_SDK`. |

The initial sandbox process restriction affected only Node worker launches for shared/static tests. The same commands passed after approved process escalation; there was no test assertion failure.

## Database-backed E2Es

All post-T058 E2Es used the existing disposable `feature029_slice2_test` database and the repository network guard. The database was not reset, migrated, or reseeded. The test access token was set through the test environment; secret environment contents were not read or printed.

| Fresh post-T058 command scope | Result |
| --- | --- |
| `pnpm --filter @api/backend test:e2e -- test/supplier-order-module.e2e-spec.ts test/supplier-order-services.e2e-spec.ts test/supplier-ancillary.e2e-spec.ts test/module-deepening.e2e-spec.ts test/characterization/booking-characterization.e2e-spec.ts test/flights-analytics.e2e-spec.ts test/flights-cleanup.e2e-spec.ts` | **PASS**, exit 0; 7 suites, 52 tests. |
| `pnpm --filter @api/backend test:e2e -- test/cancellation.e2e-spec.ts test/booking.e2e-spec.ts test/payment-fulfillment-safety.e2e-spec.ts test/disruption.e2e-spec.ts test/disruption-phase3.e2e-spec.ts test/payment-fulfillment.e2e-spec.ts test/payment-idempotency.e2e-spec.ts test/booking-passenger-final-validation.e2e-spec.ts test/booking-events.e2e-spec.ts` | **PASS**, exit 0; 9 suites, 93 tests. |

Fresh total: **16 suites, 145 tests passed**. An earlier pre-T058 attempt omitted `DUFFEL_ACCESS_TOKEN`: six suites / 51 tests passed, while the ancillary E2E failed before assertions. Rerunning it with the test token passed 1/1. The post-T058 batches above reran all affected E2Es with the required test environment set.

## T042 and T058 regression/parity evidence

- Search SDK-selection regression: `pnpm --filter @api/backend exec jest --runInBand src/supplier/search/duffel-search.adapter.spec.ts -t 'uses the injected SDK when a legacy provider also has an SDK client'` produced a genuine baseline RED (the injected SDK expected one offer-request call but received zero because the old fallback selected the legacy SDK), then passed on the final adapter (1 passed, 31 skipped). Temporary baseline files were removed.
- Ancillary adapter migration: the focused suite first exposed 3 failures out of 16. `getCatalogData` now reserves both catalog attempts sequentially before parallel I/O; the corrected implementation passed 16/16. A capability assertion conflicted with immutable legacy behavior on second-reservation denial; the human approved correcting the expected SDK-call count to zero, and the updated test documents the decision.
- Independent T042 review initially reported one P2 because the SDK regression test's decoy provider used the wrong token. The setup was changed to the actual third constructor metadata token, proved RED against the temporary baseline, and the independent re-review reported zero remaining findings.
- T058's negative composition test was run RED against the old global module and GREEN after the fix (1 selected pass, 10 skipped). The T058 implementer also passed the core and three capability-module composition checks (5 suites / 30 tests), API typecheck, API package lint, and `git diff --check`; the independent source/test review reported zero findings.

## Reference census

`rg -n --glob '*.ts' '\b(DuffelService|DuffelModule|DuffelCleanupService)\b' apps/api/src apps/api/test` found no runtime imports or references to the deleted classes. Remaining hits are negative absence assertions/test labels in `test/module-deepening.e2e-spec.ts` and `src/ancillaries/ancillaries.module.spec.ts`. `DuffelServiceLine` remains only as its declaration/use in `src/duffel/duffel.types.ts`, the compatibility wire type explicitly retained by GOAL.md. `rg -n '@Global' apps/api/src/supplier` returned no matches; `DuffelCoreModule` is imported only by `SupplierSearchModule`, `SupplierAncillaryModule`, and `SupplierOrderModule`.

## Scoped convergence

The `.specify/scripts/powershell/check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks` prerequisite succeeded for Feature 029; `.specify/extensions.yml` has no `before_converge` or `after_converge` hooks.

The initial scoped T042–T043 / US3 assessment found one HIGH `contradicts` issue: `@Global()` violated the plan Structure Decision and supplier-boundaries contract, which require explicit supplier-module imports. T058 was appended with exact source/spec references and the dependency that it gates T043 and must finish before US4 T044–T054. T058 is now implemented and checked. **✅ Converged for the scoped T042–T043 / US3 checkpoint**: the post-fix recheck found zero remaining findings. It checked the three US3 acceptance scenarios, one plan structure decision, the supplier-boundaries module-import rule, and all five constitution principles relevant to this scope (no constitution findings). The order lifecycle/compensation tests pass, the three capability modules explicitly import a non-global core, the unrelated-module regression passes, and the local T043 gates pass. No additional convergence task was appended on the recheck; T058 is the only convergence item. Phases 6–7 remain pending.
