# Progress Tracker

Update this file after every completed feature. Any AI agent reading this should immediately know what is done, what is in progress, and what is next.

---

### Current Status

**Feature:** Map Integration (Fully Completed)
**Last completed:** Phase 7: Polish & E2E Validation (linter/type-check verification, ignore files check, Playwright E2E tests, and quickstart scenario verification).
**Next:** Done!

---

## Progress by Feature

### [x] Feature: LLM Output Guardrails

- [x] Phase 1: Design & Contracts
- [x] Phase 2: Configuration & PII Detection — Foundation
- [x] Phase 3: Sentence-Boundary Chunking — Token Accumulation
- [x] Phase 4: NeMo Output Rail — Safety Classification
- [x] Phase 5: Output Guardrail Pipeline — Orchestration
- [x] Phase 6: SSE Integration — Wire Pipeline Into Streaming
- [x] Phase 7: Hard Stop & Partial Persistence — Failure Handling
- [x] Phase 8: Pipeline Parallelism — Latency Optimization
- [x] Phase 9: Observability & Logging — Structured Telemetry
- [x] Phase 10: E2E Testing & Validation — Final Verification

### [/] Feature: Agent Tool-Calling & Data Access

- [x] T001–T004: Database Schema & Mock Seed Data (Phase 1)
- [x] T005–T011: Agent Gateway REST Endpoints & Authentication (Phase 2)
- [x] T012–T015: PII Stripping, Caching & Auditing (Phase 3)
- [x] T016–T019: Python Client, Auth Headers & PII Scrubber (Phase 4)
- [x] T020–T025: LangGraph State Machine & Read-Only Tools (Phase 5)
- [x] T026–T028: Human-in-the-Loop Gate & SSE Streaming Status (Phase 6)
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
- [x] Phase 2: Agent Gateway REST Endpoints & Authentication
- [x] Phase 3: PII Stripping, Caching & Auditing
- [x] Phase 4: Python Client, Auth Headers & PII Scrubber
- [x] Phase 5: LangGraph State Machine & Read-Only Tools
- [x] Phase 6: Human-in-the-Loop Gate & SSE Streaming Status
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

### [x] Feature: Map Integration

- [x] Phase 1: Setup (Shared Infrastructure)
- [x] Phase 2: Foundational (Database Schema & Seed)
- [x] Phase 3: Airport Map & REST API (Backend & Frontend MVP)
- [x] Phase 4: Airport Autocomplete with Map Preview
- [x] Phase 5: Flight Route Details Map
- [x] Phase 6: Dark Mode & Destination Explorer (tile style toggle, app theme sync, explore map with popular destinations pre-fill/redirect)
- [x] Phase 7: Polish & E2E Validation

---

## Decisions Made During Build

- Consolidated separate PostgreSQL and Redis standalone docker containers into a single `docker-compose.yml` file at the project root for streamlined development service management.
- Refactored `PrismaService` to remove the query interceptor facade. This ensures it behaves as a genuine client and reports health status truthfully based on real database availability.
- Implemented clean Jest spies and mock lifecycles directly in `test/health.e2e-spec.ts` to manage database connectivity states in local environments where PostgreSQL and Redis are unavailable.
- Added client warming to E2E setup in `health.e2e-spec.ts` to bypass Express/NestJS router bootstrap cold-start latencies.

---

## Notes

- The test environment does not run PostgreSQL or Redis services locally. E2E tests use Jest spies on the PrismaClient instance to mock database states, keeping the API source code clean and genuine.
