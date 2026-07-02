# Progress Tracker

Update this file after every completed feature. Any AI agent reading this should immediately know what is done, what is in progress, and what is next.

---

## Current Status

**Feature:** Agent Tool-Calling & Data Access (Phase 3)
**Last completed:** Phase 3: PII Stripping, Caching & Auditing (Gateway Polish) (caching and Redis budget limitation check, Amadeus HTTP OAuth2 caching, response parsing, and PII-safe E2E tests).
**Next:** Phase 4: Python Client, Auth Headers & PII Scrubber

---

## Progress by Feature

### [/] Feature: Agent Tool-Calling & Data Access

- [x] T001–T004: Database Schema & Mock Seed Data (Phase 1)
- [x] T005–T011: Agent Gateway REST Endpoints & Authentication (Phase 2)
- [x] T012–T015: PII Stripping, Caching & Auditing (Phase 3)
- [ ] T016–T019: Python Client, Auth Headers & PII Scrubber (Phase 4)
- [ ] T020–T025: LangGraph State Machine & Read-Only Tools (Phase 5)
- [ ] T026–T028: Human-in-the-Loop Gate & SSE Streaming Status (Phase 6)
- [ ] T029–T031: Polish & Cross-Cutting Concerns (Phase 7)

### [x] Feature: Chatbot Agent Service


- [x] Define ChatSession and ChatMessage database schema
- [x] Implement NestJS ChatModule endpoints (CRUD, batch, memory)
- [x] Implement structured audit logs for chat operations
- [x] Implement FastAPI Python Agent Service Scaffold & JWT Auth middleware
- [x] Implement NeMo Guardrails input guardrails
- [x] Implement SSE streaming foundation (Phase 4A)
- [x] Implement LangChain agent completion & persistence (Phase 4B)
- [x] Implement sliding window & summary memory manager
- [x] Implement per-conversation concurrency queue

### [/] Feature: Agent Tool-Calling & Data Access

- [x] Phase 1: Database Schema & Mock Seed Data (Prisma models `TravelerProfile`, `Booking`, and database migrations)
- [ ] Phase 2: Agent Gateway REST Endpoints & Authentication
- [ ] Phase 3: PII Stripping, Caching & Auditing
- [ ] Phase 4: Python Client, Auth Headers & PII Scrubber
- [ ] Phase 5: LangGraph State Machine & Read-Only Tools
- [ ] Phase 6: Human-in-the-Loop Gate & SSE Streaming Status
- [ ] Phase 7: Polish & Cross-Cutting Concerns

### [x] Feature: Monorepo Scaffold & Shared Infrastructure

- [x] Configure workspace `package.json` and workspaces
- [x] Set up strict compiler, linting, and formatting rules
- [x] Define shared domain models, types, and constants

### [x] Feature: Database & Health Endpoint

- [x] Define User and AuditLog schemas in Prisma
- [x] Implement PrismaService database wrapper
- [x] Add `GET /health` verification endpoint with E2E tests

### [x] Feature: User Registration

- [x] Define registration validation contracts
- [x] Build PII-safe logger and AuditLog writer
- [x] Implement AuthService registration with password hashing
- [x] Expose `POST /auth/register` and build Registration UI

### [x] Feature: User Login & Rate-Limited Lockout

- [x] Define login validation contracts
- [x] Set up Redis cache service wrapper
- [x] Implement escalating brute-force lockout logic
- [x] Expose `POST /auth/login` and build Login UI

### [x] Feature: JWT Session Handshake

- [x] Configure Passport JWT Strategy and Guards
- [x] Implement `GET /auth/me` identity endpoint
- [x] Configure NextAuth credentials provider session
- [x] Create apiClient helper and protect `/dashboard` route

### [x] Feature: User Logout

- [x] Expose `POST /auth/logout` audit endpoint
- [x] Implement frontend logout flow and NextAuth clear-session

### [x] Feature: E2E Polish & Verification

- [x] Clean ESLint and type checking globally
- [x] Run concurrency stress tests (100 parallel requests)
- [x] Walkthrough verification and documentation

---

## Decisions Made During Build

- Refactored `PrismaService` to remove the query interceptor facade. This ensures it behaves as a genuine client and reports health status truthfully based on real database availability.
- Implemented clean Jest spies and mock lifecycles directly in `test/health.e2e-spec.ts` to manage database connectivity states in local environments where PostgreSQL and Redis are unavailable.
- Added client warming to E2E setup in `health.e2e-spec.ts` to bypass Express/NestJS router bootstrap cold-start latencies.

---

## Notes

- The test environment does not run PostgreSQL or Redis services locally. E2E tests use Jest spies on the PrismaClient instance to mock database states, keeping the API source code clean and genuine.
