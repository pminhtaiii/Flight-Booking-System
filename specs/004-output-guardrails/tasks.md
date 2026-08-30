# Tasks: LLM Output Guardrails

**Input**: Design documents from `/specs/004-output-guardrails/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Included as requested in the specification.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure validation

- [x] T001 Verify agent dependencies and testing setup in apps/agent/pyproject.toml

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T002 [P] Modify config model to add environment variables in apps/agent/src/agent/config.py
- [x] T003 [P] Implement detect_pii function in apps/agent/src/agent/sanitization/pii_scrubber.py
- [x] T004 [P] Create configuration unit tests in apps/agent/tests/test_config_defaults.py
- [x] T005 [P] Create PII detection unit tests in apps/agent/tests/test_pii_detection.py

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Safe Output Streaming (Priority: P1) 🎯 MVP

**Goal**: A traveler receives LLM responses that have been validated for safety before reaching their browser.

**Independent Test**: Send a benign message, verify the response streams normally with `token` and `done` SSE events. Measure added latency vs. ungated baseline.

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T006 [P] [US1] Create ChunkBuffer unit tests in apps/agent/tests/test_chunk_buffer.py
- [x] T007 [P] [US1] Create NeMo output rail unit tests in apps/agent/tests/test_output_guardrail_nemo.py
- [x] T008 [P] [US1] Create OutputGuardrailPipeline unit tests in apps/agent/tests/test_output_pipeline.py
- [x] T009 [US1] Create SSE output guardrail integration tests in apps/agent/tests/test_sse_output_guardrail.py

### Implementation for User Story 1

- [x] T010 [P] [US1] Create ChunkBuffer class in apps/agent/src/agent/streaming/chunk_buffer.py
- [x] T011 [P] [US1] Implement validate_output_chunk in apps/agent/src/agent/guardrails/nemo.py and base.py
- [x] T012 [P] [US1] Create OutputGuardrailPipeline class in apps/agent/src/agent/guardrails/output_pipeline.py
- [x] T013 [US1] Integrate OutputGuardrailPipeline into SSE streaming producer in apps/agent/src/agent/streaming/sse.py

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - PII Leak Prevention & Boundary Detection (Priority: P1)

**Goal**: Protect travelers from receiving PII in LLM responses, including PII split across sentence boundaries.

**Independent Test**: Craft prompts that attempt to elicit PII patterns (email, phone, passport, credit card) in responses. Verify the stream is killed and `OUTPUT_GUARDRAIL_BLOCKED` error is emitted.

### Tests for User Story 2

- [x] T014 [P] [US2] Create unit tests for sliding window and boundary PII in apps/agent/tests/test_output_pipeline.py

### Implementation for User Story 2

- [x] T015 [US2] Implement regex PII scanning on chunks in apps/agent/src/agent/guardrails/output_pipeline.py
- [x] T016 [US2] Implement sliding window and scan overlap region in apps/agent/src/agent/guardrails/output_pipeline.py

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - Harmful Content Blocking (Priority: P1)

**Goal**: Protect travelers from receiving harmful, toxic, or policy-violating content using NeMo.

**Independent Test**: Trigger responses containing policy violations or harmful content. Verify NeMo output rail catches them and triggers hard stop.

### Tests for User Story 3

- [x] T017 [P] [US3] Create unit tests for NeMo classification and timeout fail-closed behavior in apps/agent/tests/test_output_pipeline.py

### Implementation for User Story 3

- [x] T018 [US3] Wire NeMo validation layer into the OutputGuardrailPipeline in apps/agent/src/agent/guardrails/output_pipeline.py

**Checkpoint**: All P1 user stories should now be independently functional

---

## Phase 6: User Story 4 - Hard Stop and Partial Persistence (Priority: P2)

**Goal**: Stop the stream immediately on guardrail violation, return a clear error, and persist the partial response.

**Independent Test**: Trigger a guardrail block mid-stream. Verify the SSE error event, partial response persistence, and security log entry.

### Tests for User Story 4

- [x] T019 [P] [US4] Create unit tests for hard stop, partial persistence, and error events in apps/agent/tests/test_hard_stop.py

### Implementation for User Story 4

- [x] T020 [US4] Implement Hard Stop handler in apps/agent/src/agent/streaming/sse.py
- [x] T021 [US4] Implement partial response persistence via NestJS client in apps/agent/src/agent/streaming/sse.py

---

## Phase 7: User Story 5 - Pipeline Parallelism (Priority: P2)

**Goal**: Run guardrail checks using pipeline parallelism to hide latency for chunks 2+.

**Independent Test**: Compare per-chunk streaming latency with and without pipelining in benchmark tests.

### Tests for User Story 5

- [x] T022 [P] [US5] Create concurrency/latency unit tests in apps/agent/tests/test_pipeline_parallelism.py

### Implementation for User Story 5

- [x] T023 [US5] Implement asyncio Task lookahead in apps/agent/src/agent/guardrails/output_pipeline.py

---

## Phase 8: User Story 6 - Operator Observability (Priority: P2)

**Goal**: Monitor output guardrail activity through structured logging and metrics.

**Independent Test**: Verify structured log entries contain required fields and NO content from the blocked chunk.

### Tests for User Story 6

- [x] T024 [P] [US6] Create logging unit tests in apps/agent/tests/test_guardrail_logging.py

### Implementation for User Story 6

- [x] T025 [US6] Implement structured JSON logging in apps/agent/src/agent/guardrails/output_pipeline.py

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Improvements and final validation of the whole pipeline

- [x] T026 [P] Update documentation in specs/004-output-guardrails/
- [x] T027 [P] Create final E2E validation tests in apps/agent/tests/test_e2e_output_guardrails.py
- [x] T028 [P] Create benchmark script in apps/agent/tests/test_benchmark_output_pipeline.py
- [x] T029 Verify NeMo fail-closed behavior on agent restart

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2)
- **User Story 2 (P1)**: Depends on US1 (ChunkBuffer and Pipeline)
- **User Story 3 (P1)**: Depends on US1 (Nemo and Pipeline)
- **User Story 4 (P2)**: Depends on US1 & US2 & US3
- **User Story 5 (P2)**: Depends on US4
- **User Story 6 (P2)**: Depends on US4

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel
- Once Foundational phase completes, US1 tests and models can be worked on in parallel
- Different user stories can be worked on in parallel

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently
5. Deploy/demo if ready
