# Tasks: Whole-Stack Smoke and Sanity CI

**Input**: Design documents from `/specs/020-smoke-sanity-tests/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/test-harness.md`, `quickstart.md`

**Tests**: Required. This feature is itself a whole-stack test gate and the repository workflow mandates RED → GREEN → REFACTOR. Test tasks precede their corresponding implementation tasks.

**Organization**: Tasks are grouped by user story so smoke gating is deliverable first, sanity flows second, and reproducible CI/local operation third.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish discoverable commands, environment documentation, and safe generated-output boundaries without changing runtime behavior.

- [x] T001 Create the smoke-suite coverage and command skeleton in `tests/smoke/README.md`
- [x] T002 [P] Specify zero-dependency smoke, sanity, and harness-unit test scripts (roadmap documented in `tests/smoke/README.md` for progressive registration across Phases 2–5)
- [x] T003 [P] Ignore only the run-scoped smoke diagnostic directory in `.gitignore`
- [x] T004 [P] Document optional `DUFFEL_API_URL`, `STRIPE_API_URL`, private `API_URL`, and smoke-safe service URLs in `apps/api/.env.example`, `apps/web/.env.example`, and `apps/agent/.env.example`

**Checkpoint**: Feature commands and configuration are visible; no production default has changed.

---

## Phase 2: Foundational Contracts and Test Seams

**Purpose**: Build the dependency-free utilities, mock boundary, and minimal health/provider seams required by every user story.

**⚠️ CRITICAL**: Complete this phase before any whole-stack story test.

### Provider override contracts

- [x] T005 [P] Add failing default-parity, valid-loopback-override, invalid-URL, and manual-request-base tests in `apps/api/src/duffel/duffel.service.spec.ts`
- [x] T006 [P] Add failing default-parity, parsed protocol/host/port override, and invalid-URL tests in `apps/api/src/common/stripe.service.spec.ts`
- [x] T007 [P] Make `DUFFEL_API_URL` configure the installed Duffel SDK `basePath` and all manual Duffel HTTP calls while preserving the absent-variable default in `apps/api/src/duffel/duffel.service.ts` (depends on T005)
- [x] T008 [P] Make `STRIPE_API_URL` configure Stripe protocol/host/port while preserving the absent-variable SDK default in `apps/api/src/common/stripe.service.ts` (depends on T006)

### Cross-service health contracts

- [x] T009 [P] Add failing no-LLM liveness behavior tests in `apps/agent/tests/test_health.py`
- [x] T010 [P] Add failing API-to-Agent liveness target, timeout, success, and sanitized failure tests in `apps/api/src/health/agent-health.service.spec.ts`
- [x] T011 [P] Add failing dynamic/no-store, bounded Nest ping, sanitized 200, and sanitized 503 tests in `apps/web/app/health/upstream/route.spec.ts`
- [x] T012 [P] Add the lightweight liveness route without Mimo, guardrail, chat, or LLM work in `apps/agent/src/agent/main.py` (depends on T009)
- [x] T013 Update the Agent health client to call the lightweight liveness route with bounded diagnostics in `apps/api/src/health/agent-health.service.ts` (depends on T010, T012)
- [x] T014 [P] Implement the private-URL, no-store upstream readiness handler in `apps/web/app/health/upstream/route.ts` (depends on T011)

### Dependency-free harness utilities

- [x] T015 [P] Add failing concurrent-success, staggered-readiness, shared-timeout, and per-service diagnostic tests in `tests/smoke/wait-for-ready.unit.test.mjs`
- [x] T016 Implement two-second concurrent polling with one 120-second deadline and safe structured failures in `tests/smoke/helpers/wait-for-ready.mjs` (depends on T015)
- [x] T017 [P] Add failing method-plus-path routing, Duffel JSON validation, Stripe form validation, counter reset/snapshot, malformed-body, unknown-route, and redaction tests in `tests/smoke/mock-server.unit.test.mjs`
- [x] T018 Implement the standalone validating Duffel/Stripe HTTP server and loopback-only safe control routes in `tests/smoke/mocks/mock-server.mjs` (depends on T017)
- [x] T019 [P] Add failing request diagnostics, unique actor, HMAC claim, cache normalization, and bounded payment-poll tests in `tests/smoke/test-utils.unit.test.mjs`
- [x] T020 Implement HTTP, auth, claim, profile, search, intent, payment, polling, redaction, and mock-counter helpers in `tests/smoke/helpers/test-utils.mjs` (depends on T019)

**Checkpoint**: Provider calls can reach validating loopback mocks; health probes avoid inference; utilities are independently green.

---

## Phase 3: User Story 1 - Gate Pull Requests on Whole-Stack Readiness (Priority: P1) 🎯 MVP

**Goal**: Prove every deployable service, Postgres, Redis, Web→API, API→Agent, and the API auth round trip through shallow public HTTP checks.

**Independent Test**: Start the prepared stack and run `node --test --test-reporter=spec tests/smoke/smoke.test.mjs`; all eight named checks pass in under 15 seconds. Breaking any check exits non-zero.

### Tests and implementation for User Story 1

- [x] T021 [US1] Add failing API health response and separate Postgres/Redis dependency assertions in `tests/smoke/smoke.test.mjs`
- [x] T022 [US1] Add failing Next homepage 200/expected-HTML and Agent direct-health reachability assertions in `tests/smoke/smoke.test.mjs`
- [x] T023 [US1] Add failing Web `/health/upstream` and API `/api/health/agent` cross-service assertions in `tests/smoke/smoke.test.mjs`
- [x] T024 [US1] Add failing register → login → bearer `/api/auth/me` identity round-trip with a unique valid credential in `tests/smoke/smoke.test.mjs`
- [x] T025 [US1] Add a suite-level 15-second execution budget and secret/PII-safe assertion diagnostics in `tests/smoke/smoke.test.mjs`
- [x] T026 [US1] Run the eight checks against a manually started local stack and fix only public-contract or fixture gaps in `tests/smoke/smoke.test.mjs`
- [x] T027 [US1] Document the standalone smoke command, eight-check mapping, expected timing, and failure interpretation in `tests/smoke/README.md`

**Checkpoint**: The smoke suite is a complete independently runnable MVP. Do not begin sanity work until it is green.

---

## Phase 4: User Story 2 - Validate Key Deterministic Business Flows (Priority: P2)

**Goal**: Prove flight search/cache, the happy-path booking lifecycle, and real cross-service authorization semantics without real providers or LLM calls.

**Independent Test**: Against the smoke-green stack, run `node --test --test-reporter=spec tests/smoke/sanity.test.mjs`; all flow groups pass in under 60 seconds and mock counters prove supplier behavior.

### Flight search and cache

- [x] T028 [P] [US2] Add deterministic Duffel offer-request, offer-detail, offer-pricing, and order fixtures with required-field assertions in `tests/smoke/mocks/mock-server.mjs`
- [x] T029 [US2] Add a failing authenticated flight-search contract test for required result/meta fields in `tests/smoke/sanity.test.mjs` (depends on T028)
- [x] T030 [US2] Add a failing separate cache test that compares results/search hash, asserts `cached` false→true, and asserts one Duffel offer-request in `tests/smoke/sanity.test.mjs`
- [x] T031 [US2] Use flight detail to capture the authoritative offer passenger identifier for later readiness instead of hardcoding it in `tests/smoke/sanity.test.mjs`

### Confirmed booking happy path

- [ ] T032 [P] [US2] Add deterministic Stripe customer/payment-intent/retrieve/capture fixtures matching the installed SDK's form requests in `tests/smoke/mocks/mock-server.mjs`
- [ ] T033 [US2] Add failing traveler profile upsert and booking-readiness assertions using the current revision and public DTO contracts in `tests/smoke/sanity.test.mjs`
- [ ] T034 [US2] Add failing booking-intent assertions using the search-derived flight/passenger identities in `tests/smoke/sanity.test.mjs`
- [ ] T035 [US2] Add failing payment-create and payment-confirm assertions with distinct idempotency keys and a generated booking UUID in `tests/smoke/sanity.test.mjs` (depends on T032)
- [ ] T036 [US2] Add bounded 202 payment-status polling and final owner-visible `CONFIRMED` booking/reference assertions in `tests/smoke/sanity.test.mjs`

### Agent communication and authorization

- [ ] T037 [US2] Add failing direct Agent health and API-to-Agent no-LLM liveness assertions in `tests/smoke/sanity.test.mjs`
- [ ] T038 [US2] Add failing valid `X-Agent-API-Key` plus signed active-user claim gateway assertion in `tests/smoke/sanity.test.mjs`
- [ ] T039 [US2] Add failing missing-key and wrong-key 401 assertions plus valid-key unauthorized-user 403 assertion in `tests/smoke/sanity.test.mjs`
- [ ] T040 [US2] Enforce the 60-second sanity budget and verify the selected routes cause zero chat/LLM mock requests in `tests/smoke/sanity.test.mjs`
- [ ] T041 [US2] Document the sanity flow inputs, cache comparison rule, async confirmation behavior, and actual 401/403 semantics in `tests/smoke/README.md`

**Checkpoint**: Search/cache, confirmed booking, and Agent checks are independently named, deterministic, and green after smoke.

---

## Phase 5: User Story 3 - Make the Suites Reproducible and Diagnosable (Priority: P3)

**Goal**: Give local developers and GitHub Actions one bounded boot/readiness/run/cleanup lifecycle with correct change-aware aggregation.

**Independent Test**: Run the orchestrator locally against `smoke_test`, then execute the CI workflow contract/evaluator truth table. A forced service failure produces diagnostics, skips sanity after smoke failure, cleans owned processes, and exits non-zero.

### Orchestrator and database safety

- [ ] T042 [P] [US3] Add failing process-start, premature-exit, smoke-gates-sanity, signal, bounded-cleanup, and exact-child-ownership tests in `tests/smoke/run-smoke-sanity.unit.test.mjs`
- [ ] T043 [P] [US3] Add failing loopback URL and exact `smoke_test` local-reset guard tests in `tests/smoke/run-smoke-sanity.unit.test.mjs`
- [ ] T044 [US3] Implement mock/API/Agent/Web spawning, per-process safe logs, readiness, spec-reporter smoke→sanity sequencing, signal handling, and exact-child cleanup in `scripts/ci/run-smoke-sanity.mjs` (depends on T042)
- [ ] T045 [US3] Implement an explicit local database reset mode that parses `DATABASE_URL` and refuses any database name other than `smoke_test` in `scripts/ci/run-smoke-sanity.mjs` (depends on T043)

### Workflow graph and aggregate result

- [ ] T046 [P] [US3] Add failing workflow-contract assertions for all-service smoke path filters including `docker-compose.yml`, the Compose-only all-domains-true case, exact terminal needs, change-aware `always()` predicate, locked setup/build/migration order, readiness-before-smoke, smoke-before-sanity, spec reporter, network guard, diagnostics, cleanup, timeout, and `ci-status` wiring in `tests/ci/ci-workflow.contract.test.mjs`
- [ ] T047 [P] [US3] Add a failing truth-table test for expected success/skipped/failure/cancelled `SMOKE_AND_SANITY_RESULT` states, including Compose-only eligibility, in `tests/ci/evaluate-ci-status.test.mjs`
- [ ] T048 [US3] Extend change-aware aggregate evaluation and safe failure messages so infrastructure changes cannot take the all-domains-false skip path in `scripts/ci/evaluate-ci-status.mjs` (depends on T047)
- [ ] T049 [US3] Add the single `smoke-and-sanity` job, all-service filters including `docker-compose.yml`, locked setup, Compose infra, builds/migration, non-secret loopback env, orchestrator invocation, always-run diagnostics/cleanup, and aggregate env/needs in `.github/workflows/ci.yml` (depends on T044, T046, T048)
- [ ] T050 [US3] Complete local reset/start/run/cleanup commands, CI parity, expected timings, redaction rules, and troubleshooting in `tests/smoke/README.md`

**Checkpoint**: The same contract is reproducible locally and enforced by PR CI with correct skipped-job semantics.

---

## Phase 6: Polish and Cross-Cutting Verification

**Purpose**: Synchronize repository guidance and execute all proportional gates before implementation completion.

- [ ] T051 [P] Replace the planned smoke/sanity section with the implemented job graph, routes, provider seams, and runtime data flow in `context/architecture.md`
- [ ] T052 [P] Document the operational Web health route exception and provider override default-safety convention in `context/code-standards.md`
- [ ] T053 [P] Document installed Duffel `basePath` and Stripe endpoint override usage in `context/library-docs.md`
- [ ] T054 Update Feature 020 task state and exact verification evidence in `context/progress-checker.md`
- [ ] T055 Run the feature static/unit gates and record exit codes in `specs/020-smoke-sanity-tests/quickstart.md`
- [ ] T056 Run the complete local smoke-and-sanity lifecycle, require final exit code 0, verify timing budgets and cleanup, and record evidence in `context/progress-checker.md`
- [ ] T057 Run the change-aware API, Web, and Agent pre-PR gate matrix from `AGENTS.md` and resolve regressions without weakening tests in `context/progress-checker.md`

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: Starts immediately.
- **Phase 2 (Foundational)**: Depends on setup; blocks all user stories.
- **Phase 3 (US1 Smoke MVP)**: Depends on T007–T020 and must be green before sanity.
- **Phase 4 (US2 Sanity)**: Depends on US1 plus the shared actor/mock helpers; search/cache, booking, and Agent test work can be developed in separate files/fixture sections but integrates in one suite.
- **Phase 5 (US3 Reproducibility/CI)**: Orchestrator unit work can begin after foundational utilities; final workflow wiring depends on the smoke and sanity commands being stable.
- **Phase 6 (Polish)**: Depends on all desired stories.

### User story dependencies

```text
Setup → Foundation → US1 Smoke (MVP) → US2 Sanity
                         └──────────────→ US3 Orchestration/CI
US2 + US3 → Polish/Full Verification
```

- **US1** is the MVP and has no dependency on US2 or final CI wiring.
- **US2** is intentionally gated by successful US1 behavior.
- **US3** can develop orchestration in parallel after the foundation, but workflow activation waits for stable US1/US2 commands.

### Within each story

- Add one failing public-behavior test.
- Run it and confirm the expected RED reason.
- Implement only the minimal fixture/seam/harness behavior.
- Run the focused test and all previously green feature tests.
- Refactor with tests green; never weaken an established assertion without user approval.

## Parallel Opportunities

- Provider tests/implementations T005–T008 are independent of Web/Agent health T009–T014.
- Wait helper, mock server, and test-utils tests T015, T017, T019 can start in parallel.
- In US2, Duffel fixtures/search work T028–T031, Stripe fixtures T032, and Agent checks T037–T039 can be prepared independently before final suite integration.
- Orchestrator unit tests T042–T043, workflow contract T046, and evaluator truth table T047 touch different files and can run in parallel.
- Documentation T051–T053 is parallel after behavior stabilizes.

## Parallel Example: User Story 2

```text
Task A: T028–T031 in tests/smoke/mocks/mock-server.mjs and tests/smoke/sanity.test.mjs
Task B: T032 in tests/smoke/mocks/mock-server.mjs after coordinating fixture sections
Task C: T037–T039 in tests/smoke/sanity.test.mjs after coordinating test blocks
```

Because Tasks A–C converge on two shared files, parallel agents must agree on non-overlapping test/route blocks or work sequentially within each file.

## Implementation Strategy

### MVP first

1. Complete Setup and Foundation.
2. Complete US1's eight smoke checks.
3. Stop and validate the smoke suite independently under its 15-second budget.
4. Only then add US2 sanity flows.

### Incremental delivery

1. Provider/health seams + dependency-free utilities.
2. Smoke suite proves composed readiness.
3. Search/cache sanity proves supplier and Redis behavior.
4. Booking sanity proves the deterministic critical path.
5. Agent sanity proves reachability and authorization semantics.
6. Orchestrator and CI aggregation make all increments mandatory on relevant PRs.

### Rollback boundaries

- Provider URL seams revert independently with overrides removed.
- Health routes/client changes revert together with their smoke checks.
- CI workflow, evaluator, and workflow contract revert atomically.
- No database migration or persistent production data rollback is required.

## Task Summary

- **Total tasks**: 57
- **Setup**: 4
- **Foundational**: 16
- **US1**: 7
- **US2**: 14
- **US3**: 9
- **Polish/verification**: 7
- **Suggested MVP**: T001–T027 (Setup + Foundation + User Story 1)
- **Format validation**: Every task uses `- [ ] T###`, uses `[P]` only for independent files/work, includes `[US#]` in story phases, and names exact repository file paths.
