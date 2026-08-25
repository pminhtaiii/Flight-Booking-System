# Research: Pull-Request Continuous Integration Pipeline

**Validated**: 2026-08-17  
All earlier planning ambiguities are resolved below.

## 1. Change detection and a stable required check

- **Decision**: Use `dorny/paths-filter` v4.0.1 pinned to `fbd0ab8f3e69293af611ebaee6363fc25e6d187d`.
- **Rationale**: Native event path filtering suppresses the entire workflow for docs-only PRs, which leaves no stable required status. The action publishes per-filter outputs and documents its PR metadata permission requirement.
- **Rejected**: custom diff parsing (reimplements merge-base/rename behavior); requiring all conditional jobs in branch protection (legitimate skips can block merges).

## 2. Immutable action and tool registry

- **Decision**: Pin every `uses:` reference to a 40-character reviewed SHA, with a release comment: checkout v7.0.1 `3d3c42e5aac5ba805825da76410c181273ba90b1`; setup-node v7.0.0 `820762786026740c76f36085b0efc47a31fe5020`; pnpm/action-setup v6.0.10 `0977fd99725f1db4007ccb2928dbb4e90d06cc86`; setup-uv v9.0.0 `c771a70e6277c0a99b617c7a806ffedaca235ff9`.
- **Rationale**: Major tags move; a full SHA is immutable CI code. Initial workflow tasks must introduce SHAs immediately rather than waiting for a later audit.
- **Rejected**: floating majors or Dependabot-only governance.

## 3. Node and pnpm compatibility

- **Decision**: Use Node 20 with pnpm 10.34.5 and pnpm/action-setup v6.0.10.
- **Rationale**: pnpm 11 requires Node 22+, while the repository only guarantees Node 20+. The root package has no exact `packageManager`, so the action receives an explicit version. pnpm-store caching is handled by setup-node and does not cache `node_modules`.
- **Rejected**: Node 20 with pnpm 11 (clean-runner failure); changing runtime to Node 22 merely to use pnpm 11.

## 4. Fresh runner boundaries

- **Decision**: Every repository-consuming service job checks out, sets up tools, installs/syncs locked dependencies, and generates/builds what it consumes.
- **Rationale**: `needs` transfers ordering, conclusion, and outputs only. It never transfers checkout state, Prisma Client, shared `dist`, `node_modules`, or `.venv`.
- **Rejected**: dependency artifacts between jobs (size/staleness/complexity) and one monolithic job (removes fail-fast parallelism).

## 5. Executable API/Web commands

- **Decision**: API gate uses direct root ESLint plus filtered TypeScript because the API package lacks lint/typecheck scripts: `pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0`, shared build, Prisma generate, and filtered `tsc --noEmit`. Web uses its existing lint, route-check, typecheck, and build scripts.
- **Rationale**: clean builds require `@shared/types` output and generated Prisma Client. The API/shared lint baseline currently has findings, so remediation is explicit work—not a silently weakened gate.
- **Rejected**: pretend package scripts exist, root-wide lint for every service path, or a permanently red lint gate.

## 6. uv workspace, Python, and Ruff

- **Decision**: Root `pyproject.toml` and root `uv.lock` become canonical; retire `apps/agent/uv.lock`; pin setup-uv executable to 0.12.0, install Python 3.11, sync/run `--locked --package agent`, and pin Ruff 0.16.0 in Agent dev dependencies.
- **Rationale**: Agent is already a root workspace member. A second lock drifts. A pinned setup action alone still installs a moving uv executable unless `version` is given.
- **Rejected**: `uvx ruff` (not locked), per-app locking, or a separate Ruff action.

## 7. Services, migrations, and Redis coverage

- **Decision**: API E2E owns Postgres 16-alpine/Redis 7-alpine with health checks, then shared build → Prisma generate → `prisma migrate deploy` → E2E. Agent tests always own Redis and run a separately selected strict `redis_integration` group with `CI_REQUIRE_REDIS_TESTS=1`.
- **Rationale**: API unit tests are expected to mock infrastructure. Existing Agent integration tests skip if Redis is absent; strict markers and failure-on-unavailable prevent false green.
- **Rejected**: services in a gate job, `prisma db push`, fixed sleeps, or string-grepping pytest summaries as the primary coverage proof.

## 8. Summary semantics

- **Decision**: `ci-status` uses `always()`, needs every prior job, and invokes `scripts/ci/evaluate-ci-status.mjs`. It rejects invalid booleans before evaluating detection/results.
- **Rationale**: failure-only wildcard checks permit cancelled and unexpectedly skipped jobs to false-green. Importing the exact evaluator in tests avoids duplicated truth tables.
- **Rejected**: text-only workflow contracts that can match comments/decoys, or only checking `contains(needs.*.result, 'failure')`.

## 9. Least privilege and checkout safety

- **Decision**: Default to `contents: read`; only detection receives `pull-requests: read`; every checkout sets `persist-credentials: false`.
- **Rationale**: private-repository checkout and the shared evaluator need contents read, but service jobs do not need PR metadata or a long-lived Git credential in an untrusted test process.

## 10. Provider isolation

- **Decision**: Use visible non-production job fixtures and load Node/Python loopback-only network guards only after dependency setup.
- **Rationale**: dummy Duffel/Stripe/Mimo values do not stop hardcoded live URLs. Guards permit local PostgreSQL/Redis and reject public destinations before a missed mock can connect.

## 11. Line endings and images

- **Decision**: Configure global `core.autocrlf=input` before checkout and add `.gitattributes` with LF text rules and binary exclusions. Preserve database/cache image major-line tags as a documented moving-patch exception.
- **Rationale**: `core.autocrlf=input` alone cannot rewrite an existing CRLF blob during Linux checkout. Image digests maximize byte reproducibility but freeze security patches; service health/full suites are the accepted compatibility gate.

## 12. Static validation and rollout

- **Decision**: `detect-changes` runs Node contracts and downloads actionlint v1.7.12 Linux AMD64 with SHA-256 `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8` before path filtering. Prettier validates YAML/Markdown but excludes `.gitattributes`.
- **Rationale**: workflow behavior needs regression-safe checks before first remote run. actionlint validates YAML/expression semantics that the dependency-free contract harness intentionally does not parse fully.

## 13. Performance and rollback

- **Decision**: Measure warm-cache median from five representative full runs; validate cancellation by superseding a PR run; configure branch protection manually after the first successful test PR.
- **Rationale**: average duration is outlier-sensitive. Removing a workflow before its required check strands the branch, so rollback updates the rule first.
