# Tasks: AI Chatbot Agent Service

**Input**: Design documents from `specs/002-chatbot-agent-service/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: E2E tests for the NestJS ChatModule are required because the changes touch the database schema and add new migrations (as per context/workflow.md E2E triggers).

**Organization**: Tasks are grouped by logical implementation phases. Phase 1 & 2 cover the shared setup and the foundational NestJS data persistence layer. Subsequent phases map to the Python agent user stories.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4, US5)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Python agent service workspace setup and environment preparation

- [x] T001 Initialize Python agent service directory structure in `apps/agent/`
- [x] T002 Configure Python dependencies in `apps/agent/pyproject.toml`
- [x] T003 [P] Create minimal `apps/agent/package.json` for pnpm workspace compatibility

---

## Phase 2: Foundational (Blocking Prerequisites & Data Layer)

**Purpose**: Database schema, NestJS persistence API (ChatModule), and E2E test foundation

**⚠️ CRITICAL**: All Python agent user stories depend on this persistence layer being fully operational.

### Database Setup

- [x] T004 Add `ChatSession` and `ChatMessage` models, enums `MessageSender` and `MessageType`, and relation `chatSessions` in `apps/api/prisma/schema.prisma`
- [x] T005 Run Prisma migration and regenerate client in `apps/api/` using `npx prisma migrate dev`
- [x] T006 [P] Add ChatSession and ChatMessage TypeScript types to `packages/shared/src/types/index.ts`

### NestJS ChatModule Scaffolding

- [x] T007 [P] Create ChatSession and ChatMessage DTOs in `apps/api/src/chat/dto/` (create-session, update-session, list-sessions-query, create-message)
- [x] T008 [P] Create `ChatModule` file structure: service, controller, and module in `apps/api/src/chat/`
- [x] T009 Import `ChatModule` into `apps/api/src/app.module.ts`

### Service & Controller Implementation

- [x] T010 Implement session CRUD methods in `apps/api/src/chat/chat.service.ts` with User scope enforcement
- [x] T011 Implement message creation, retrieval, and batch persistence endpoints in `apps/api/src/chat/chat.service.ts`
- [x] T012 Implement structured audit logging in `apps/api/src/chat/chat.service.ts` using `AuditService`
- [x] T013 Implement HTTP endpoints in `apps/api/src/chat/chat.controller.ts` with `JwtAuthGuard` protection

### E2E Verification

- [x] T014 Write NestJS ChatModule E2E integration tests in `apps/api/test/chat.e2e-spec.ts`
- [x] T015 Run and verify NestJS ChatModule E2E tests

**Checkpoint**: Foundation ready - NestJS Chat API is fully functional, secure, and verified.

---

## Phase 3: User Story 2 - Authenticated Access Control (Priority: P1)

**Goal**: Validate NestJS-signed JWT tokens using a shared secret in the Python service.

**Independent Test**: Send requests to Python service with valid, expired, and missing tokens and verify status codes.

- [x] T016 Setup FastAPI application scaffold and configuration loading in `apps/agent/src/agent/main.py` and `config.py`
- [x] T017 Implement JWT auth middleware in `apps/agent/src/agent/middleware/auth.py`
- [x] T018 Write unit tests for auth middleware in `apps/agent/tests/test_auth.py`

---

## Phase 4: User Story 3 - Malicious Input Protection (Priority: P1)

**Goal**: Apply NeMo Guardrails input guardrails to block prompt injection and fail closed.

**Independent Test**: Send known prompt injections and check that they are blocked with <500ms latency.

- [x] T019 Define `GuardrailService` abstract interface in `apps/agent/src/agent/guardrails/base.py`
- [x] T020 Implement NeMo Guardrails-based guardrail in `apps/agent/src/agent/guardrails/nemo.py` with config pre-loading
- [x] T021 Implement structured security event logging for blocked inputs in `apps/agent/src/agent/guardrails/nemo.py`
- [x] T022 Write unit tests for guardrail layer in `apps/agent/tests/test_guardrails.py`

---

## Phase 4A: User Story 1 - Real-Time Chat Foundation (Priority: P1)

**Goal**: Setup FastAPI SSE streaming structure and the NestJS client foundation.

**Independent Test**: Verify mock token streaming over `/chat/stream` via SSE and check that the NestJS API client creates sessions correctly.

- [x] T023 Implement NestJS API client using httpx in `apps/agent/src/agent/tools/nestjs_client.py`
- [x] T025a Implement base SSE event streaming endpoint and session auto-creation in `apps/agent/src/agent/streaming/sse.py`
- [x] T026a Write unit/integration tests for the streaming foundation and API client in `apps/agent/tests/test_streaming_foundation.py`

---

## Phase 4B: User Story 1 - LangChain Streaming & Failure Handling (Priority: P1)

**Goal**: Orchestrate the LangChain agent stream and handle mid-stream connection drops / LLM failures.

**Independent Test**: Connect to `/chat/stream` and verify end-to-end token delivery from the agent, database persistence on success, and partial persistence on mid-stream drop.

- [x] T024 Setup LangChain ChatOpenAI and chat agent prompt template in `apps/agent/src/agent/agents/chat_agent.py`
- [x] T025b Wire agent streaming into the SSE endpoint and implement the connection drop handler / batch persistence in `apps/agent/src/agent/streaming/sse.py`
- [x] T026b Write integration tests for full agent streaming and drop persistence in `apps/agent/tests/test_streaming_agent.py`

---

## Phase 6: User Story 4 - Conversation History & Memory (Priority: P2)

**Goal**: Retrieve previous messages/summary from NestJS API and manage sliding window + async summary updates.

**Independent Test**: Send consecutive messages to the chatbot and verify it retains context from prior turns.

- [x] T027 Implement memory manager in `apps/agent/src/agent/memory/manager.py` (load recent messages/summary from NestJS memory endpoint)
- [x] T028 Implement post-response token budget check using tiktoken and async summarization trigger in `apps/agent/src/agent/memory/manager.py`
- [x] T029 Write unit tests for memory assembly and summarization in `apps/agent/tests/test_memory.py`

---

## Phase 7: User Story 5 - Conversation Management (Priority: P3)

**Goal**: Support session listing, creation, and message serialization per conversation.

**Independent Test**: Send concurrent messages to the same conversation and verify they are serialized; verify session isolation.

- [x] T030 Implement per-conversation message queue in `apps/agent/src/agent/queue/message_queue.py`
- [x] T031 Integrate message queue in FastAPI request handler in `apps/agent/src/agent/main.py`
- [x] T032 Write integration tests for concurrency queue limits and session isolation in `apps/agent/tests/test_queue.py`

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation updates, cleanup, performance validation, and final checks.

- [ ] T033 Update OpenAPI documentation for the Python agent service
- [ ] T034 Run quickstart.md validation steps to ensure all system endpoints work end-to-end
- [ ] T035 [P] Update `context/architecture.md` and `context/progress-checker.md` to reflect full implementation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phases 3 to 7)**: All depend on Foundational phase completion
  - Can proceed sequentially: Phase 3 → Phase 4 → Phase 5A → Phase 5B → Phase 6 → Phase 7
- **Polish (Phase 8)**: Depends on all user stories being complete
