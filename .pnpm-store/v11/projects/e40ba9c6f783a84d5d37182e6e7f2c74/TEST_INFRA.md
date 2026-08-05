# E2E Testing Infrastructure

This document describes the testing architecture, configurations, directory layout, test files, and verification strategies for the Flight Booking System's Database Initialization & Authentication Handshake.

---

## 1. Test Architecture

The E2E test suite validates the system via **opaque-box testing**, communicating only through HTTP APIs and web interface UI flows. It is divided into two primary suites:

1. **Backend API Test Suite**: Written using **Jest** and **Supertest** to test NestJS endpoints at `http://localhost:3001`.
2. **Frontend UI Test Suite**: Written using **Playwright** to test browser flows on the Next.js frontend at `http://localhost:3000`.

---

## 2. Directory Layout

The E2E test suite files are organized as follows:

```text
C:\Users\taiph\.gemini\antigravity\worktrees\Booking Systems\complete-teamwork-preview-workflow\
├── apps/
│   ├── api/
│   │   └── test/
│   │       ├── jest-e2e.json
│   │       ├── health.e2e-spec.ts
│   │       ├── auth.e2e-spec.ts
│   │       ├── rate-limit.e2e-spec.ts
│   │       └── audit-log.e2e-spec.ts
│   │
│   └── web/
│       └── tests/
│           ├── playwright.config.ts
│           ├── auth.spec.ts
│           ├── dashboard.spec.ts
│           └── rate-limit.spec.ts
│
├── TEST_INFRA.md (this document)
└── TEST_READY.md (runner commands, coverage summary, and checklists)
```

---

## 3. Test Configurations

### 3.1 Backend API Jest E2E Configuration (`apps/api/test/jest-e2e.json`)

The backend E2E suite runs in a Node environment targeting `.e2e-spec.ts` files, resolving root aliases to the NestJS source folder and local packages.

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": {
    "^.+\\.(t|j)s$": "ts-jest"
  },
  "moduleNameMapper": {
    "^@/(.*)$": "<rootDir>/../src/$1",
    "^@shared/(.*)$": "<rootDir>/../../../packages/shared/src/$1"
  }
}
```

### 3.2 Frontend UI Playwright Configuration (`apps/web/tests/playwright.config.ts`)

Playwright is configured to run tests sequentially (`workers: 1` and `fullyParallel: false`) to avoid concurrent modifications of PostgreSQL or Redis. It includes automated web server orchestration to spin up the NestJS and Next.js processes with dedicated test environments.

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './',
  fullyParallel: false,
  workers: 1,
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    actionTimeout: 10000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm run start --workspace=apps/api',
      url: 'http://localhost:3001/health',
      reuseExistingServer: !process.env.CI,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/test_db',
        REDIS_URL: 'redis://localhost:6379/1',
      },
    },
    {
      command: 'npm run dev --workspace=apps/web',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      env: {
        NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      },
    },
  ],
});
```

---

## 4. Opaque-Box Verification Strategies

To ensure the tests are resilient to internal code structure changes, we use three key opaque-box verification strategies:

### 4.1 Lockout Simulation via IP Headers

Since the test runner runs from a single machine, we simulate distinct clients by passing customized `X-Forwarded-For` headers in HTTP requests. This lets us verify rate limiting partitioning without altering actual network interfaces.

### 4.2 Lockout Reset / Time Acceleration

Exposing a secure HTTP endpoint `POST /auth/test/reset-lockout` (active ONLY when `NODE_ENV === 'test'`) allows tests to instantly flush rate-limiting keys for specific IPs. This prevents tests from sleeping during escalating lockout level checks (60s -> 120s -> 240s -> 480s).

### 4.3 Database-Asserted Audit Log Checks

We use a **Database-Asserted E2E Pattern**. The test runner executes regular auth requests over HTTP but reads directly from the `AuditLog` table using Prisma Client in the assertion phase to verify:

- Log record exists with proper action status.
- Metadata is strictly PII-free (no plaintext passwords, emails, etc.).
- Failed login audit log entries record a hashed version of the client IP instead of the raw IP address.
- Trace/Correlation ID is correctly propagated from the request headers to the audit logs.

---

## 5. Execution Runbook

### 5.1 Run Backend E2E Tests

```bash
npm run test:e2e --workspace=apps/api
```

### 5.2 Run Frontend UI E2E Tests

```bash
npx playwright test --config=apps/web/tests/playwright.config.ts
```
