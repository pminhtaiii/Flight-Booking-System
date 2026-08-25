---
description: Instructions for building the Flight Booking System
globs: *
alwaysApply: true
---

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## Read Before Anything Else

Read only the context files relevant to the specific task:

- For general understanding or new features: read `context/project-overview.md`.
- For system layout, routing, database, and backend/frontend setup: read `context/architecture.md`.
- For linting, file structure, naming conventions, and code guidelines: read `context/code-standards.md`.
- For third-party library rules and configurations: read `context/library-docs.md`.
- For current progress status: read `context/progress-checker.md`.
- For testing and build/verification workflows (only read when implementing or testing): read `context/workflow.md`.

## Rules That Never Change

- Always use subagents while doing the implementation or code reviews to avoid context rot.
- Always use caveman to save tokens.
- Never use hardcoded hex values or raw Tailwind color classes.
- Update all relevant files in the `context/` folder (such as `context/architecture.md` and `context/progress-checker.md`) after completing any feature to ensure project documentation remains in sync with the codebase.
- Before any third party library — load its installed skill first, then read context/library-docs.md for project-specific rules.

## Agent Operating Rules

### Critical Guidelines

- **Stop on Persistent Failure**: If the same problem persists after one corrective prompt — stop immediately, explain the situation, and ask the user for guidance.
- **Third-Party Libraries**: Before using any third-party library, load its installed skill first, then read `context/library-docs.md` for project-specific rules.
- **Context Folder Access**: Avoid reading all files in the `context/` folder by default. Instead, selectively read only the files relevant to the current task to prevent context bloating:
  - If the task is about architecture, data flow, or NestJS/Next.js setup: read `context/architecture.md`.
  - If the task is about coding conventions, directories, or rules: read `context/code-standards.md`.
  - If the task requires using a third-party library: read `context/library-docs.md`.
  - If the task involves updating status/progress: read `context/progress-checker.md`.
  - If the task is a new feature or high-level request: read `context/project-overview.md`.
  - If the task is implementation, testing, or requires the TDD/E2E workflow: read `context/workflow.md`.
- **Sub-Agent Delegation**: Use specialized sub-agents whenever possible, especially when performing code implementation or code reviews, to optimize task distribution and avoid context bloating.

### E2E Testing Instructions

When the task involves writing, running, or verifying E2E tests:

1. **Locating E2E Tests**:
   - Backend NestJS API E2E tests reside in `apps/api/test/` (e.g., `*.e2e-spec.ts`).
   - Frontend Next.js Playwright UI tests reside in `apps/web/tests/` (e.g., `*.spec.ts`).
2. **Configuration**:
   - Backend E2E uses Jest, configured in `apps/api/test/jest-e2e.json`.
   - Frontend E2E uses Playwright, configured in `apps/web/tests/playwright.config.ts`.
3. **Running E2E Tests**:
   - Backend API E2E tests: run `npm run test:e2e --workspace=apps/api`
   - Frontend Playwright E2E tests: run `npx playwright test --config=apps/web/tests/playwright.config.ts`
   - **Verified T093 workflow (PowerShell)**: use the direct workspace binaries below. The T093 Playwright configuration starts the installed Next CLI directly so Windows does not recurse into an implicit `pnpm install`.
     ```powershell
     docker compose up -d

     Push-Location apps/api
     & '.\node_modules\.bin\prisma.CMD' generate
     $env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
     & '.\node_modules\.bin\prisma.CMD' migrate status
     Pop-Location

     & '.\node_modules\.bin\tsx.CMD' --test `
       apps/web/tests/handoff-bootstrap-acceptance.unit.ts `
       apps/web/tests/handoff-bootstrap.unit.ts `
       apps/web/tests/handoff-form-submission.unit.ts `
       apps/web/tests/handoff-checkout-proxy.unit.ts `
       apps/web/tests/handoff-cookie.unit.mts

     Push-Location apps/api
     & '.\node_modules\.bin\jest.CMD' --runInBand `
       src/chat-handoff/chat-handoff.service.spec.ts `
       src/chat-handoff/booking-handoff.controller.spec.ts
     Pop-Location

     Push-Location apps/web
     $env:NEXTAUTH_SECRET = 'local-build-only'
     $env:NEXTAUTH_URL = 'http://localhost:3000'
     $env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3001'
     $env:NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS = 'true'
     $env:NEXT_PUBLIC_FEATURE_FLAG_CHAT_HANDOFF = 'true'
     $env:NEXT_PUBLIC_AGENT_URL = 'http://127.0.0.1:3002'
     node node_modules/next/dist/bin/next build
     Pop-Location

     $env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
     $env:T093_REAL_FLOW = 'true'
     $env:T093_TEST_TIMEOUT_MS = '600000'
     $env:T093_STREAM_TIMEOUT_MS = '300000'
     $env:T093_BROWSER_TIMEOUT_MS = '120000'
     $env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
     & '.\apps\web\node_modules\.bin\playwright.CMD' test `
       'apps/web/tests/chat-t093-real-flow.spec.ts' `
       --config='apps/web/tests/playwright.config.ts' `
       --reporter=line
     ```
     On Windows, run the full Playwright command in an environment that permits local service access and `taskkill` cleanup of Playwright-owned web-server trees; otherwise the assertions may finish while the runner hangs during teardown. Do not report T093 as passing without the final Playwright exit code `0`.
4. **Mocking & Test Strategy**:
   - Follow the opaque-box verification strategies defined in [TEST_INFRA.md](file:///c:/Booking%20Systems/TEST_INFRA.md).
   - Use time acceleration (`POST /auth/test/reset-lockout` when `NODE_ENV === 'test'`) and database assertions.
5. **Playwright Integration Guidelines**:
   - **Environment Configuration**: Ensure the Playwright webServer environment defines `NEXT_PUBLIC_API_URL` (defaults to `http://127.0.0.1:3001` in `playwright.config.ts`) to prevent compilation crashes during page loads.
   - **Bypass Strategy**: Inject `mock-scenario` cookies (such as `'disruption-detected'`) to bypass backend fetches in Server Components, prompting them to render static mocks directly.
   - **Strict Mode Bypass**: Avoid strict mode failures caused by the default Next.js route announcer (`role="alert"`) by appending `.first()` to alert locators (e.g., `page.getByRole('alert').first()`).
   - **Prevent Login Races**: After submitting registration or login forms, always wait for the browser to load the landing page (e.g., `await expect(page).toHaveURL(/.*localhost:3000\/$/)`) before attempting to navigate to authenticated/protected pages.
   - **Mocking Client Settings**: To verify behavior with missing or altered environment configurations without leaving mutable test hooks in production client bundles, fetch configuration options dynamically from a Next.js Server Route (e.g., `/api/config`) and use Playwright's `page.route` network interception in the test to mock the JSON response.

### Local Development Startup

To run the full stack locally (Next.js frontend, NestJS backend, and Python agent service), follow these instructions:

1. **Docker Services**: Ensure Docker Desktop is active, then start PostgreSQL and Redis:
   ```bash
   docker compose up -d
   ```
2. **Database Setup**: Run migrations and seeding from the workspace root (or using local `prisma` package in `apps/api`):
   ```bash
   pnpm --filter @api/backend exec prisma migrate dev
   pnpm --filter @api/backend exec prisma db seed
   ```
3. **Shared Secrets (.env)**: Ensure both `apps/api/.env` and `apps/agent/.env` contain matching secret configuration variables:
   - `JWT_SECRET` (NextAuth token generation)
   - `AGENT_SERVICE_API_KEY` (Gateway protection)
   - `CLAIM_TOKEN_SECRET` (Agent user claim verification)
4. **Execution**: Start the development servers:
   - **Full Stack (Frontend & Backend concurrently)**: `pnpm dev`
   - **Next.js Frontend only (Port 3000)**: `pnpm --filter @web/frontend dev`
   - **NestJS Backend only (Port 3001)**: `pnpm --filter @api/backend dev`
   - **Python Agent only (Port 3002)**: `uv run uvicorn agent.main:app --port 3002 --app-dir src` inside `apps/agent/`

### CI/CD Pipeline & GitHub Actions Runner Inspection

The repository enforces automated continuous integration via `.github/workflows/ci.yml` on pull requests targeting `development`.

1. **Inspecting Live GitHub Actions Runner Status & Failed Steps**:
   To diagnose CI run failures, inspect runner states, and pinpoint failing step names directly from the shell without requiring `gh` authentication on the public repository, run the following Node one-liner:
   ```powershell
   node -e "
   async function check() {
     const headers = { 'User-Agent': 'CI-Diagnostic-Agent' };
     const runsRes = await fetch('https://api.github.com/repos/pminhtaiii/Flight-Booking-System/actions/runs?per_page=3', { headers });
     const runs = await runsRes.json();
     if (!runs.workflow_runs || runs.workflow_runs.length === 0) { console.log('No runs found'); return; }
     const latestRun = runs.workflow_runs[0];
     console.log('Run ID:', latestRun.id, '| Status:', latestRun.status, '| Conclusion:', latestRun.conclusion, '| SHA:', latestRun.head_sha);
     const jobsRes = await fetch(latestRun.jobs_url, { headers });
     const jobsData = await jobsRes.json();
     for (const job of jobsData.jobs || []) {
       console.log(' - Job:', job.name, '| Status:', job.status, '| Conclusion:', job.conclusion);
       for (const step of job.steps || []) {
         if (step.conclusion === 'failure') {
           console.log('    --> [FAILED STEP #' + step.number + ']:', step.name);
         }
       }
     }
   }
   check().catch(console.error);
   "
   ```

2. **Pre-PR Local Gate Validation Matrix**:
   Always verify the change-aware service chains locally before opening or updating PRs:
   - **Static Contract**: `node --test tests/ci/ci-workflow.contract.test.mjs`
   - **API Gate**: `pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0` && `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit`
   - **API Unit Tests**: `$env:NODE_OPTIONS = "--require=$PWD/tests/ci/node-network-guard.cjs"`; `pnpm --filter @api/backend test -- --runInBand`
   - **Web Gate & Build**: `pnpm --filter @web/frontend lint` && `pnpm --filter @web/frontend typecheck` && `pnpm --filter @web/frontend build`
   - **Agent Gate & Tests**: `$env:UV_CACHE_DIR = "c:\Booking Systems\.t093-uv-cache"`; `uv run --package agent ruff check apps/agent` && `uv run --package agent ruff format --check apps/agent`; with `$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"` run `uv run --package agent pytest apps/agent/tests -m "not redis_integration"`
   - **Branch Protection Requirement**: Only require `ci-status` on branch protection rules for `development`.


<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at specs/017-chatbot-backend-infrastructure/plan.md

<!-- SPECKIT END -->
