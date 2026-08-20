# Feature Specification: Pull-Request Continuous Integration Pipeline

**Feature Branch**: `018-CI-CD-pipeline`  
**Status**: Ready for converged planning  
**Scope**: Continuous integration only; deployment/CD is explicitly out of scope.

## User Stories

### US1 — Stable PR quality check (P1)

As a developer, every pull request to `development` receives one dependable `ci-status` check.

**Independent test**: A docs-only PR runs detection, legitimately skips all service jobs, and passes `ci-status`; a push or PR to another base branch does not run it.

### US2 — Change-aware routing (P1)

As a developer, only affected service chains run, while configuration, shared-code, and CI-code changes cannot false-green.

**Independent test**: The contract matrix maps API, Web, Agent, shared, root-input, workflow, policy, test, script, and docs-only changes to the expected booleans.

### US3 — Executable service validation (P1)

As a developer, changed API, Web, and Agent code is checked with the repository’s real commands on fresh Ubuntu runners.

**Independent test**: Each chain starts from a clean checkout, can fail at its own gate/downstream boundary, and passes without local `.env` files or live-provider access.

### US4 — Reproducible, secure CI (P2)

As a maintainer, CI uses compatible pinned tools, least privilege, safe caching, and deterministic line-ending policy.

**Independent test**: Static contract validation rejects floating actions/tools, persisted checkout credentials, broad permissions, disallowed caches, malformed summary inputs, and missing timeouts.

### US5 — Branch-protection handoff (P3)

As a repository administrator, I can safely require the stable check after evidence is collected and reverse the change without blocking merges.

**Independent test**: A failed PR is blocked, a passing PR is mergeable, a superseded run is cancelled, and the branch-rule-first rollback drill succeeds.

## Functional Requirements

- **FR-001**: Define exactly one workflow at `.github/workflows/ci.yml`, triggered only by `pull_request` targeting `development`.
- **FR-002**: Define the stable job IDs `detect-changes`, `api-gate`, `api-unit-tests`, `api-e2e-tests`, `web-gate`, `web-build`, `agent-gate`, `agent-tests`, and `ci-status`.
- **FR-003**: Use PR-number concurrency with `cancel-in-progress: true`, `ubuntu-latest`, and explicit job timeouts.
- **FR-004**: Default to `contents: read`; grant `pull-requests: read` only to `detect-changes`; all checkouts use `persist-credentials: false`.
- **FR-005**: Detection emits only exact `true`/`false` outputs for API, Web, and Agent using a SHA-pinned path filter.
- **FR-006**: `apps/api/**`, `apps/web/**`, and `apps/agent/**` trigger their own chains; `packages/shared/**`, workflow/policy files, `tests/ci/**`, and `scripts/ci/**` trigger all; root Node inputs trigger API+Web; root `pyproject.toml`/`uv.lock` trigger Agent; docs/spec-only changes trigger none.
- **FR-007**: Each repository-consuming API/Web job performs its own checkout, pinned Node 20/pnpm 10.34.5 setup, frozen root install, and generated-artifact preparation. Agent jobs use uv 0.12.0, Python 3.11, root `uv.lock`, and `uv sync --locked --package agent`.
- **FR-008**: API gate runs the exact API/shared ESLint command, shared build, Prisma generation, and no-emit TypeScript check; the existing lint baseline must be made green before the gate is enabled.
- **FR-009**: API E2E owns healthy PostgreSQL 16-alpine and Redis 7-alpine, generates Prisma Client, applies `prisma migrate deploy`, then runs E2E.
- **FR-010**: Web gate runs lint, route validation, shared build, and typecheck; Web build uses validated non-production configuration and API port 3001.
- **FR-011**: Agent gate runs locked Ruff check and format check. Agent tests own healthy Redis, run a non-Redis group and a non-empty `redis_integration` group, and turn missing-Redis skips into failures under `CI_REQUIRE_REDIS_TESTS=1`.
- **FR-012**: Non-production fixtures and loopback-only Node/Python network guards prevent live provider calls.
- **FR-013**: Every action uses a reviewed 40-character SHA with a release comment; no `node_modules`, `.next`, `.venv`, or build output is cached.
- **FR-014**: `.gitattributes` defines LF policy; `core.autocrlf=input` is configured globally before checkout.
- **FR-015**: `ci-status` uses `always()`, explicitly needs all jobs, rejects malformed filter outputs, failure/cancellation, failed detection, unexpected skips, and any relevant job not succeeding.
- **FR-016**: A shared Node summary evaluator, built-in contract tests, and checksum-verified actionlint validate the workflow before rollout.
- **FR-017**: Branch protection remains a manual administrative handoff: require only `ci-status` after a successful test PR; rollback removes/updates the rule before reverting the workflow.

## Assumptions and Success Criteria

- GitHub Actions and service containers are enabled and `development` exists.
- Root `pyproject.toml`/`uv.lock` are the canonical Agent workspace inputs; the duplicate Agent lock is retired during implementation.
- Five warm-cache representative full runs have a median below ten minutes.
- Every PR to `development` receives one `ci-status`; all routing and synthetic false-green cases pass; a clean Ubuntu runner passes each relevant chain.

## Out of Scope

Deployments, publishing, production credentials, direct-push CI, Playwright browser CI, automatic branch-protection mutation, and custom notifications.
