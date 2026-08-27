# Whole-Stack Smoke and Sanity Test Harness

Authoritative documentation for the zero-dependency whole-stack smoke and sanity test harness.

---

## 1. Architecture & Scope

The smoke and sanity test harness provides an automated, fast, black-box verification gate that starts the complete application stack (PostgreSQL, Redis, NestJS API, Next.js Web, FastAPI Agent, and a local mock server) to validate end-to-end integration and core business flows without calling external third-party providers or running LLM inference.

### Core Design Principles

- **Zero External Test Dependencies**: Built entirely with Node.js built-in modules (`node:test`, `fetch`, `node:http`, and `node:child_process`). No external test runner or assertions library is imported.
- **No Application Internal Imports**: Black-box execution over public HTTP interfaces only. Does not import NestJS, Next.js App Router, FastAPI, Prisma, or Redis clients into test files.
- **Mock Boundary & Air Gap**: Standalone HTTP mock server (`node:http`) intercepts Duffel flight APIs and Stripe payment APIs on loopback. The loopback network guard ensures zero outbound network traffic to real providers.
- **Strict Sequential Lifecycle**:
  1. **Infrastructure / Builds**: PostgreSQL, Redis started via Docker Compose; shared packages and services built; Prisma migrations deployed.
  2. **Process Boot**: Mock server + NestJS API + FastAPI Agent + Next.js Web processes spawned.
  3. **Concurrent Readiness Polling**: All service endpoints probed concurrently every 2 seconds until healthy or bounded deadline reached.
  4. **Smoke Suite**: 8 broad whole-stack checks executed via `node:test` (`<15s`). Smoke failure gates sanity execution immediately.
  5. **Sanity Suite**: Narrow deterministic business flows (search/cache, booking lifecycle, agent-gateway authentication) executed (`<60s`).
  6. **Unconditional Process Cleanup**: Harness child processes and services terminated unconditionally in a `finally` block on both success and failure.

---

## 2. Commands & Execution

### Test Scripts (Harness Roadmap)

The test harness defines four discoverable scripts that are registered in `package.json` incrementally alongside each phase's executable implementation to prevent premature execution or false-positive passes:

- **`pnpm test:smoke:units`**: Introduced in Phase 2 (Foundational Contracts & Test Seams)
- **`pnpm test:smoke`**: Introduced in Phase 3 (User Story 1: Whole-Stack Readiness Gate)
- **`pnpm test:sanity`**: Introduced in Phase 4 (User Story 2: Deterministic Business Flows)
- **`pnpm test:smoke:all`**: Introduced in Phase 5 (User Story 3: Orchestrator Lifecycle)

| Command                 | Underlying Execution                                                                                                              | Description                                                                              | Target Phase |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| `pnpm test:smoke:units` | `node --test tests/smoke/wait-for-ready.unit.test.mjs tests/smoke/mock-server.unit.test.mjs tests/smoke/test-utils.unit.test.mjs` | Runs unit test suites for harness utilities, mock server, and readiness polling          | Phase 2      |
| `pnpm test:smoke`       | `node --test --test-reporter=spec tests/smoke/smoke.test.mjs`                                                                     | Runs 8 whole-stack smoke checks against an already running stack                         | Phase 3      |
| `pnpm test:sanity`      | `node --test --test-reporter=spec tests/smoke/sanity.test.mjs`                                                                    | Runs deterministic business flow sanity checks against an already running stack          | Phase 4      |
| `pnpm test:smoke:all`   | `node scripts/ci/run-smoke-sanity.mjs --mode=local`                                                                               | Runs complete orchestrator lifecycle (boot, ready, smoke, sanity, cleanup) in local mode | Phase 5      |

### Full Orchestrator Scripts

The orchestrator manages the full lifecycle: log directory initialization, process boot, readiness polling, smoke execution, conditional sanity execution, diagnostic capture, and process cleanup.

```bash
# Local mode (requires local Compose and dedicated smoke_test database)
node scripts/ci/run-smoke-sanity.mjs --mode=local

# CI mode (runs inside GitHub Actions runner with ephemeral database)
node scripts/ci/run-smoke-sanity.mjs --mode=ci
```

### Environment-Specific Workflows

#### Local Environment Usage

1. **Start Infrastructure**:
   ```powershell
   docker compose up -d
   ```
2. **Prepare Dedicated Database**:
   Local execution requires a dedicated `smoke_test` database. Reset operations strictly refuse to run against any database name other than `smoke_test`.
   ```powershell
   $env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/smoke_test?schema=public'
   pnpm --filter @api/backend exec prisma generate
   pnpm --filter @api/backend exec prisma migrate deploy
   ```
3. **Build Artifacts**:
   ```powershell
   pnpm build:shared
   pnpm --filter @api/backend build
   pnpm --filter @web/frontend build
   uv sync --locked --package agent
   ```
4. **Execute Complete Lifecycle**:
   ```powershell
   node scripts/ci/run-smoke-sanity.mjs --mode=local
   ```
5. **Run Against Already-Running Stack** (for iterative development):

   ```powershell
   # Run smoke checks
   node --test --test-reporter=spec tests/smoke/smoke.test.mjs

   # Run sanity checks (only if smoke passes)
   node --test --test-reporter=spec tests/smoke/sanity.test.mjs
   ```

6. **Tear Down Infrastructure**:
   ```powershell
   docker compose down
   ```

#### CI Environment Usage

In GitHub Actions (`.github/workflows/ci.yml`), the `smoke-and-sanity` job executes automatically on PRs targeting `development` when application, harness, workflow, or infrastructure paths change:

- Executes against ephemeral runner PostgreSQL and Redis services.
- Runs `node scripts/ci/run-smoke-sanity.mjs --mode=ci`.
- Emits stdout/stderr logs on failure to `.smoke-diagnostics/`.
- Unconditionally stops all background processes.
- Reports status to `ci-status` aggregate gate.

---

## 3. Environment & Non-Production Secrets

Authoritative environment variable contract matching `specs/020-smoke-sanity-tests/contracts/test-harness.md`:

| Variable                | Consumer        | Contract                                                                      |
| ----------------------- | --------------- | ----------------------------------------------------------------------------- |
| `SMOKE_API_URL`         | tests/harness   | Defaults to `http://127.0.0.1:3001/api`                                       |
| `SMOKE_WEB_URL`         | tests/harness   | Defaults to `http://127.0.0.1:3000`                                           |
| `SMOKE_AGENT_URL`       | tests/harness   | Defaults to `http://127.0.0.1:3002`                                           |
| `SMOKE_MOCK_URL`        | tests/harness   | Required loopback URL in CI (e.g., `http://127.0.0.1:4010`)                   |
| `DATABASE_URL`          | API/Prisma      | CI job database or local `smoke_test`; never default development DB for reset |
| `REDIS_URL`             | API/Agent       | Loopback Redis (`redis://127.0.0.1:6379`)                                     |
| `API_URL`               | Web server      | Private NestJS URL (`http://127.0.0.1:3001`)                                  |
| `AGENT_SERVICE_URL`     | API             | Loopback Agent URL (`http://127.0.0.1:3002`)                                  |
| `NESTJS_API_URL`        | Agent           | Loopback NestJS API URL (`http://127.0.0.1:3001/api`)                         |
| `DUFFEL_API_URL`        | API             | Loopback mock in smoke/sanity; real default when absent                       |
| `STRIPE_API_URL`        | API             | Loopback mock in smoke/sanity; Stripe default when absent                     |
| `AGENT_SERVICE_API_KEY` | API/Agent/tests | Shared non-production CI value                                                |
| `CLAIM_TOKEN_SECRET`    | API/Agent/tests | Shared non-production CI value                                                |
| `JWT_SECRET`            | API/Web/Agent   | Shared non-production CI value                                                |

> [!IMPORTANT]
> **Loopback Enforcement & Default Parity**:
>
> - All service and mock URLs supplied to the test harness must parse as valid loopback addresses (`127.0.0.1` or `localhost`).
> - Provider client adapters (`DuffelService`, `StripeService`) retain their production defaults when `DUFFEL_API_URL` or `STRIPE_API_URL` environment variables are omitted.
> - All secret values used across the harness are deterministic, non-production test credentials. Real API keys or production secrets are never used.

---

## 4. Data Isolation Rules

To avoid corrupting persistent local development data and prevent race conditions:

1. **CI Ephemeral Instances**:
   - In GitHub Actions, each job runs against fresh, transient PostgreSQL and Redis service containers that are discarded when the job ends.
2. **Dedicated Local `smoke_test` Database**:
   - Local runs must connect to a separate database strictly named `smoke_test` (e.g., `postgresql://postgres:postgres@127.0.0.1:5432/smoke_test?schema=public`).
   - The default development database (`flight_booking`) must never be used for smoke/sanity runs.
3. **Database Guardrails**:
   - Reset operations and migration scripts MUST parse `DATABASE_URL` and explicitly refuse execution if the database name is not strictly `smoke_test`.
   - Tests generate unique actor emails/identities per run to prevent collision even if a previous run was aborted.

---

## 5. Timing Budgets

The harness enforces strict timing boundaries to guarantee rapid feedback and prevent hanging CI pipelines:

| Phase                    | Timing Budget                 | Polling Interval | Failure Behavior                                                                       |
| ------------------------ | ----------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| **Concurrent Readiness** | $\le$ 120 seconds             | 2 seconds        | Aborts immediately on deadline; dumps per-service last-status diagnostics; skips tests |
| **Smoke Suite**          | < 15 seconds post-readiness   | N/A              | Exits non-zero; skips sanity suite; retains process logs                               |
| **Sanity Suite**         | < 60 seconds post-smoke       | N/A              | Exits non-zero; retains process logs                                                   |
| **Total Test Execution** | < 75 seconds (post-readiness) | N/A              | Strict failure gate on any timeout or uncaught rejection                               |

---

## 6. Diagnostics & Troubleshooting

### Readiness Probes Contract

All probes are executed concurrently every 2000 ms with a single shared 120000 ms deadline:

| Probe               | Endpoint                | Expected Result                                                           | Interpretation & Failure Diagnosis                                                                                                                                           |
| ------------------- | ----------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API Health**      | `GET /api/health`       | HTTP 200, `{"status":"ok","dependencies":{"database":"up","redis":"up"}}` | Verifies NestJS process is alive and connected to Postgres and Redis. Failure indicates DB/Redis container down, incorrect `DATABASE_URL`/`REDIS_URL`, or migration pending. |
| **Web Serving**     | `GET /`                 | HTTP 200, HTML body containing expected landing marker                    | Verifies Next.js App Router server is compiled and listening. Failure indicates build missing (`pnpm build`), Node memory pressure, or port 3000 collision.                  |
| **Web Upstream**    | `GET /health/upstream`  | HTTP 200, sanitized upstream health payload                               | Verifies Next.js server-side can reach NestJS API via private `API_URL`. Failure indicates `API_URL` misconfigured or NestJS network unreachable from Web server.            |
| **Agent Health**    | `GET /health`           | HTTP 200 (status may be `degraded` without Mimo)                          | Verifies FastAPI Agent server is listening. Note: status `degraded` is accepted for direct reachability since external LLM is disabled.                                      |
| **API $\to$ Agent** | `GET /api/health/agent` | HTTP 200                                                                  | Verifies NestJS can reach Agent lightweight no-LLM liveness endpoint. Failure indicates `AGENT_SERVICE_URL` misconfigured or Agent down.                                     |
| **Mock Server**     | `GET /__mock/health`    | HTTP 200                                                                  | Verifies local Duffel/Stripe mock HTTP server is listening on loopback. Failure indicates mock failed to bind port.                                                          |

### Smoke Suite Execution & 8-Check Mapping

The whole-stack smoke suite executes shallow, black-box verification across the running stack without third-party dependencies, internal application imports, or LLM inference.

#### Standalone Execution Command

```bash
# Run standalone smoke suite with spec reporter
pnpm test:smoke

# Equivalent underlying Node.js test command
node --test --test-reporter=spec tests/smoke/smoke.test.mjs
```

#### Execution Timing Budget

- **Budget**: `< 15 seconds` across the entire suite.
- **Enforcement**: Suite-level timeout (`SUITE_TIMEOUT_MS = 15000`) and individual check timeouts. Elapsed duration is measured and asserted after each check and across the entire suite.
- **Diagnostics**: Each check emits diagnostic timing via `t.diagnostic('[smoke] <check> finished in <ms> (suite elapsed: <ms>)')`.
- **Negative Privacy Guarantee**: All check errors are passed through `redactSensitive` before surfacing in reports, ensuring zero tokens, passwords, secrets, or PII can leak into logs.

#### Eight Named Smoke Checks

| #     | Check Name                        | Target Endpoint                                                                                 | HTTP Method               | Expected Success Contract                                                                                                                      | System Boundary Under Test                                                                      |
| ----- | --------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **1** | `API health and dependency shape` | `${SMOKE_API_URL}/health`                                                                       | `GET`                     | HTTP 200, `status === 'ok'`, `dependencies` object containing `database` and `redis` keys                                                      | NestJS API container & dependency health aggregator                                             |
| **2** | `Next.js homepage HTML`           | `${SMOKE_WEB_URL}/`                                                                             | `GET`                     | HTTP 200, HTML body contains landing marker (`wayfinder` or `landing-title`)                                                                   | Next.js Web App Router server-side compilation and rendering                                    |
| **3** | `Agent health HTTP reachability`  | `${SMOKE_AGENT_URL}/health`                                                                     | `GET`                     | HTTP 200, `status === 'ok'` or `status === 'degraded'` (reachability only, no LLM required)                                                    | FastAPI Python Agent HTTP service reachability                                                  |
| **4** | `PostgreSQL readiness`            | `${SMOKE_API_URL}/health`                                                                       | `GET`                     | Derived from API health: `dependencies.database === 'up'`                                                                                      | NestJS Prisma connection pool & PostgreSQL container query readiness                            |
| **5** | `Redis readiness`                 | `${SMOKE_API_URL}/health`                                                                       | `GET`                     | Derived from API health: `dependencies.redis === 'up'`                                                                                         | NestJS CacheService ping & Redis container reachability                                         |
| **6** | `Web upstream reachability`       | `${SMOKE_WEB_URL}/health/upstream`                                                              | `GET`                     | HTTP 200, `{ "status": "ok", "upstream": "up" }`                                                                                               | Next.js server-side to NestJS API upstream connectivity via private `API_URL`                   |
| **7** | `API-to-Agent reachability`       | `${SMOKE_API_URL}/health/agent`                                                                 | `GET`                     | HTTP 200, `{ "status": "ok" }`                                                                                                                 | NestJS AgentHealthService to FastAPI Agent lightweight no-LLM `/health/live` probe              |
| **8** | `Authentication round-trip`       | `${SMOKE_API_URL}/auth/register`<br>`${SMOKE_API_URL}/auth/login`<br>`${SMOKE_API_URL}/auth/me` | `POST`<br>`POST`<br>`GET` | Register returns 201 with JWT and unique user; Login returns 200 with JWT; Authenticated `GET /auth/me` returns matching user `id` and `email` | Database user persistence, bcrypt password hashing, JWT signing and verification, and AuthGuard |

#### Smoke Check Failure Diagnostics & Troubleshooting

| Failing Check                     | Likely Root Cause                                                                                    | Diagnostic Steps & Remediation                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Check 1: API health**           | NestJS not listening, wrong `SMOKE_API_URL`, or fatal startup exception                              | Check `.smoke-diagnostics/api.log` or console output. Verify port 3001 is listening (`netstat -ano \| findstr :3001`). Verify `DATABASE_URL` and `REDIS_URL`.          |
| **Check 2: Homepage HTML**        | Next.js not built (`pnpm --filter @web/frontend build`), port 3000 down, or error boundary triggered | Check `.smoke-diagnostics/web.log`. Verify `apps/web/.next` exists. Verify Next.js server is bound to port 3000.                                                       |
| **Check 3: Agent health**         | FastAPI Agent process down or wrong `SMOKE_AGENT_URL`                                                | Check `.smoke-diagnostics/agent.log`. Verify Python environment (`uv sync`) and uvicorn process listening on port 3002.                                                |
| **Check 4: PostgreSQL readiness** | PostgreSQL container unready, down, or migrations not deployed                                       | Run `docker compose ps` to verify container `flight-postgres` is healthy. Run `pnpm --filter @api/backend exec prisma migrate status` to confirm migrations.           |
| **Check 5: Redis readiness**      | Redis container down or unreachable on port 6379                                                     | Verify `docker compose ps` for `flight-redis`. Check `redis-cli ping` or verify `REDIS_URL=redis://127.0.0.1:6379`.                                                    |
| **Check 6: Web upstream**         | Next.js cannot reach NestJS API via private `API_URL`                                                | Verify `API_URL` environment variable passed to Next.js (defaults to `http://127.0.0.1:3001`). Ensure NestJS `/api/health/ping` responds 200.                          |
| **Check 7: API-to-Agent**         | NestJS cannot reach Agent `/health/live` endpoint                                                    | Verify `AGENT_SERVICE_URL` (defaults to `http://127.0.0.1:3002`). Test direct reachability of `http://127.0.0.1:3002/health/live`.                                     |
| **Check 8: Auth round-trip**      | Prisma user table write failure, duplicate email, lockout rate limit, or invalid JWT signature       | Verify unique test actor creation (`createUniqueTestActor`). Reset lockout via `POST /api/auth/test/reset-lockout` if in test environment. Ensure `JWT_SECRET` is set. |

### Diagnostic Log Inspection (`.smoke-diagnostics/`)

When running via `run-smoke-sanity.mjs`, all process output and diagnostic dumps are written to `.smoke-diagnostics/`:

- `mock.log`: Mock server request routing, validation warnings, and safe request logs.
- `api.log`: NestJS API stdout/stderr logs.
- `agent.log`: FastAPI Agent stdout/stderr logs.
- `web.log`: Next.js server stdout/stderr logs.
- `readiness.json`: Final probe status snapshot with last response status and elapsed time for each service.

> [!CAUTION]
> **PII and Secret Redaction**:
> Log outputs in `.smoke-diagnostics/` strictly redact authorization headers, bearer tokens, passwords, credit card numbers, and passenger PII. Mock server control routes (`/__mock/requests`) never record or return request bodies or authorization headers.

### Common Startup & Readiness Failures

1. **Port Conflicts**:
   - Ports `3000` (Web), `3001` (API), `3002` (Agent), `5432` (Postgres), `6379` (Redis), or `4010` (Mock) are already bound by background processes.
   - _Fix_: Check running processes (`netstat -ano | findstr :3000` or `Get-Process`) and terminate conflicting tasks.
2. **Missing Build Artifacts**:
   - `apps/web/.next` or `apps/api/dist` missing before running orchestrator in CI or local mode.
   - _Fix_: Execute `pnpm build:shared`, `pnpm --filter @api/backend build`, and `pnpm --filter @web/frontend build`.
3. **Database Unready / Migration Error**:
   - Prisma Client out of sync with migrations or database unreachable.
   - _Fix_: Run `pnpm --filter @api/backend exec prisma generate` and `pnpm --filter @api/backend exec prisma migrate deploy`.
4. **Premature Child Process Termination**:
   - If any service process exits unexpectedly during readiness polling, the orchestrator immediately halts polling, logs the exit code and stderr tail, and exits with a non-zero status.

### Cleanup Behavior

- All child processes (mock, API, agent, web) are tracked by PID.
- Process cleanup is registered on `SIGINT`, `SIGTERM`, `exit`, and uncaught rejections.
- On Windows and Unix, process trees are terminated gracefully first (`SIGTERM`), escalating to forced termination (`SIGKILL` / `taskkill /F /T`) if processes do not exit within 5 seconds.
- The orchestrator guarantees that no orphaned mock or application servers remain running after a test run concludes or fails.
