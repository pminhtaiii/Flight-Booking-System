# Implementation Plan: Pull-Request Continuous Integration Pipeline

**Branch**: `018-CI-CD-pipeline`  
**Scope**: Continuous integration only. Deployment, publishing, and CD are explicitly excluded.

## Technical Context

**Toolchain**: GitHub Actions YAML; Node 20; pnpm 10.34.5; TypeScript 5.4+; uv 0.12.0; Python 3.11; Ruff 0.16.0.  
**Actions**: checkout v7.0.1; setup-node v7.0.0; pnpm/action-setup v6.0.10; paths-filter v4.0.1; setup-uv v9.0.0; actionlint v1.7.12.  
**Services**: PostgreSQL 16-alpine and Redis 7-alpine for API E2E; Redis 7-alpine for Agent tests.  
**Constraints**: PRs to `development` only; one stable required check; no shared runner filesystem; no `node_modules`, `.next`, `.venv`, or build-output caches; no live provider calls.

## Constitution Check

| Principle | Result | Evidence |
|---|---|---|
| Flight-first architecture | PASS | CI validates the existing monorepo without product-scope change. |
| Deterministic transaction boundary | PASS | Workflow cannot participate in booking/payment behavior. |
| API budget discipline | PASS | Test doubles, non-production fixtures, and fail-closed network guards prevent provider use. |
| Operational visibility | NOT AFFECTED | CI logs/duration evidence do not replace runtime telemetry. |
| Incremental delivery | PASS | Stable check, routing, validation, hardening, and rollout are independently verifiable. |
| Security | PASS WITH CONTROLS | Immutable action SHAs, least privilege, and non-persisted checkout credentials. |

## Workflow Design

### Envelope

- Trigger only `pull_request` whose base is `development`; no push, target, schedule, dispatch, release, deployment, or CD trigger.
- Default `permissions: { contents: read }`; only `detect-changes` adds `pull-requests: read`.
- PR-number concurrency with `cancel-in-progress: true`.
- Every job runs Ubuntu with explicit timeouts: detection/gates/summary 10 minutes, unit/build/Agent tests 20, API E2E 30 pending measurements.
- Every checkout uses `persist-credentials: false`; global `core.autocrlf=input` is set before checkout and `.gitattributes` owns LF normalization.

### Routing matrix

| Changed path | API | Web | Agent |
|---|:---:|:---:|:---:|
| `apps/api/**` | yes | no | no |
| `apps/web/**` | no | yes | no |
| `apps/agent/**` | no | no | yes |
| `packages/shared/**` | yes | yes | yes |
| `.github/workflows/ci.yml`, `.gitattributes`, `tests/ci/**`, `scripts/ci/**` | yes | yes | yes |
| root Node/package/TS/ESLint/npm inputs | yes | yes | no |
| root `pyproject.toml`, `uv.lock` | no | no | yes |
| docs/spec-only paths | no | no | no |

Detection exposes exact string booleans (`true`/`false`) for `api`, `web`, and `agent`; all conditions compare explicitly to `'true'`.

### Fresh-runner bootstrap

`needs` transfers ordering, conclusions, and outputs only—never checkout, dependencies, Prisma Client, or shared build artifacts.

**API/Web jobs**: global Git config → full-SHA checkout → pnpm 10.34.5 → Node 20 with pnpm-store cache → frozen root install → job-specific work. API jobs set a syntactically valid dummy `DATABASE_URL` before install and generation.  
**Agent jobs**: Git config → checkout → full-SHA setup-uv (`version: 0.12.0`, root-lock cache) → `uv python install 3.11` → `uv sync --locked --package agent` → job command.  
**Detection and summary**: set up Node 20 only; no pnpm/root install.

### Jobs

| Job | Condition / needs | Exact responsibility |
|---|---|---|
| `detect-changes` | always | contract suite; checksum-verified actionlint; full-SHA paths filter. |
| `api-gate` | API true | API/shared ESLint zero warnings; shared build; Prisma generate; API `tsc --noEmit`. |
| `api-unit-tests` | API gate success | fresh shared build/Prisma generation; Node guard; Jest `--runInBand`. |
| `api-e2e-tests` | API gate success | healthy Postgres/Redis; complete fixture env; guard; shared/Prisma/migrate deploy/E2E. |
| `web-gate` | Web true | shared build; lint; route check; typecheck. |
| `web-build` | Web gate success | fresh build, NextAuth/API-3001/Agent-3002 fixtures, Node guard. |
| `agent-gate` | Agent true | locked root sync; Ruff check and format check. |
| `agent-tests` | Agent gate success | healthy Redis; Python guard; non-Redis pytest then strict non-empty Redis group. |
| `ci-status` | all jobs; `always()` | Node 20 and shared evaluator with fixed outputs/results. |

### Summary contract

`scripts/ci/evaluate-ci-status.mjs` is pure/importable and has a CLI. It first requires successful detection and exact boolean outputs. It rejects every failure/cancellation, a relevant chain job other than success, and an irrelevant chain job other than skipped. Contract tests import the exact evaluator and run valid, malformed-output, failure, cancellation, and unexpected-skip matrices.

### Services, fixtures, and isolation

API E2E owns health-checked Postgres/Redis and runs shared build → Prisma generate → `prisma migrate deploy` → E2E. Agent tests own health-checked Redis and use `CI_REQUIRE_REDIS_TESTS=1` so Redis-unavailable fixture paths fail rather than skip. Fixtures are visibly non-production and job-local. Node test/build and Agent pytest processes load loopback-only guards after dependency installation/sync; guards allow local services/Unix sockets and reject public destinations. The service image major lines intentionally accept patched upstream images; their health checks and full suites gate compatibility.

### Validation and rollout

`tests/ci/ci-workflow.contract.test.mjs` uses Node built-ins, comment-stripped tightly anchored workflow extraction, and the shared evaluator. It validates triggers, pins, routing, job edges, caches, line-ending order, permissions, guards, and summary states; actionlint validates YAML/expressions. Enable branch protection only after a successful test PR creates `ci-status`. Rollback removes/updates the branch requirement first, then reverts the workflow.

## Planned Files

```text
.github/workflows/ci.yml
.gitattributes
apps/agent/pyproject.toml
apps/agent/uv.lock                    # remove after root lock becomes canonical
pyproject.toml / uv.lock
scripts/ci/evaluate-ci-status.mjs
tests/ci/ci-workflow.contract.test.mjs
tests/ci/node-network-guard.cjs
tests/ci/python/sitecustomize.py
```
