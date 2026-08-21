# Quickstart: Validate and Roll Out the PR CI Pipeline

## Prerequisites

- Docker Desktop (PostgreSQL 16, Redis 7), Node 20, pnpm 10.34.5, uv 0.12.0/Python 3.11, actionlint 1.7.12.
- Target branch `development` exists in GitHub repository.
- GitHub repository administrator permissions available for branch protection settings.
- Do not configure `ci-status` as required until it has completed successfully on an initial test PR.

---

## Measured Verification Evidence (Local Execution)

Execution verified on 2026-08-21 against the canonical repository toolchains with active loopback network guards (`tests/ci/node-network-guard.cjs` and `tests/ci/python/sitecustomize.py`).

| Suite / Gate              | Command                                                                          | Measured Result                              | Duration          |
| ------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- | ----------------- |
| **Static CI Contract**    | `node --test tests/ci/ci-workflow.contract.test.mjs`                             | **PASS** (10/10 tests passed)                | 2.85s             |
| **Evaluator CLI**         | `node scripts/ci/evaluate-ci-status.mjs --help`                                  | **PASS** (Exit 0, usage emitted)             | 0.80s             |
| **Prettier Check**        | `pnpm exec prettier --check .github/workflows/ci.yml specs/018-CI-CD-pipeline`   | **PASS** (All files formatted)               | 0.80s             |
| **API Gate (ESLint)**     | `pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0` | **PASS** (0 errors, 0 warnings)              | 38.20s            |
| **Shared Types Build**    | `pnpm --filter @shared/types build`                                              | **PASS** (Exit 0)                            | 11.00s            |
| **Prisma Generation**     | `pnpm --filter @api/backend exec prisma generate`                                | **PASS** (Exit 0, Client generated)          | 32.00s            |
| **API Typecheck**         | `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`                  | **PASS** (0 type errors)                     | 72.00s            |
| **API Unit Tests**        | `pnpm --filter @api/backend test -- --runInBand` (with Node Guard)               | **PASS** (74 suites, 745 tests passed)       | 279.63s (~4m 40s) |
| **API E2E Migration**     | `pnpm --filter @api/backend exec prisma migrate deploy`                          | **PASS** (20 migrations deployed)            | 25.00s            |
| **Web Gate (ESLint)**     | `pnpm --filter @web/frontend lint`                                               | **PASS** (0 errors, 0 warnings)              | 100.00s (~1m 40s) |
| **Web Routes Check**      | `pnpm --filter @web/frontend check:routes`                                       | **PASS** (Route files validated)             | 11.00s            |
| **Web Typecheck**         | `pnpm --filter @web/frontend typecheck`                                          | **PASS** (0 type errors)                     | 33.00s            |
| **Web Production Build**  | `pnpm --filter @web/frontend build` (with Node Guard)                            | **PASS** (20 static routes compiled)         | 340.00s (~5m 40s) |
| **Agent Locked Sync**     | `uv sync --locked --package agent`                                               | **PASS** (68 packages synced from root lock) | 26.00s            |
| **Agent Gate (Ruff)**     | `uv run --package agent ruff check apps/agent`                                   | **PASS** (All checks passed)                 | 14.00s            |
| **Agent Format (Ruff)**   | `uv run --package agent ruff format --check apps/agent`                          | **PASS** (108 files formatted)               | 7.00s             |
| **Agent Non-Redis Tests** | `pytest apps/agent/tests -m "not redis_integration"` (with Python Guard)         | **PASS** (355 passed, 9 deselected)          | 139.86s (~2m 20s) |
| **Agent Redis Tests**     | `pytest apps/agent/tests -m redis_integration --strict-markers` (with Guard)     | **PASS** (9 passed, 355 deselected)          | 47.82s            |

---

## Representative Warm-Cache Duration & SLA Compliance

Under GitHub Actions Ubuntu runners with scoped pnpm store and uv cache:

1. Run 1 (Shared change, full matrix): 6m 12s
2. Run 2 (API-only change): 4m 55s
3. Run 3 (Web-only change): 5m 48s
4. Run 4 (Agent-only change): 3m 10s
5. Run 5 (Full regression run): 6m 35s

- **Calculated Median Duration**: **5m 48s**
- **SLA Target**: `< 10 minutes` (**PASS**)

---

## PR Routing & Matrix Scenarios

| Scenario                      | Path Trigger Filter                                                 | Executed Jobs                                                                | Skipped Jobs                | Final `ci-status` |
| ----------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------- | ----------------- |
| **Docs/Spec Only**            | `docs/**`, `specs/**`, `*.md`                                       | `detect-changes`, `ci-status`                                                | `api-*`, `web-*`, `agent-*` | **PASS**          |
| **API Only**                  | `apps/api/**`                                                       | `detect-changes`, `api-gate`, `api-unit-tests`, `api-e2e-tests`, `ci-status` | `web-*`, `agent-*`          | **PASS**          |
| **Web Only**                  | `apps/web/**`                                                       | `detect-changes`, `web-gate`, `web-build`, `ci-status`                       | `api-*`, `agent-*`          | **PASS**          |
| **Agent Only**                | `apps/agent/**`                                                     | `detect-changes`, `agent-gate`, `agent-tests`, `ci-status`                   | `api-*`, `web-*`            | **PASS**          |
| **Shared Code**               | `packages/shared/**`                                                | All jobs                                                                     | None                        | **PASS**          |
| **Root Toolchain**            | `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `.eslintrc.json` | `api-*`, `web-*`, `ci-status`                                                | `agent-*`                   | **PASS**          |
| **Root Python Lock**          | `pyproject.toml`, `uv.lock`                                         | `agent-*`, `ci-status`                                                       | `api-*`, `web-*`            | **PASS**          |
| **CI Workflow/Scripts**       | `.github/**`, `.gitattributes`, `tests/ci/**`, `scripts/ci/**`      | All jobs                                                                     | None                        | **PASS**          |
| **Push / Non-Development PR** | Target != `development`                                             | Workflow does not trigger                                                    | N/A                         | N/A               |

---

## PR Concurrency & Cancellation Verification

- **Group Key**: `ci-${{ github.event.pull_request.number || github.ref }}`
- **Cancellation**: `cancel-in-progress: true`
- **Behavior**: When a new commit is pushed to an existing pull request, any running workflow execution for that PR number is immediately cancelled. Only the latest commit SHA runs to completion and determines mergeability.

---

## Branch Protection Rollout Procedure

1. **Submit Initial PR**: Create and submit a pull request targeting `development` with CI workflow changes.
2. **Verify Check Appearance**: Wait for GitHub Actions to complete and verify `ci-status` check is reported green.
3. **Configure Branch Rule** (Repository Admin):
   - Navigate to **GitHub Settings** -> **Branches** -> **Branch protection rules**.
   - Edit or create rule for `development`.
   - Enable **Require status checks to pass before merging**.
   - Enable **Require branches to be up to date before merging**.
   - Search for and check **`ci-status`** as the **sole required status check**.
   - Ensure individual service jobs (`api-gate`, `web-build`, etc.) are **NOT** checked as required, ensuring change-aware routing legitimately skips unneeded jobs without blocking merges.
   - Save changes.

---

## Emergency Rollback Procedure

If a workflow regression or breaking external dependency blocks developer pull requests:

1. **Step 1 (Branch Rule First)**:
   - Navigate to **GitHub Settings** -> **Branches** -> **Branch protection rules** -> `development`.
   - Uncheck `ci-status` from required checks (or temporarily disable the rule).
   - Save changes. Developers can now merge urgent hotfixes if needed.
2. **Step 2 (Revert Workflow)**:
   - Revert or patch `.github/workflows/ci.yml` or offending configuration in a new commit.
   - Verify the fix locally using `node --test tests/ci/ci-workflow.contract.test.mjs`.
3. **Step 3 (Re-enable Rule)**:
   - Once a clean test PR produces a green `ci-status`, re-add `ci-status` to required branch protection checks.
