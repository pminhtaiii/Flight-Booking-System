# Tasks: Agent Tool-Calling & Data Access

**Input**: Design documents from `/specs/003-agent-tool-calling/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Database Schema & Mock Seed Data (Data Layer)

**Purpose**: Database schema updates and mock data seeding for testing

- [x] T001 Modify schema.prisma to add TravelerProfile, Booking, and BookingStatus, and update User relations in apps/api/prisma/schema.prisma
- [x] T002 Run Prisma migrations to update the PostgreSQL database
- [x] T003 [P] Create a mock data seeding script to populate users with traveler profiles, saved preferences, and mock bookings in apps/api/prisma/seed-agent-tools.ts
- [x] T004 Run and verify the mock data seeding script

## Phase 2: Agent Gateway REST Endpoints & Authentication (Gateway Foundation)

**Purpose**: Secure gateway REST API endpoints with auth guards

- [x] T005 Implement agent-api-key.guard.ts to validate X-Agent-API-Key header in apps/api/src/agent-gateway/auth/agent-api-key.guard.ts
- [x] T006 Implement claim-token.guard.ts and claim-token.service.ts to validate HMAC-SHA256 user claim tokens in apps/api/src/agent-gateway/auth/
- [x] T007 [P] Create flight-search-query.dto.ts, flight-result.dto.ts, user-preferences.dto.ts, and user-bookings.dto.ts in apps/api/src/agent-gateway/dto/
- [x] T008 Implement AgentGatewayController with the 3 required endpoints in apps/api/src/agent-gateway/agent-gateway.controller.ts
- [x] T009 Implement AgentGatewayService to orchestrate data access in apps/api/src/agent-gateway/agent-gateway.service.ts
- [x] T010 [P] Create agent-gateway.module.ts and register it in apps/api/src/app.module.ts
- [x] T011 Write NestJS E2E tests for authentication and endpoint validation in apps/api/test/agent-gateway.e2e-spec.ts

## Phase 3: PII Stripping, Caching & Auditing (Gateway Polish)

**Purpose**: Strip PII, integrate caching/Amadeus client, and audit-log tool calls

- [x] T012 [P] Implement PII stripping logic in apps/api/src/agent-gateway/agent-gateway.service.ts
- [x] T013 Integrate Amadeus Flight Offers Search client, Redis CacheService, and rate limiting in apps/api/src/agent-gateway/amadeus/
- [x] T014 Implement structured auditing to write TOOL_CALL logs using AuditService in apps/api/src/agent-gateway/agent-gateway.service.ts
- [x] T015 Write E2E tests for PII stripping and audit logging in apps/api/test/agent-gateway-polish.e2e-spec.ts

## Phase 4: Python Client, Auth Headers & PII Scrubber (Agent Foundation)

**Purpose**: Claim token generation, authenticated client request headers, and user-input PII scrubbing

- [ ] T016 [P] Implement HMAC-SHA256 claim token generation in Python in apps/agent/src/agent/auth/claim_token.py
- [ ] T017 Extend nestjs_client.py to attach API keys and signed user claim tokens in apps/agent/src/agent/tools/nestjs_client.py
- [ ] T018 [P] Implement pii_scrubber.py to scrub regex-matched PII from chat messages in apps/agent/src/agent/sanitization/pii_scrubber.py
- [ ] T019 Write unit tests for claim tokens, NestJS client, and PII scrubbing in apps/agent/tests/

## Phase 5: LangGraph State Machine & Read-Only Tools (Agent Core)

**Purpose**: LangGraph state graph and read-only tools implementation

- [ ] T020 [P] [US2] Implement get_user_preferences tool calling gateway preferences endpoint in apps/agent/src/agent/tools/get_preferences.py
- [ ] T021 [P] [US3] Implement list_user_bookings tool calling gateway bookings endpoint in apps/agent/src/agent/tools/list_bookings.py
- [ ] T022 [P] [US1] Implement search_flights tool calling gateway search endpoint with top 5 results limit in apps/agent/src/agent/tools/search_flights.py
- [ ] T023 [US1] Define AgentState and compile LangGraph StateGraph in apps/agent/src/agent/graph/
- [ ] T024 [US1] Bind tools and configure iteration capping router in apps/agent/src/agent/graph/router.py
- [ ] T025 Write integration tests for the compiled graph, tools, and closed-world prompt in apps/agent/tests/test_graph.py

## Phase 6: Human-in-the-Loop Gate & SSE Streaming Status (Agent Polish & Integration)

**Purpose**: Graph interrupts, SSE streaming extensions, and error handling

- [ ] T026 [P] Implement graph suspension using interrupts for confirmation-required tools in apps/agent/src/agent/graph/
- [ ] T027 Extend SSE streaming generator to yield tool_call and tool_result events in apps/agent/src/agent/streaming/sse.py
- [ ] T028 Write integration tests for SSE streams and graph suspension/resume/abort in apps/agent/tests/test_sse_integration.py

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final updates, documentation, and cleanup

- [ ] T029 [P] Update OpenAPI/Swagger documentation for new endpoints in apps/api/
- [ ] T030 [P] Verify quickstart.md validation steps
- [ ] T031 Clean up code, run typecheck, and ensure all tests pass clean

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Database schema)**: No dependencies, must complete first.
- **Phase 2 (Gateway endpoints & Auth)**: Depends on Phase 1.
- **Phase 3 (Gateway polish)**: Depends on Phase 2.
- **Phase 4 (Agent foundation)**: Can run in parallel with Phase 2/3.
- **Phase 5 (Agent core)**: Depends on Phase 3 and Phase 4.
- **Phase 6 (Agent polish)**: Depends on Phase 5.
- **Phase 7 (Polish & cleanup)**: Depends on all prior phases.

### Parallel Opportunities

- T003 (Seeding script) can be written in parallel with schema creation.
- DTO creation (T007) and module setup (T010) in Phase 2.
- Python claim token (T016) and PII scrubber (T018) in Phase 4.
- Tools (T020, T021, T022) in Phase 5.
