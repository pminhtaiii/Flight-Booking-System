# Research: Database Initialization & Auth Handshake

## Decision: Bootstrap a minimal monorepo in this feature

**Rationale**: The architecture document states that no application source code has been implemented yet, while this feature requires a working backend/frontend handshake. A minimal `apps/api`, `apps/web`, and `packages/shared` layout is the smallest structure that satisfies the existing architecture and shared-type requirements.

**Alternatives considered**:

- Single Next.js application with route handlers: rejected because project standards say Next.js is frontend-only except for auth/webhook routes.
- Backend-only auth feature: rejected because the feature explicitly includes the frontend/backend handshake and protected-page behavior.

## Decision: Use NestJS for auth endpoints and guards

**Rationale**: NestJS is the project-standard backend framework. The feature needs DTO validation, guards, injectable services, health checks, and modular boundaries, all of which match the documented NestJS conventions.

**Alternatives considered**:

- Express-only API: rejected because it diverges from the selected architecture and would require recreating conventions NestJS already provides.
- Next.js API routes for auth: rejected because business logic must live in the NestJS backend.

## Decision: Use Prisma migrations over ad hoc schema setup

**Rationale**: The constitution and code standards require version-controlled database migrations. Prisma gives repeatable schema creation, type-safe access, and a standard migration path for future booking/payment tables.

**Alternatives considered**:

- Raw SQL migrations only: possible, but less aligned with the selected ORM and shared TypeScript model.
- Runtime schema creation: rejected because it is not reviewable or suitable for production.

## Decision: Use stateless JWT sessions with 24-hour expiry

**Rationale**: The feature spec explicitly assumes JWT with a 24-hour session lifetime. Stateless JWTs fit the v1 requirement of no server-side session storage and can be validated independently by NestJS protected endpoints.

**Alternatives considered**:

- Database-backed sessions: rejected for v1 because the spec assumes stateless JWT and no server-side session storage.
- Refresh-token rotation: deferred because the first feature only requires a 24-hour session token and basic logout via client-side invalidation.

## Decision: Store auth abuse-control state in Redis

**Rationale**: Redis supports atomic counters, TTLs, and fast lockout checks for failed login limits. It also matches the architecture's Redis role for rate limiting.

**Alternatives considered**:

- In-memory counters: rejected because they reset on restart and fail with multiple API instances.
- PostgreSQL counters: rejected for the hot path because TTL cleanup and concurrent increments are simpler and lower-risk in Redis.

## Decision: Use generic credential errors for login and duplicate registration

**Rationale**: The spec requires not revealing whether an account exists. Both duplicate-registration and invalid-login responses should be user-friendly but safe from account enumeration.

**Alternatives considered**:

- Specific "email exists" API error: rejected because it leaks account presence even if convenient.

## Decision: Audit auth events without PII

**Rationale**: The constitution requires audit logging and forbids PII in logs. Audit rows should reference `userId` when known and include safe event metadata such as action, result, trace ID, and an IP hash rather than raw email or password values.

**Alternatives considered**:

- Storing email in audit metadata: rejected because email is PII and unnecessary for auth event tracing when `userId` and correlation IDs exist.

## Decision: Add an authenticated dashboard stub

**Rationale**: The feature's independent tests require proving that a logged-in frontend sends a token to the backend and receives protected data. A dashboard stub is enough to validate the handshake without building unrelated analytics.

**Alternatives considered**:

- Full dashboard analytics: rejected as scope creep and outside the first feature.
