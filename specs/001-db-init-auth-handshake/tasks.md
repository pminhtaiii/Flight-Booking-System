# Tasks: Database Initialization & Auth Handshake

**Input**: Design documents from `specs/001-db-init-auth-handshake/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Included as required by the TDD workflow and testing contracts.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Shared package**: `packages/shared/`
- **NestJS backend**: `apps/api/`
- **Next.js frontend**: `apps/web/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic monorepo structure

- [ ] T001 Create monorepo root package.json and pnpm-workspace.yaml in root
- [ ] T002 Create application folders: apps/api, apps/web, packages/shared
- [ ] T003 [P] Configure strict tsconfig in packages/shared/tsconfig.json and build config in packages/shared/package.json
- [ ] T004 [P] Create shared types and constants in packages/shared/src/types/index.ts and packages/shared/src/constants.ts
- [ ] T005 [P] Configure monorepo-wide linting and formatting configuration (Prettier/ESLint) in root

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core application infrastructure that MUST be complete before any user story is implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T006 Initialize apps/api with NestJS dependencies, tsconfig, and monorepo local shared references in apps/api/package.json
- [ ] T007 Initialize apps/web with Next.js App Router dependencies, tsconfig, and tailwind/postcss configurations in apps/web/package.json
- [ ] T008 [P] Create configuration environment templates: apps/api/.env.example and apps/web/.env.example
- [ ] T009 Set up NestJS global validation pipes, exception filter, and main bootstrap in apps/api/src/main.ts and apps/api/src/common/filters/http-exception.filter.ts
- [ ] T010 Set up Next.js root layout with Inter font and global CSS imports in apps/web/app/layout.tsx and apps/web/app/globals.css

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 5 - Database Ready (Priority: P1) 🎯 MVP

**Goal**: Initialize PostgreSQL database schema with User and AuditLog entities, exposing connectivity via NestJS service and health check.

**Independent Test**: Run migrations, verify database tables exist, and GET /health returns up status.

### Implementation for User Story 5

- [x] T011 [P] [US5] Create database models for User and AuditLog in apps/api/prisma/schema.prisma
- [x] T012 [US5] Implement PrismaService wrapper and module in apps/api/src/prisma/prisma.service.ts and apps/api/src/prisma/prisma.module.ts
- [x] T013 [US5] Implement health check controller GET /health in apps/api/src/health/health.controller.ts and apps/api/src/health/health.module.ts
- [x] T014 [US5] Write e2e test for GET /health endpoint verifying response status when database is up/down in apps/api/test/health.e2e-spec.ts

**Checkpoint**: Database layer and health checking are fully operational.

---

## Phase 4: User Story 1 - New User Registration (Priority: P1)

**Goal**: Allow visitors to create an account with email and strong password validation, hashing passwords, logging audit events, and signing them in.

**Independent Test**: Call POST /auth/register with new email/password, verify record creation, hashed password in database, and registration audit event written.

### Tests for User Story 1
> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T015 [P] [US1] Write unit tests for password strength validation and duplicate email check in apps/api/src/auth/auth.service.spec.ts
- [x] T016 [P] [US1] Write backend integration test for registration endpoint POST /auth/register in apps/api/test/auth-register.e2e-spec.ts

### Implementation for User Story 1

- [x] T017 [P] [US1] Define Zod schemas and TypeScript types for user registration requests in packages/shared/src/auth/register.schema.ts
- [x] T018 [P] [US1] Create structured logger in apps/api/src/logging/logging.service.ts ensuring no PII is emitted
- [x] T019 [US1] Create AuditService to write events to the audit log table in apps/api/src/audit/audit.service.ts and apps/api/src/audit/audit.module.ts
- [x] T020 [US1] Implement AuthService.register with password strength checks, email uniqueness check, and hashing in apps/api/src/auth/auth.service.ts
- [x] T021 [US1] Implement controller endpoint POST /auth/register in apps/api/src/auth/auth.controller.ts using validation DTOs
- [x] T022 [US1] Implement frontend registration page at apps/web/app/register/page.tsx with form validation and API call logic

**Checkpoint**: Account creation is fully functional, secure, and audited.

---

## Phase 5: User Story 2 - Returning User Login (Priority: P1)

**Goal**: Authenticate returning users, issue session tokens, and enforce rate-limited escalating lockout.

**Independent Test**: Verify login successes return JWT, login failures trigger lockout after 5 attempts, and lockout duration escalates.

### Tests for User Story 2

- [x] T023 [P] [US2] Write unit tests for rate limiting and lockout escalation logic in apps/api/src/auth/rate-limit/lockout.service.spec.ts
- [x] T024 [P] [US2] Write backend integration tests for POST /auth/login endpoint in apps/api/test/auth-login.e2e-spec.ts

### Implementation for User Story 2

- [x] T025 [P] [US2] Define Zod login schemas and validation rules in packages/shared/src/auth/login.schema.ts
- [x] T026 [P] [US2] Create Redis client service CacheService in apps/api/src/cache/cache.service.ts and apps/api/src/cache/cache.module.ts
- [x] T027 [US2] Implement LockoutService managing rate limits and escalation in apps/api/src/auth/rate-limit/lockout.service.ts
- [x] T028 [US2] Implement AuthService.login validating password hash and generating JWT in apps/api/src/auth/auth.service.ts
- [x] T029 [US2] Implement controller endpoint POST /auth/login in apps/api/src/auth/auth.controller.ts invoking LockoutService
- [x] T030 [US2] Implement frontend login page at apps/web/app/login/page.tsx showing errors and lockout wait times

**Checkpoint**: User authentication and brute force lockout security controls are active.

---

## Phase 6: User Story 3 - Authenticated Session Persistence (Priority: P1)

**Goal**: Support page navigation with active session token validation, NextAuth session wrapper, and server-side redirects.

**Independent Test**: Access protected /dashboard page, verify data loads via GET /auth/me, and confirm unauthorized requests are redirected to /login.

### Tests for User Story 3

- [x] T031 [P] [US3] Write integration tests for JwtAuthGuard and route token validation in apps/api/test/auth-session.e2e-spec.ts
- [x] T032 [P] [US3] Write frontend component tests for auth session loading in apps/web/tests/auth-session.spec.ts

### Implementation for User Story 3

- [x] T033 [P] [US3] Implement JwtStrategy and JwtAuthGuard in apps/api/src/auth/strategies/jwt.strategy.ts and apps/api/src/auth/guards/jwt-auth.guard.ts
- [x] T034 [US3] Implement protected GET /auth/me endpoint in apps/api/src/auth/auth.controller.ts
- [x] T035 [US3] Configure NextAuth.js (Auth.js) credentials provider in apps/web/app/api/auth/[...nextauth]/route.ts and apps/web/lib/auth.ts
- [x] T036 [US3] Implement apiClient wrapper to forward authorization header in apps/web/lib/apiClient.ts
- [x] T037 [US3] Implement protected dashboard page apps/web/app/dashboard/page.tsx fetching user details via GET /auth/me
- [x] T038 [US3] Implement frontend routing middleware to handle session redirects in apps/web/middleware.ts

**Checkpoint**: End-to-end frontend-backend authentication handshake is complete.

---

## Phase 7: User Story 4 - User Logout (Priority: P2)

**Goal**: Clear active session on the client, invalidate token, and log logout events.

**Independent Test**: Click logout, verify redirect to /login, and verify logout audit entry exists.

### Tests for User Story 4

- [x] T039 [US4] Write integration test verifying logout redirects and session removal in apps/web/tests/auth-logout.spec.ts

### Implementation for User Story 4

- [x] T040 [US4] Implement NestJS logout audit endpoint POST /auth/logout in apps/api/src/auth/auth.controller.ts
- [x] T041 [US4] Implement frontend logout component logic and redirects on apps/web/app/dashboard/page.tsx

**Checkpoint**: Users can securely end sessions and clear state.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Formatting, validation, cleanup, and compliance checks

- [ ] T042 Run type checking script across all monorepo workspaces
- [ ] T043 Run linting and formatting across all workspaces
- [ ] T044 Create walkthrough.md summarizing features, files modified, and test verification results
- [ ] T045 Run full E2E flow: register -> dashboard -> logout -> redirect check -> login -> dashboard
- [ ] T046 Run concurrency script attempting 100 failed logins in parallel to confirm Redis/API stability

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories.
- **User Stories (Phases 3 to 7)**: All depend on Foundational completion.
  - Phase 3 (US5: Database Ready) is prerequisite for Phase 4 (US1: Registration).
  - Phase 4 (US1: Registration) is prerequisite for Phase 5 (US2: Login).
  - Phase 5 (US2: Login) is prerequisite for Phase 6 (US3: Session Persistence) and Phase 7 (US4: Logout).
- **Polish (Phase 8)**: Depends on all user stories being complete.

### Within Each User Story

- Tests MUST be written first and fail before implementation code.
- Zod schemas / contract definitions before service implementation.
- Services before controller endpoints.
- Backend endpoints before frontend UI pages.

### Parallel Opportunities

- All Phase 1 marked [P] can run in parallel.
- All Phase 2 marked [P] can run in parallel.
- Registration (US1) schemas, logger, and tests can start in parallel.
- Login (US2) schemas, Redis client, and lockout tests can start in parallel.

---

## Parallel Example: User Story 1

```bash
# Define request schema:
Task: "Define Zod schemas and TypeScript types for user registration requests in packages/shared/src/auth/register.schema.ts"

# Write service unit tests:
Task: "Write unit tests for password strength validation and duplicate email check in apps/api/src/auth/auth.service.spec.ts"
```

---

## Implementation Strategy

### MVP First (User Stories 5 & 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (CRITICAL).
3. Complete Phase 3: User Story 5 (Database Ready).
4. Complete Phase 4: User Story 1 (New User Registration).
5. **STOP and VALIDATE**: Confirm account creation works end-to-end from form to database.

### Incremental Delivery

1. Setup + Foundational -> monorepo framework active.
2. User Story 5 -> database connectivity active.
3. User Story 1 -> registration active (MVP!).
4. User Story 2 -> login active + lockout protection.
5. User Story 3 -> dashboard + routing active.
6. User Story 4 -> logout active.
7. Polish -> type check, lint, and concurrent stress checks.
