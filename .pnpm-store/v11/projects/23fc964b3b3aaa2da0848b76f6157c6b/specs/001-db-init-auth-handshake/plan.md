# Implementation Plan: Database Initialization & Auth Handshake

**Branch**: `001-db-init-auth-handshake` | **Date**: 2026-06-24 | **Spec**: `specs/001-db-init-auth-handshake/spec.md`

**Input**: Feature specification from `specs/001-db-init-auth-handshake/spec.md`

## Summary

Initialize the Flight Booking System application foundation with a PostgreSQL-backed NestJS auth backend, a Next.js App Router frontend auth handshake, and a shared TypeScript contract layer. The feature delivers registration, login, logout, 24-hour JWT session validation, escalating auth lockout, audit logging without PII, database migrations, and health checks. Because the repository currently has no application source code, this plan also includes the minimal monorepo scaffold needed to make the first feature runnable and testable.

## Technical Context

**Language/Version**: TypeScript strict mode on Node.js LTS.

**Primary Dependencies**: NestJS, Next.js App Router, Prisma, PostgreSQL, Redis via `ioredis`, NextAuth.js/Auth.js, Passport JWT, `class-validator`, `class-transformer`, `zod`, `bcrypt` or Node-compatible password hashing package selected during implementation, Tailwind v4, shadcn/ui, lucide-react.

**Storage**: PostgreSQL for users and audit logs; Redis for failed-auth counters and escalating lockout state; JWT for stateless 24-hour sessions.

**Testing**: Unit tests for validators/services/guards, NestJS integration tests for controller endpoints, frontend component/route tests for auth page behavior, E2E tests for register/login/logout/protected-dashboard flows because this feature touches database, auth, and cross-app user-facing flows.

**Target Platform**: Local development and deployable web application composed of a NestJS API service and a Next.js frontend service.

**Project Type**: Web application with separate frontend, backend, and shared packages.

**Performance Goals**: Registration completes in under 30 seconds, login completes in under 15 seconds, protected endpoint rejection is deterministic, health reflects database status within 5 seconds, and 100 concurrent login attempts complete without service errors or degraded response behavior.

**Constraints**: No plaintext passwords; no PII or credentials in logs; all protected endpoints require JWT validation; auth rate limiting triggers after 5 failed attempts per 15-minute IP window; lockout duration doubles from 1 to 8 minutes and resets after successful login; card/payment/booking concerns remain out of scope; AI agents are not involved.

**Scale/Scope**: First production foundation slice for user accounts only. Flights, bookings, payments, profile preferences, hotels, dining, AI agents, and full dashboard analytics are deferred.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

- **Flight-First Architecture**: PASS. The feature enables future flight workflows without adding hotel, dining, or itinerary scope.
- **Deterministic Transaction Boundary**: PASS. Auth and database setup are deterministic services. AI is explicitly out of scope.
- **API Budget Discipline**: PASS. No Amadeus calls are introduced. The plan establishes Redis rate-limit patterns that later Amadeus integrations can reuse.
- **Observability & Operational Visibility**: PASS. Health checks, structured logs, audit logs, and trace/correlation IDs are part of this feature's acceptance surface.
- **Incremental Delivery**: PASS. The feature is a shippable vertical slice: schema, API, frontend handshake, protected dashboard stub, and tests.
- **Security Requirements**: PASS with implementation obligations. Password hashing, JWT expiry, lockout, PII-safe logs, input validation, and protected endpoints are mandatory.

## Project Structure

### Documentation (this feature)

```text
specs/001-db-init-auth-handshake/
|-- spec.md
|-- plan.md
|-- research.md
|-- data-model.md
|-- quickstart.md
|-- contracts/
|   |-- auth-api.openapi.yaml
|   |-- frontend-auth-contract.md
|   `-- environment.md
`-- tasks.md
```

### Source Code (repository root)

```text
apps/
|-- api/
|   |-- package.json
|   |-- prisma/
|   |   |-- schema.prisma
|   |   `-- migrations/
|   |-- src/
|   |   |-- main.ts
|   |   |-- app.module.ts
|   |   |-- auth/
|   |   |   |-- auth.module.ts
|   |   |   |-- auth.controller.ts
|   |   |   |-- auth.service.ts
|   |   |   |-- dto/
|   |   |   |-- guards/
|   |   |   |-- strategies/
|   |   |   `-- rate-limit/
|   |   |-- prisma/
|   |   |-- cache/
|   |   |-- health/
|   |   |-- logging/
|   |   `-- audit/
|   `-- test/
|       |-- auth.e2e-spec.ts
|       `-- health.e2e-spec.ts
|-- web/
|   |-- package.json
|   |-- app/
|   |   |-- layout.tsx
|   |   |-- page.tsx
|   |   |-- login/
|   |   |-- register/
|   |   |-- dashboard/
|   |   `-- api/auth/[...nextauth]/route.ts
|   |-- components/
|   |   |-- auth/
|   |   `-- ui/
|   |-- lib/
|   |   |-- apiClient.ts
|   |   `-- auth.ts
|   `-- tests/
`-- packages/
    `-- shared/
        |-- package.json
        `-- src/
            |-- auth/
            |-- constants.ts
            `-- types/
```

**Structure Decision**: Use a minimal monorepo with `apps/api`, `apps/web`, and `packages/shared`. This matches the architecture requirement for separate NestJS and Next.js applications while keeping shared auth contracts and constants in one package.

## Implementation Approach

### Phase A: Repository and Runtime Scaffold

Create the monorepo foundation needed for the feature:

- Root workspace configuration for the two apps and shared package.
- Strict TypeScript configs with path aliases for `@/` inside each app and `@shared/*` across apps.
- Environment templates for API, frontend, PostgreSQL, Redis, JWT, and NextAuth secrets.
- Next.js App Router shell with Inter loaded via `next/font/google`, Tailwind v4 tokens, and navbar-ready layout.
- NestJS bootstrap with global `ValidationPipe`, global exception filter, structured logging base, and CORS configured for the frontend origin.

### Phase B: Database and Shared Domain Contracts

Implement Prisma schema and migrations for:

- `User` with unique normalized email, hashed password, account status, timestamps, and last login timestamp.
- `AuditLog` with user reference when available, action, resource metadata, trace/correlation IDs, and no PII.

Add shared zod schemas/types for auth requests and responses so the frontend and backend do not redefine shapes locally.

### Phase C: Backend Auth Service

Build a NestJS `auth` module:

- `POST /auth/register`: validates email/password, normalizes email, hashes password, handles duplicate-email safely, creates user and audit log, returns JWT session.
- `POST /auth/login`: validates credentials, applies failed-attempt lockout, returns generic invalid-credentials errors, resets lockout on success, updates last login, writes audit log, returns JWT session.
- `POST /auth/logout`: protected endpoint that writes logout audit event and lets the frontend clear stateless session data.
- `GET /auth/me`: protected endpoint that returns the authenticated user identity needed by the frontend shell.
- JWT strategy and `JwtAuthGuard` for protected endpoints.
- `GET /health`: reports API and PostgreSQL readiness/liveness with structured JSON.

### Phase D: Rate Limit and Lockout

Use Redis for auth abuse controls:

- Failed attempt key: `auth:failed:{ipHash}` with a 15-minute TTL.
- Lockout key: `auth:lockout:{ipHash}` with the active lockout TTL.
- Escalation key: `auth:lockout-level:{ipHash}` to calculate 1, 2, 4, then 8 minutes.
- Reset failed-attempt and escalation state after successful login.
- Hash IP addresses before using them in logs or Redis metadata to avoid storing raw network identifiers unnecessarily.

### Phase E: Frontend Auth Handshake

Build the first usable UI slice:

- `/register` and `/login` pages with email/password forms, validation messaging, loading/error states, and redirect to `/dashboard` on success.
- NextAuth credentials provider or equivalent App Router-compatible handler that calls the NestJS auth endpoints and stores the backend JWT in the frontend session.
- Server-side session guard for `/dashboard`; unauthenticated users redirect to `/login`.
- Authenticated users visiting `/login` or `/register` redirect to `/dashboard`.
- Logout action clears the frontend session and calls the backend logout endpoint when a token is available.
- Dashboard stub proves the handshake by calling `GET /auth/me` through the NestJS backend.

### Phase F: Verification and Quality Gates

Test coverage must include:

- Password policy validation for all required character classes and minimum length.
- Duplicate-email registration returns safe user-facing error without account enumeration detail.
- Passwords are hashed and plaintext is never persisted.
- JWT expiry is set to 24 hours and expired/tampered tokens are rejected.
- Protected endpoint rejects missing/invalid tokens.
- Failed login attempts trigger lockout after 5 failures in 15 minutes.
- Lockout escalates 1 -> 2 -> 4 -> 8 minutes and resets after successful login.
- Audit logs are written for registration, login, logout, and failed attempts without PII or plaintext credentials.
- Health check reports database status and degrades when the database is unavailable.
- E2E flow: register -> dashboard -> logout -> protected redirect -> login -> dashboard.
- Concurrency check for 100 simultaneous failed login attempts without uncaught errors.

## Complexity Tracking

| Violation                                           | Why Needed                                                                                                             | Simpler Alternative Rejected Because                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo with separate API, web, and shared package | The architecture mandates separate NestJS backend, Next.js frontend, and shared TypeScript types.                      | A single app would violate the frontend/backend boundary and make future flight, booking, and payment services harder to isolate.                                 |
| Redis in first feature                              | Required for auth rate limiting and escalating lockout without coupling abuse-control state to stateless JWT sessions. | In-memory counters would fail across restarts and multiple instances; database counters would add transactional load and cleanup complexity to the auth hot path. |

## Phase 0 Research Outcomes

See `specs/001-db-init-auth-handshake/research.md`.

Resolved decisions:

- Use JWT stateless sessions with 24-hour expiry.
- Use PostgreSQL/Prisma for user and audit persistence.
- Use Redis for lockout/rate-limit state.
- Keep frontend API interaction through NestJS, with NextAuth limited to auth session orchestration.
- Bootstrap the minimal monorepo during this feature because no application source currently exists.

## Phase 1 Design Outputs

- Data model: `specs/001-db-init-auth-handshake/data-model.md`
- API contract: `specs/001-db-init-auth-handshake/contracts/auth-api.openapi.yaml`
- Frontend contract: `specs/001-db-init-auth-handshake/contracts/frontend-auth-contract.md`
- Environment contract: `specs/001-db-init-auth-handshake/contracts/environment.md`
- Validation guide: `specs/001-db-init-auth-handshake/quickstart.md`

## Post-Design Constitution Check

- **Flight-First Architecture**: PASS. Auth unlocks future flight flows; no non-flight scope added.
- **Deterministic Transaction Boundary**: PASS. No AI code path exists in auth.
- **API Budget Discipline**: PASS. No external flight API calls; Redis budget patterns align with later Amadeus needs.
- **Observability & Operational Visibility**: PASS. Health, audit logs, structured logging, and trace propagation are designed in.
- **Incremental Delivery**: PASS. The plan yields a runnable, testable auth slice.
- **Security Requirements**: PASS if tasks preserve hashing, validation, JWT expiry, lockout, PII-safe logs, and protected endpoint guards.

## Risks and Mitigations

- **Next.js version-specific API drift**: Before implementation, read the installed Next.js docs in `node_modules/next/dist/docs/` after dependencies are installed, per AGENTS.md.
- **Password hashing package choice**: Select a Node-compatible package during implementation and update approved dependencies if the chosen package is not already listed.
- **Spec status is Draft**: Treat requirements and clarifications as implementation input, but user approval should occur before task generation if the project requires formal spec signoff.
- **Missing `context/progress-tracker.md`**: Add or restore this file during implementation planning/tasks so AGENTS.md's feature-update rule has a target.

## Next Step

Run plan-review convergence on this plan. After convergence has no unresolved HIGH concerns, generate `tasks.md` with `/speckit-tasks`.
