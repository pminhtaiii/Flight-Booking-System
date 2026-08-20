# Tasks: Pull-Request Continuous Integration Pipeline

## Phase 1: Setup

- [ ] T001 [P] Add Ruff 0.16.0 and policy in `apps/agent/pyproject.toml`
- [ ] T002 Regenerate canonical root lock and remove duplicate in `pyproject.toml`, `uv.lock`, and `apps/agent/uv.lock`
- [x] T003 [P] Add LF/binary policy in `.gitattributes`

## Phase 2: Foundational contract harness

- [ ] T004 Create shared evaluator in `scripts/ci/evaluate-ci-status.mjs`
- [ ] T005 Create Node workflow contract harness in `tests/ci/ci-workflow.contract.test.mjs`
- [x] T006 Create and prove Node network guard in `tests/ci/node-network-guard.cjs`
- [x] T007 Create and prove Python network guard in `tests/ci/python/sitecustomize.py`

## Phase 3: US1 — Stable PR quality check (P1)

**Independent test**: A docs-only PR to development produces one green `ci-status`; a non-target event does not run.

- [ ] T008 [US1] Add event/job/permission/concurrency RED cases in `tests/ci/ci-workflow.contract.test.mjs`
- [ ] T009 [US1] Create PR envelope and stable jobs in `.github/workflows/ci.yml`
- [ ] T010 [US1] Add SHA-pinned checkout and Node setup in `.github/workflows/ci.yml`
- [ ] T011 [US1] Invoke initial docs-only evaluator state in `.github/workflows/ci.yml`

## Phase 4: US2 — Change-aware routing (P1)

**Independent test**: Every defined path class maps to API/Web/Agent expected outputs.

- [ ] T012 [US2] Add routing RED cases in `tests/ci/ci-workflow.contract.test.mjs`
- [ ] T013 [US2] Add false-green summary RED cases in `tests/ci/ci-workflow.contract.test.mjs`
- [ ] T014 [US2] Implement SHA-pinned path filters in `.github/workflows/ci.yml`
- [ ] T015 [US2] Implement conditional job edges in `.github/workflows/ci.yml`
- [ ] T016 [US2] Complete shared truth-table evaluator wiring in `scripts/ci/evaluate-ci-status.mjs` and `.github/workflows/ci.yml`

## Phase 5: US3 — Service-specific validation (P1)

**Independent test**: Each service chain passes from a clean runner and fails at its own intended boundary.

- [ ] T017 [US3] Add API command/service/migration RED cases in `tests/ci/ci-workflow.contract.test.mjs`
- [ ] T018 [US3] Add Web command/environment RED cases in `tests/ci/ci-workflow.contract.test.mjs`
- [ ] T019 [US3] Add Agent Redis/guard RED cases in `tests/ci/ci-workflow.contract.test.mjs`
- [ ] T020 [US3] Converge API/shared ESLint baseline in `apps/api`, `packages/shared`, and `.eslintrc.json`
- [ ] T021 [US3] Implement `api-gate` in `.github/workflows/ci.yml`
- [ ] T022 [US3] Implement `api-unit-tests` in `.github/workflows/ci.yml`
- [ ] T023 [US3] Implement `api-e2e-tests` services/env/migration in `.github/workflows/ci.yml`
- [ ] T024 [US3] Implement `web-gate` in `.github/workflows/ci.yml`
- [ ] T025 [US3] Implement `web-build` in `.github/workflows/ci.yml`
- [ ] T026 [US3] Apply strict Redis marker/failure behavior in `apps/agent/tests` and `apps/agent/pyproject.toml`
- [ ] T027 [US3] Implement `agent-gate` in `.github/workflows/ci.yml`
- [ ] T028 [US3] Implement split Agent pytest/Redis service in `.github/workflows/ci.yml`

## Phase 6: US4 — Reproducible and secure execution (P2)

**Independent test**: Static validation rejects floating actions/tools, broad credentials, bad cache paths, and missing guards.

- [ ] T029 [US4] Add security/bootstrap RED cases in `tests/ci/ci-workflow.contract.test.mjs`
- [ ] T030 [US4] Audit full-SHA action registry in `.github/workflows/ci.yml`
- [ ] T031 [US4] Standardize Node/pnpm/cache bootstraps in `.github/workflows/ci.yml`
- [ ] T032 [US4] Standardize uv/Python/root-lock bootstraps in `.github/workflows/ci.yml`
- [ ] T033 [US4] Add line-ending and non-persisted-checkout controls in `.github/workflows/ci.yml`
- [ ] T034 [US4] Add checksum-verified actionlint and contract suite in `.github/workflows/ci.yml`
- [ ] T035 [US4] Validate timeouts, concurrency, actionlint, and Prettier in `.github/workflows/ci.yml`

## Phase 7: US5 — Operations (P3)

**Independent test**: Required check blocks failing PR, permits passing PR, and rollback leaves branch mergeable.

- [ ] T036 [US5] Record routing and exclusion scenarios in `specs/018-CI-CD-pipeline/quickstart.md`
- [ ] T037 [US5] Configure/verify only `ci-status` branch requirement in `specs/018-CI-CD-pipeline/quickstart.md`
- [ ] T038 [US5] Record warm-cache median, cancellation, and rollback evidence in `specs/018-CI-CD-pipeline/quickstart.md`

## Phase 8: Polish

- [ ] T039 Run contract, actionlint, and Prettier validation in `specs/018-CI-CD-pipeline/quickstart.md`
- [ ] T040 Run guarded API/Web/Agent commands in `specs/018-CI-CD-pipeline/quickstart.md`
- [ ] T041 Perform final spec/plan/tasks convergence audit in `specs/018-CI-CD-pipeline/`

## Dependency order

T001–T007 → US1 → US2 → US3 → US4 → US5 → polish. T001 and T003 are parallel; workflow edits remain sequential. MVP is US1.
