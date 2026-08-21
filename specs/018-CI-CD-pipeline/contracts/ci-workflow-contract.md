# CI Workflow Contract

## Event, permissions, and graph

- Event: `pull_request` with base branch `development`; no push, target, dispatch, schedule, deployment, or release triggers.
- Default permission: `contents: read`; only `detect-changes` adds `pull-requests: read`; every checkout has `persist-credentials: false`.
- Stable graph: detection → API gate → API unit/E2E; detection → Web gate → Web build; detection → Agent gate → Agent tests; `ci-status` needs all eight predecessors and has `if: ${{ always() }}`.

## Immutable registry

| Action              | Required SHA                                                  |
| ------------------- | ------------------------------------------------------------- |
| checkout v7.0.1     | `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`   |
| setup-node v7.0.0   | `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` |
| pnpm setup v6.0.10  | `pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86`  |
| paths-filter v4.0.1 | `dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d` |
| setup-uv v9.0.0     | `astral-sh/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9` |

Every `uses:` reference is introduced already pinned and annotated with its release.

## Summary contract

The workflow passes fixed detection outputs and results to `node scripts/ci/evaluate-ci-status.mjs`; tests import the same evaluator. It fails on invalid/missing booleans, failed detection, failure/cancellation, a relevant job other than success, or an irrelevant job other than skipped. It succeeds only when all applicable chains satisfy those rules.

## Service and boundary contract

- API E2E: healthy `postgres:16-alpine` and `redis:7-alpine`; install → shared build → Prisma generate → migrate deploy → E2E.
- Agent tests: healthy Redis; strict `redis_integration` group is non-empty and runs under `CI_REQUIRE_REDIS_TESTS=1`, turning unavailable-infrastructure skips into failures.
- Node test/build processes preload `tests/ci/node-network-guard.cjs`; Agent tests expose `tests/ci/python/sitecustomize.py` through `PYTHONPATH`. Both allow only local service traffic.
