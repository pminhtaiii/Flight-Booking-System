# Quickstart: Database Initialization & Auth Handshake

This guide validates the first feature after implementation. It is intentionally written as a runbook, not implementation code.

## Prerequisites

- Node.js LTS installed.
- PostgreSQL available and reachable through `DATABASE_URL`.
- Redis available and reachable through `REDIS_URL`.
- API environment configured with `JWT_SECRET`, `NEXTAUTH_SECRET`, and backend URLs.
- Web environment configured with `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, and `NEXT_PUBLIC_API_URL`.

## Setup

1. Install dependencies from the repository root.
2. Copy environment examples for `apps/api` and `apps/web`.
3. Start PostgreSQL and Redis.
4. Run Prisma migrations for `apps/api`.
5. Start the NestJS API and Next.js frontend.

## Validation Scenarios

### Scenario 1: Fresh Migration

Run the database migration against an empty database.

Expected result:

- User and audit log tables are created.
- Unique email index exists.
- Re-running the migration command does not error.

### Scenario 2: Health Check

Call `GET /health` on the API.

Expected result:

- Response status is successful when PostgreSQL is reachable.
- Response body reports API status and database dependency status.
- When PostgreSQL is unavailable, health reports degraded/down rather than crashing the process.

### Scenario 3: Registration

Open `/register`, submit a valid email and a password that satisfies the policy.

Expected result:

- User account is created.
- Password is stored only as a hash.
- Registration audit event is written without PII.
- User is signed in and redirected to `/dashboard`.

### Scenario 4: Duplicate Registration

Submit the same registration details again.

Expected result:

- No second user is created.
- The UI shows a clear safe error.
- The API response does not expose account-enumeration details.

### Scenario 5: Login

Open `/login`, submit valid credentials for an existing user.

Expected result:

- API returns a JWT-backed session valid for 24 hours.
- Frontend stores the session through the auth layer.
- User is redirected to `/dashboard`.
- `GET /auth/me` succeeds from the dashboard.

### Scenario 6: Protected Endpoint Rejection

Call a protected endpoint without a token, with a malformed token, and with an expired token.

Expected result:

- All requests are rejected with unauthorized responses.
- The API does not leak token parsing details.
- Token rejection audit entries contain no raw token.

### Scenario 7: Logout

Click logout from an authenticated state.

Expected result:

- Frontend session is cleared.
- Backend logout audit event is written when a valid token is available.
- User is redirected to `/login`.
- Revisiting `/dashboard` redirects to `/login`.

### Scenario 8: Rate Limit and Escalating Lockout

Submit five failed login attempts from the same IP within 15 minutes, then continue attempting login.

Expected result:

- The sixth attempt is blocked by lockout.
- Lockout durations escalate 1, 2, 4, then 8 minutes on subsequent violations.
- A successful login resets the failed-attempt and lockout escalation state.
- Lockout responses tell the user how long to wait without exposing account details.

### Scenario 9: Concurrency

Run a 100-attempt concurrent login test against invalid credentials.

Expected result:

- API returns controlled invalid/lockout responses.
- No unhandled exceptions occur.
- Redis counters remain consistent.

## Required Test Commands

Implementation should provide package scripts for:

- API unit tests.
- API integration tests.
- Web auth tests.
- Full E2E auth handshake tests.
- Type checking for all workspaces.
- Linting for all workspaces.

## Done When

- All automated tests pass.
- Manual quickstart scenarios succeed.
- `context/progress-tracker.md` exists and is updated with the feature status.
- Plan review convergence reports no unresolved HIGH concerns.
