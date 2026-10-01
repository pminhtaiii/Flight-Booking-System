# Phase 4 Slice 3 implementation plan

Approved design: 2026-10-01. Scope: T030 and T031 only. Review baseline: `8f90b3834f86b94a5799c74366395a37d2292836`.

## T030 — Consumer rewiring

1. Read the ancillary capability, consumer suites, and module dependency graph. Preserve catalog fingerprints, lease lifecycle, service identity checks, currency checks, and decimal totals.
2. RED: migrate the ancillary module spec's provider override to `DuffelAncillaryService`; add assertions that both consumer modules import `SupplierAncillaryModule` and no longer directly import `DuffelModule`. Run `pnpm --filter @api/backend exec jest --runInBand src/ancillaries/ancillaries.module.spec.ts` and confirm the old wiring fails.
3. GREEN: in `ancillary-catalog.service.ts`, inject `DuffelAncillaryService` as `ancillaryService` and delegate `getCatalog(offerId, refresh)` to `getSeatMapsAndServices(offerId, refresh)`. In `ancillaries.module.ts`, replace `DuffelModule` with `SupplierAncillaryModule`. Preserve the fingerprint implementation.
4. RED: migrate payment validation tests to the new ancillary capability boundary without weakening assertions; confirm the old constructor dependency or module wiring fails. For tests that exercise supplier identity validation, build the existing real ancillary service/adapter/normalizer with SDK and cache boundary doubles instead of the monolith.
5. GREEN: in `ancillary-payment-validation.service.ts`, inject `DuffelAncillaryService` as `ancillaryService`, update the repricing return type, and delegate `repriceOffer(offerId, services)` unchanged. In `payment.module.ts`, replace its direct `DuffelModule` import with `SupplierAncillaryModule`. Migrate auxiliary payment validation conflict, expiry-race, and stale-CAS spec types where required by compilation.
6. Run `pnpm --filter @api/backend exec jest --runInBand src/supplier/ancillary src/ancillaries src/payment/ancillary-payment-validation` and `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`. Run relevant transactional E2E coverage against mocked external boundaries. No new dependency or production behavior change.
7. Review T030 using one review subagent. Mark T030 complete only after passing checks. Commit explicitly scoped files with `refactor(ancillary): rewire consumers to supplier capability`.

## T031 — Phase 4 checkpoint

1. Run the exact quickstart checkpoint: `pnpm --filter @api/backend exec jest --runInBand src/supplier/ancillary src/ancillaries src/payment/ancillary-payment-validation.service.spec.ts`.
2. Run `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`.
3. Verify no `DuffelService` or `DuffelModule` references remain in `apps/api/src/ancillaries` or the production ancillary payment validation service; inspect direct PaymentModule imports. Verify no new `any` or unjustified type assertions.
4. Record command exit codes and suite/test totals in feature verification documentation. Update relevant context documentation while preserving existing user edits. Mark T031 complete only after passing gates.
5. Review T031 using one review subagent. Commit explicitly scoped checkpoint documentation with `docs(ancillary): record Phase 4 checkpoint`.

## Final gates

Assess this slice against spec, plan, and tasks using speckit-converge. Run code-review Standards and Spec axes in parallel against the baseline above. Resolve blocking findings with TDD and scoped commits. Run the change-aware API pre-PR gate, push/update the branch PR, and inspect remote CI according to the workflow. Stop if the same failure persists after one corrective attempt.

Self-review: exact paths and commands supplied; interfaces remain `getSeatMapsAndServices(string, boolean)` and `repriceOffer(string, services)`; no placeholders; T030 precedes T031; unrelated existing documentation changes are excluded from task commits unless intentionally merged with slice updates.
