# Data Model: Pull-Request Continuous Integration Pipeline

This feature models a versioned workflow rather than application persistence.

| Entity             | Fields / rules                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowRun`      | `pull_request` only; base `development`; PR-number concurrency; `ubuntu-latest`; default `contents: read`; summary never legitimately skipped. |
| `ChangeSet`        | `api`, `web`, `agent`: exact strings `true` or `false`; anything else fails summary.                                                           |
| `JobResult`        | `success`, `failure`, `cancelled`, or legitimate `skipped`; all jobs have explicit timeout and dependency edges.                               |
| `ServiceContainer` | API E2E: Postgres+Redis; Agent tests: Redis; all local to their job with health checks.                                                        |

| Path class                                                                       | API | Web | Agent |
| -------------------------------------------------------------------------------- | :-: | :-: | :---: |
| `apps/api/**`                                                                    | yes | no  |  no   |
| `apps/web/**`                                                                    | no  | yes |  no   |
| `apps/agent/**`                                                                  | no  | no  |  yes  |
| `packages/shared/**`, workflow, `.gitattributes`, `tests/ci/**`, `scripts/ci/**` | yes | yes |  yes  |
| Root Node/package/TS/ESLint inputs                                               | yes | yes |  no   |
| Root `pyproject.toml`, `uv.lock`                                                 | no  | no  |  yes  |
| docs/spec Markdown                                                               | no  | no  |  no   |

`ci-status` first requires successful detection and valid booleans. A true filter requires all jobs in its chain to succeed; a false filter requires all to be skipped. Any failure/cancellation fails globally.
