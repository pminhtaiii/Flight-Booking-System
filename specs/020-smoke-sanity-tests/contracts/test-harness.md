# Smoke/Sanity Harness Contract

## Commands

```text
node scripts/ci/run-smoke-sanity.mjs --mode=ci
node scripts/ci/run-smoke-sanity.mjs --mode=local
node --test --test-reporter=spec tests/smoke/smoke.test.mjs
node --test --test-reporter=spec tests/smoke/sanity.test.mjs
```

The orchestrator exits 0 only when readiness, smoke, sanity, and cleanup complete successfully. Readiness failure, smoke failure, sanity failure, child-process exit, or cleanup failure produces a non-zero result. Smoke failure must prevent sanity from starting.

## Environment

| Variable | Consumer | Contract |
|---|---|---|
| `SMOKE_API_URL` | tests/harness | Defaults to `http://127.0.0.1:3001/api` |
| `SMOKE_WEB_URL` | tests/harness | Defaults to `http://127.0.0.1:3000` |
| `SMOKE_AGENT_URL` | tests/harness | Defaults to `http://127.0.0.1:3002` |
| `SMOKE_MOCK_URL` | tests/harness | Required loopback URL in CI |
| `DATABASE_URL` | API/Prisma | CI job database or local `smoke_test`; never default development DB for reset |
| `REDIS_URL` | API/Agent | Loopback Redis |
| `API_URL` | Web server | Private NestJS URL |
| `AGENT_SERVICE_URL` | API | Loopback Agent URL |
| `NESTJS_API_URL` | Agent | Loopback NestJS API URL |
| `DUFFEL_API_URL` | API | Loopback mock in smoke/sanity; real default when absent |
| `STRIPE_API_URL` | API | Loopback mock in smoke/sanity; Stripe default when absent |
| `AGENT_SERVICE_API_KEY` | API/Agent/tests | Shared non-production CI value |
| `CLAIM_TOKEN_SECRET` | API/Agent/tests | Shared non-production CI value |
| `JWT_SECRET` | API/Web/Agent | Shared non-production CI value |

All local URLs supplied to the harness must parse as loopback. The provider wrappers retain their existing production defaults when override variables are absent.

## Readiness probes

| Probe | Success contract |
|---|---|
| API | `GET /api/health` → 200, `status=ok`, database/redis `up` |
| Web | `GET /` → 200 and expected landing HTML marker |
| Web upstream | `GET /health/upstream` → 200 and sanitized API-up body |
| Agent | `GET /health` → 200; detailed status may be `degraded` without Mimo |
| API→Agent | `GET /api/health/agent` → 200 through no-LLM Agent liveness |
| Mock | `GET /__mock/health` → 200 |

Probes run concurrently every 2000 ms with one 120000 ms deadline.

## Mock control API

- `GET /__mock/health`: readiness only.
- `POST /__mock/reset`: reset counters and safe request records.
- `GET /__mock/requests`: return route keys, counts, timestamps, methods, paths, and statuses only.

Control endpoints bind to loopback. They never return request bodies, authorization headers, tokens, passenger data, or payment fields.

## Test ordering

```text
infrastructure/migrations/builds
  → mock + API + Agent + Web
  → parallel readiness
  → smoke.test.mjs
  → sanity.test.mjs
  → cleanup (always)
```

## CI aggregate status

- If no API, Web, or Agent domain changed: `smoke-and-sanity` must be skipped.
- If at least one domain changed and its applicable terminal prerequisites succeeded: job must run and succeed.
- A `docker-compose.yml` change must set API, Web, and Agent change outputs to true, so an infrastructure-only pull request cannot take the all-domains-false skip path.
- Any applicable prerequisite failure/cancellation blocks the job and makes `ci-status` fail.
- If the job was expected to run, `skipped`, `cancelled`, or `failure` makes `ci-status` fail.
