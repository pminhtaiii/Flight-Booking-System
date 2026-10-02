# Feature 029 — Phase 5 Slice 4 verification

Date: 2026-10-02. Scope: GOAL.md T040/T041 only. T042–T057 remain pending.

## Plan and task commits

- Baseline: `06756d2ef8952ba8caf534cd9a60378bf9e56b52`.
- `c5ae9445`: approved design and reviewed TDD implementation plan.
- `a832f128` (T041): safely defer stale recovery; use upstream retry metadata; require cancellation proof, including the human-approved fixture corrections.
- `02c67bee` (T040): safely read top-level/nested order IDs; retain recoverable inline/background compensation state on missing or unconfirmed cancellation evidence.

Each implementation task uses one GPT-6 Luna Max implementer and one independent task reviewer. Existing assertions remain intact. The human approved correcting two replay fixtures to supply explicit CANCELLED evidence instead of a bare error; regression coverage is additive.

## Verification evidence

| Gate | Result |
| --- | --- |
| Pre-change saga/recovery baseline | 2 suites / 102 tests passed |
| T040 full saga spec | 67 tests passed |
| T040 API no-emit TypeScript | Passed |
| T040 API package lint | Passed |
| T040 diff check | Passed |
| Shared build/contracts | 110 tests passed |
| Static CI workflow contracts | 23 tests passed |
| T041 recovery spec | 55 tests passed |
| Payment fulfillment safety E2E | 2 tests passed |
| Full API network-guard unit suite | 132 suites / 2,404 tests passed |
| API/shared lint with zero warnings | Passed |
| T041 API no-emit TypeScript and package lint | Passed |
| Transactional fulfillment / idempotency / booking events E2E | 3 suites / 52 tests passed |
| Passenger final-validation E2E | 1 suite / 7 tests passed |

Initial sandbox process restrictions prevented Node test-runner child processes. Running the same shared/static checks with the required permissions passed without changing tests. Expected Nest logs in deliberate negative-path cases remain visible. The initial transactional filename pattern omitted booking-passenger-final-validation; the correctly named suite then passed independently (7 tests). A Windows backslash in NODE_OPTIONS prevented an initial E2E launch before tests; the forward-slash preload path corrected it without source changes. All database-backed gates used the existing disposable feature029_slice2_test database.

T040 RED evidence reproduced nested inline evidence falling through to `AWAITING_PAYMENT`/hold release and nested background evidence never invoking cancellation. Regression cases now cover both ID shapes, missing/empty/malformed IDs, background budget-store denial and network errors; retained handoff cases cover rate-limit denial and pending cancellation.

## Review and convergence status

Both independent task reviews passed with zero findings. Integrated local validation and scoped convergence passed. Final Spec review found zero issues. Standards found one P3 annotation breach, fixed in ed24a4c0 and independently rechecked with zero open/new findings, plus one nonblocking duplicated-reader smell retained by ruling. Remote CI will be checked on the draft PR for the published HEAD. This record does not claim full-feature completion.

## Rulings

1. Continue in the clean existing feature checkout because this request continues the published feature branch. Cost if wrong: checkout relocation and commit transfer.
2. Pin final slice review to `06756d2e`, with current feature artifacts supplying integration context, because earlier slices were already reviewed. Cost if wrong: earlier defects may need broader follow-up review.
3. Use GOAL.md and the supplied feature spec directly instead of expanding into issue-tracker setup. Cost if wrong: tracker configuration remains absent for future issue-based skills.
4. Execute one implementer at a time, as required by subagent-driven-development. Cost if wrong: longer elapsed time.
5. Generate equivalent SDD artifacts with native PowerShell because Git Bash cannot create its signal pipe in this sandbox. Cost if wrong: artifact formatting drift; task headings and git diff validate the result.

6. Require explicit cancellation proof instead of already_cancelled error text, because the concrete cancellation capability throws when confirmation fails. Cost if wrong: a truly cancelled order is deferred until confirmation becomes available. Both affected replay-fixture corrections have explicit human approval.



## Archived implementation and task-review evidence


### task-1-report.md

# T040 Implementation Report

**Status:** DONE
**Commit:** `02c67bee` — `fix(api): retain saga state on unconfirmed cancellation (T040)`

## Changes

- Added `readOrderId(unknown)` with runtime narrowing for non-empty top-level `id` and nested `data.id` values.
- Inline capture compensation now returns a recoverable HTTP 502 with `bookingStatus: 'PROCESSING'` when an order-created event has no usable ID. It still stops before hold release, booking failure, or idempotency completion when cancellation is unconfirmed.
- Background compensation now logs and returns when an order-created event has no usable ID; nested IDs also feed the post-cancellation snapshot lookup. Existing ownership controls and `isCancellationConfirmed` remain in place.
- Added inline and background coverage for nested IDs with pending cancellation, missing/empty/malformed IDs, and background budget denial/network timeout. Existing handoff cases already cover rate-limit denial and pending cancellation.
- Checked only T040 in `specs/029-duffel-provider-narrowing/tasks.md`.

## RED/GREEN evidence

- **Inline nested ID, RED:** `pnpm --filter @api/backend exec jest --runInBand src/payment-fulfillment/payment-fulfillment.saga.spec.ts` exited 1 with `1 failed, 57 passed`. The new case received `bookingStatus: 'AWAITING_PAYMENT'` and the response claimed the order was cancelled and the hold released instead of retaining `PROCESSING`.
- **Inline nested ID, GREEN:** `pnpm --filter @api/backend exec jest --runInBand src/payment-fulfillment/payment-fulfillment.saga.spec.ts -t "nested order evidence cancellation is pending"` exited 0; 1 passed.
- **Background nested ID, RED:** `pnpm --filter @api/backend exec jest --runInBand src/payment-fulfillment/payment-fulfillment.saga.spec.ts -t "background cancellation uses nested order evidence and is pending"` exited 1; expected cancellation with `ord-nested`, but `cancelOrder` had zero calls.
- **Background nested ID, GREEN:** the same filtered command exited 0; 1 passed.
- **Inline missing and empty IDs, RED/GREEN:** each filtered case first reproduced the old `AWAITING_PAYMENT`/hold-released response, then passed after restoring the missing-ID guard. The filtered commands were `-t "inline order evidence has no usable ID"` and `-t "inline order evidence has an empty ID"`.
- **Remaining new cases, GREEN:** filtered runs passed for inline malformed ID; background missing, empty, and malformed IDs; background `BUDGET_UNAVAILABLE`; and background network timeout. Each command used the same Jest invocation with its test name as `-t`.

## Validation

- `pnpm --filter @api/backend exec jest --runInBand src/payment-fulfillment/payment-fulfillment.saga.spec.ts` — exit 0, **67/67 passed**. Expected Nest error logs came from injected failure paths.
- `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` — exit 0.
- `pnpm --filter @api/backend lint` — exit 0.
- `git diff --check` — exit 0.

## Self-review

The change preserves the public method signatures, invocation ownership fencing, event evidence, and retryable `duffel_order_created` checkpoint. New production code uses runtime narrowing and adds no type assertions, `any`, services, or dependencies. Only the saga source, saga spec, and T040 task checkbox are included in commit `02c67bee`; no outstanding concerns remain.


### task-1-review.md

### Spec Compliance

- ✅ T040 is compliant. `readOrderId(unknown)` narrows both top-level and nested IDs without adding assertions, and inline/background paths stop before hold release, booking failure, or key completion when cancellation is unconfirmed or an order ID is unusable (`apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts:47`, `:829`, `:1345`).
- The inline and background cases cover pending cancellation and malformed/missing IDs (`apps/api/src/payment-fulfillment/payment-fulfillment.saga.spec.ts:1260`, `:1288`, `:1968`, `:2004`). Inline missing-ID assertions check event creation and checkpoint advancement; background assertions check retained authorization and no cancellation event, terminal mutations, or key completion. Existing confirmed-cancellation coverage verifies cancellation followed by void/failure/finalization (`apps/api/src/payment-fulfillment/payment-fulfillment.saga.spec.ts:2121`).
- The packaged hunk ends inside `handleBackgroundError`; focused inspection of its remainder confirmed the no-order branch still falls through and the confirmed branch retains its existing compensation behavior (`apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts:1351`, `:1377`).

### Strengths

The change preserves invocation ownership control on cancellation, uses only the existing fulfillment/payment ports, and leaves the existing cancellation-confirmation predicate intact. The report records the full saga spec, TypeScript, and lint as passing; I did not rerun them.

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

None.

#### Minor (Nice to Have)

None.

### Assessment

**Task quality:** Approved

**Reasoning:** The implementation satisfies the requested recovery guard in both paths, handles nested and unusable IDs safely, and preserves confirmed and no-order compensation behavior. No scope, port-boundary, ownership, privacy, or new type-assertion issue was found.


### task-2-report.md

# T041 — Safe recovery deferral and retry timing

## Result

Implemented T041 in `BookingRecoveryService`. Stale recovery now accepts a nonempty top-level or nested order ID, defers created-order evidence with missing/empty/malformed IDs for 300 seconds, returns safely on payment-event lookup errors, and keeps cancellation failures non-destructive if writing the deferral key fails. Valid 429 `RATE_LIMIT_EXCEEDED` and `BUDGET_UNAVAILABLE` responses use positive integer retry seconds and a valid upstream `resetAt`; absent or invalid retry metadata and other errors use the 300-second fallback. A cancellation error message containing `already_cancelled` is no longer treated as proof. Only an explicit confirmed cancellation response records `duffel_order_cancelled`.

## TDD evidence

Each focused cycle used `pnpm --filter @api/backend exec jest --runInBand src/booking-lifecycle/booking-recovery.service.spec.ts --testNamePattern="<case>"`.

| Behavior | RED observation | GREEN result |
| --- | --- | --- |
| Nested `metadata.data.id` with pending cancellation | Cancellation was skipped and Stripe cancellation ran. | Nested ID reached cancellation; 300-second deferral preserved the booking and hold. |
| Created event with missing ID | Stripe cancellation ran. | Key `booking:recovery:defer:{bookingId}` was set with TTL 300; no cancel/fail. |
| Empty and malformed IDs | Existing missing-ID guard already covered these variants. | Each added case passed with TTL 300 and no cancel/fail. |
| Payment-event lookup rejection | Stripe cancellation ran after the catch logged the lookup failure. | Returning the current booking from the catch kept the hold and booking state. |
| `BUDGET_UNAVAILABLE` 429 with `retryAfterSeconds=60` and `resetAt=2026-10-02T01:01:00.000Z` | Used fallback `2026-10-02T01:05:00.000Z`, TTL 300. | Used upstream reset time, TTL 60. |
| `RATE_LIMIT_EXCEEDED` without reset time | Existing positive retry-metadata handling already computed the requested time. | At frozen time `2026-10-02T01:00:00.000Z`, used `2026-10-02T01:01:00.000Z`, TTL 60. |
| Invalid `retryAfterSeconds=0` | Existing validation already selected bounded fallback. | At frozen time `2026-10-02T01:00:00.000Z`, used `2026-10-02T01:05:00.000Z`, TTL 300. |
| Cache write failure after pending cancellation | Existing logged failure handling already returned without destructive compensation. | Rejection was logged; Stripe cancel and `failBooking` remained uncalled. |
| Bare `already_cancelled` error | Error text created a cancellation marker and Stripe cancellation ran. | Removed error-text confirmation; no marker, Stripe cancel, or booking failure; TTL 300. |
| Explicit already-cancelled provider evidence | Corrected fixture passed after returning `{ id: 'ord_123', status: 'CANCELLED' }`. | Existing marker and replay assertions remained intact. |

The two fixture corrections were explicitly approved on 2026-10-02 and carry comments beside the unit and E2E fixtures. Existing assertions were retained. Existing generic-error fallback, active-TTL skip, missing/expired-TTL retry, and confirmed-cancellation-before-release checks were reused.

## Final validation

- `pnpm --filter @api/backend exec jest --runInBand src/booking-lifecycle/booking-recovery.service.spec.ts` — exit 0; 1 suite, 55/55 tests passed.
- `pnpm --filter @api/backend test:e2e -- test/payment-fulfillment-safety.e2e-spec.ts` — exit 0; 1 suite, 2/2 tests passed. The E2E asserts the cancellation marker/provider confirmation precedes Stripe release and booking failure.
- `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` — exit 0.
- `pnpm --filter @api/backend lint` — exit 0.

## Self-review

- Preserved constructor injection, existing cache/cancellation services, and supplier module boundaries. Added no dependency or service.
- Added runtime narrowing for persisted order IDs; new code and tests contain no `any` or type assertions.
- A positive active TTL still skips recovery; a missing/expired key permits a safe recheck. Confirmed cancellation records the marker before release/failure. Unconfirmed cancellation, malformed order evidence, lookup failure, and cache failure cannot call Stripe cancellation or `failBooking`.
- Updated only T041 in `tasks.md`; synchronized `active-feature.md`, `progress-checker.md`, and the relevant supplier/recovery statements in `architecture.md`. T042–T043 and later phases remain pending.

**Status:** DONE. No unresolved T041 concerns.


### task-2-review.md

# T041 review

**Verdict: Approved.** No specification or code-quality findings for T041.

The recovery path narrows persisted order evidence to a nonblank top-level or nested ID, defers missing/malformed IDs, and returns the current booking on payment-event lookup failures. Unconfirmed or thrown cancellation outcomes return before Stripe release or booking failure; deferral write failures are logged and also remain non-destructive. Explicit cancellation proof is recorded before the hold is released and the booking is failed. The typed 429 guard accepts both required codes with positive integer retry seconds, uses a parseable upstream reset time when present, and falls back to bounded retry timing for invalid or absent metadata. Positive TTL skip and expired-key recheck remain in the locked recovery entry path.

The approved replay fixture changes use explicit `{ id, status: 'CANCELLED' }` evidence and retain the existing assertions. A regression covers a bare `already_cancelled` error deferring without writing proof or releasing the hold. Constructor injection and supplier boundaries remain intact; no new type assertions or SDK imports were introduced. Reviewed the recorded focused recovery/E2E, typecheck, and lint results; no additional tests were needed for this review.




## Scoped convergence report

# Scoped convergence assessment — feature 029 safe compensation

Outcome: **Converged for approved T040/T041 scope.** No actionable findings; `specs/029-duffel-provider-narrowing/tasks.md` was left unchanged. This is not a whole-feature completion claim. T042–T057 remain pending and outside this assessment.

**Inventory checked:** 3 scoped requirement entries (FR-006, FR-007a, FR-008); 3 US3 acceptance scenarios, limited to their compensation/recovery implications; 1 cancellation edge case; 2 order-sequence/risk decisions in `plan.md`; T040 and T041; 2 applicable constitution principles (Deterministic Transaction Boundary and API Budget Discipline), plus the no-PII logging constraint. Constitution is filled.

**Evidence:** In `payment-fulfillment.saga.ts`, inline cancellation rejects missing/unconfirmed results while returning PROCESSING and before hold void, terminal booking/payment updates, or idempotency completion. `handleBackgroundError` likewise returns on unconfirmed cancellation before compensation mutation or key completion. The order-created evidence and checkpoint remain available for retry. In `booking-recovery.service.ts`, the existing defer key is checked by the locked sweeper; invalid order evidence and unconfirmed cancellation defer safely. Budget denial uses the typed retry metadata; other failures use bounded backoff. Only confirmed cancellation writes the cancellation event and proceeds to release the hold/fail the booking. A confirmed event suppresses replay; if the cache key is lost, the existing sweeper safely rechecks after it becomes eligible. Cancellation remains behind the existing order capability/adapter path.

Relevant test cases were inspected as implementation evidence but not run, per scope instructions; the API suite is active. Hash check: `tasks.md` SHA-256 remained `4689C91A86116FE196922831B030FD14E80924E373FB90A2713D3B5B0215E4B7`.

## Final Spec review

# Final Spec Review — Feature 029 Slice 4 (T040–T041)

**Verdict:** Pass. **Findings:** 0 (blocker 0, high 0, medium 0, low 0).

The implementation matches the approved slice: inline and background saga compensation retain the retryable order checkpoint and avoid hold release, booking failure, or key completion when order evidence lacks a usable ID or cancellation is unconfirmed (`apps/api/src/payment-fulfillment/payment-fulfillment.saga.ts:829–871,1342–1372`). Stale recovery accepts top-level or nested order IDs, safely defers malformed/missing evidence and unconfirmed cancellation, uses the existing positive-TTL skip, and returns safely on lookup or deferral-cache errors (`apps/api/src/booking-lifecycle/booking-recovery.service.ts:68–75,335–443`; existing TTL gate at `:159–183`). Typed retry handling and confirmed-cancellation ordering align with the slice requirements (`GOAL.md:56–101`; `specs/029-duffel-provider-narrowing/spec.md:77,95`; `specs/029-duffel-provider-narrowing/contracts/supplier-boundaries.md:97–99`).

No scoped requirement is missing or partial. The two already-cancelled fixture changes are the approved evidence corrections; their assertions remain, and bare error text is not accepted as cancellation proof. No out-of-scope behavior was identified. T042–T057 remain pending as required (`specs/029-duffel-provider-narrowing/tasks.md:105–108,132–151`).

This was a read-only spec review; no tests were run.


## Final Standards review — initial report

# Final Standards Review — T040/T041

Scope: approved T040/T041 diff at `a832f128`. The known accidental `task-2-report.md` scratch artifact is left to final housekeeping.

## Documented breaches — 1 (P3)

- **Implicit test callback return types** — New async Jest callbacks use inferred `Promise<void>` (for example, `booking-recovery.service.spec.ts:690, 795, 1291`). This conflicts with `context/code-standards.md` → TypeScript: “All function parameters and return types must be explicitly typed.”

## Smells — 1 (P3)

- **Duplicated Code** — `booking-recovery.service.ts:68` and `payment-fulfillment.saga.ts:47` both read a nonblank top-level `id` or nested `data.id` from persisted order evidence. The repeated shape is `value.id` / `value.data.id`; consider a shared helper only where it preserves the module boundary.

No other baseline smells or documented breaches found. Added code has no type assertions, keeps constructor injection and exported ports, and requires explicit cancellation evidence through the existing confirmation path. No tests were run for this review; the root API gate passed separately.


Standards triage: the new-test callback annotation finding was corrected in ed24a4c0 in a dedicated type-only commit. The duplicated narrowing shape is a nonblocking heuristic; the approved design keeps this small logic local to the lifecycle and fulfillment modules. Extract a shared helper only when a real shared owner emerges; no runtime behavior is changed for this smell. No blocking findings were identified.


Ruling 7: Keep the small order-ID readers local to lifecycle and fulfillment because the approved design preserves capability-local ownership; a shared helper is not needed for correctness. Cost if wrong: duplicated narrowing must be updated in both modules until a shared owner emerges.


## Standards annotation fix — ed24a4c0

# T040/T041 Jest callback return annotations

Added explicit `Promise<void>` return types to the 20 async Jest callbacks introduced in T040/T041 across the payment fulfillment saga and booking recovery specs. Existing test callbacks, fixtures, assertions, production source, and behavior were left unchanged.

Validation:

- `pnpm --filter @api/backend exec jest --runInBand src/payment-fulfillment/payment-fulfillment.saga.spec.ts src/booking-lifecycle/booking-recovery.service.spec.ts` — exit 0; 2 suites, 122 tests passed.
- `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` — exit 0.
- `pnpm --filter @api/backend lint` — exit 0.

No new `any` or type assertions. Commit: `ed24a4c0` (`test(api): annotate T040/T041 Jest callbacks`).



## Standards scoped re-review

# Scoped Standards Fix Review

Reviewed commit `ed24a4c0` against `a832f128`, limited to the two requested spec files.

**Addressed:** P3 implicit callback return annotations. All 20 new async Jest callbacks now explicitly return `Promise<void>` (10 in each spec file), matching `context/code-standards.md`.

**Open findings:** 0. **New findings:** 0. The diff changes callback annotations only; no fixtures, assertions, source behavior, or type assertions changed. The prior duplicated order-ID narrowing observation remains nonblocking under the approved module-local helper ruling and is outside this fix review.

No tests were run for this review. The focused 122/122 suite, typecheck, and lint results were supplied by the root task.

**Severity counts:** addressed P3: 1; open P0/P1/P2/P3: 0.
