# Feature Specification: LLM Output Guardrails

**Feature Branch**: `004-output-guardrails`

**Created**: 2026-07-03

**Status**: Draft

**Input**: Architectural decisions from [output-guardrails-architecture.md](file:///c:/Booking%20Systems/research/output-guardrails-architecture.md) grilling session.

## Context

The agent service streams LLM tokens directly to the user's browser via SSE. Input guardrails (NeMo) validate user messages before they reach the LLM, but no output-side filtering exists. The LLM may:

- Leak PII (emails, phone numbers, passport numbers, credit card numbers) from training data or conversation context.
- Generate harmful, inappropriate, or policy-violating content.

This feature adds a guardrail pipeline between the LLM output and the SSE stream to the user.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Safe Output Streaming (Priority: P1)

A traveler receives LLM responses that have been validated for safety before reaching their browser. The guardrail pipeline operates transparently — the user experiences natural conversational responses with minimal added latency.

**Why this priority**: This is the core value proposition. Without output guardrails, every response is a potential PII leak or harmful content delivery.

**Independent Test**: Send a benign message, verify the response streams normally with `token` and `done` SSE events. Measure added latency vs. ungated baseline.

**Acceptance Scenarios**:

1. **Given** a traveler sends a normal chat message, **When** the LLM generates a safe response, **Then** the response streams to the user via SSE with all tokens intact and a `done` event at completion.
2. **Given** the guardrail pipeline is active, **When** a safe response is generated, **Then** the added latency per chunk is ≤50ms for the regex layer and ≤350ms total including NeMo.
3. **Given** the LLM generates a multi-sentence response, **When** pipeline parallelism is active, **Then** chunk N streams to the user while chunk N+1 is being validated — hiding guardrail latency after the first chunk.

---

### User Story 2 - PII Leak Prevention in Output (Priority: P1)

A traveler is protected from receiving PII in LLM responses — even if the model hallucinates or leaks PII from training data, conversation context, or tool results that somehow bypassed structural exclusion.

**Why this priority**: PII leaks are data breaches. This is a non-negotiable security requirement aligned with the constitution's Security Requirements.

**Independent Test**: Craft prompts that attempt to elicit PII patterns (email, phone, passport, credit card) in responses. Verify the stream is killed and `OUTPUT_GUARDRAIL_BLOCKED` error is emitted.

**Acceptance Scenarios**:

1. **Given** the LLM generates a response containing an email address, **When** the regex PII scanner processes the chunk, **Then** the stream is immediately killed and an `OUTPUT_GUARDRAIL_BLOCKED` SSE error event is emitted.
2. **Given** the LLM generates a response containing a credit card number (Luhn-valid), **When** the regex PII scanner processes the chunk, **Then** hard stop is triggered.
3. **Given** the LLM generates a response containing a passport number pattern, **When** the regex PII scanner processes the chunk, **Then** hard stop is triggered.
4. **Given** the LLM generates a response containing a phone number, **When** the regex PII scanner processes the chunk, **Then** hard stop is triggered.

---

### User Story 3 - Boundary PII Detection (Priority: P1)

A traveler is protected from PII that spans sentence boundaries — where each sentence individually appears safe but the combination reveals PII.

**Why this priority**: Sentence-boundary chunking is a core design decision. Without cross-chunk validation, PII spanning two chunks would bypass the guardrail.

**Independent Test**: Construct a two-sentence response where PII spans the sentence boundary. Verify the sliding window catches it.

**Acceptance Scenarios**:

1. **Given** the LLM generates "The cardholder's name is John Smith." followed by "His card ends in 4242.", **When** the sliding window concatenates the tail of chunk 1 and head of chunk 2, **Then** the regex PII scanner detects the combined PII pattern and triggers hard stop.
2. **Given** a response where an email address is split across "contact john.doe@" and "gmail.com for details", **When** the sliding window overlap region is scanned, **Then** the email pattern is detected and hard stop is triggered.

---

### User Story 4 - Harmful Content Blocking (Priority: P1)

A traveler is protected from receiving harmful, toxic, or policy-violating content that the LLM may generate — even content that doesn't match structured PII patterns.

**Why this priority**: PII regex only catches structured patterns. NeMo output rail catches nuanced harmful content: toxicity, prompt injection artifacts, subtle PII references.

**Independent Test**: Trigger responses containing policy violations or harmful content. Verify NeMo output rail catches them and triggers hard stop.

**Acceptance Scenarios**:

1. **Given** the LLM generates content classified as UNSAFE by the NeMo output rail, **When** the chunk passes regex PII scan but fails NeMo, **Then** hard stop is triggered with `OUTPUT_GUARDRAIL_BLOCKED`.
2. **Given** the LLM generates a response containing prompt injection artifacts (e.g., system prompt leakage), **When** the NeMo output rail processes the chunk, **Then** the chunk is classified UNSAFE and hard stop is triggered.

---

### User Story 5 - Hard Stop and Partial Persistence (Priority: P2)

When a guardrail violation is detected, the stream is killed immediately and the user sees a clear error message. The partial response (up to the last safe chunk) is persisted so conversation context is not lost.

**Why this priority**: Graceful failure handling preserves user experience and conversation continuity.

**Independent Test**: Trigger a guardrail block mid-stream. Verify the SSE error event, partial response persistence, and security log entry.

**Acceptance Scenarios**:

1. **Given** a guardrail violation is detected in chunk 3 of a 5-chunk response, **When** hard stop triggers, **Then** chunks 1-2 (already streamed and safe) are persisted as the partial agent response, and the SSE error event contains `partialMessageId` if persistence succeeded.
2. **Given** hard stop triggers, **When** the error SSE event is sent, **Then** the event contains `{"code": "OUTPUT_GUARDRAIL_BLOCKED", "message": "Response was blocked for safety reasons.", "partialMessageId": "uuid | null"}`.
3. **Given** hard stop triggers, **When** a security event is logged, **Then** the log entry contains the guardrail rule/layer that triggered (regex or NeMo) but NEVER contains the offending content.

---

### User Story 6 - Operator Observability (Priority: P2)

A system operator can monitor output guardrail activity through structured logging and metrics — seeing block rates, latency per layer, and which guardrail rules trigger most frequently.

**Why this priority**: Required by Constitution Principle IV (Observability & Operational Visibility).

**Acceptance Scenarios**:

1. **Given** the guardrail pipeline processes a chunk, **When** the check completes, **Then** a structured log entry is emitted with: timestamp, session_id, chunk_index, layer (regex/NeMo), verdict (pass/fail), latency_ms.
2. **Given** a guardrail block occurs, **When** the security event is logged, **Then** the log includes: guardrail_layer, rule_name, session_id — but NO content from the blocked chunk.

---

### Edge Cases

- What happens when the NeMo guardrail service is unavailable during output checking? → Fail closed: hard stop the stream and emit `OUTPUT_GUARDRAIL_BLOCKED` with reason "Safety check unavailable".
- What happens when a chunk is very long (e.g., a single sentence with 500+ tokens)? → Enforce a configurable max chunk size. If a sentence exceeds the limit, force-split at the limit and process as separate chunks.
- What happens when the LLM generates a code block with `.` characters that aren't sentence endings? → The sentence boundary detector skips content inside triple-backtick fenced regions, accumulating the entire code block as a single chunk.
- What happens when the first chunk fails the guardrail? → Hard stop with no partial response persisted (partialMessageId = null). User sees the error message only.
- How does the output guardrail interact with tool_call/tool_result events? → Tool events are NOT subject to output guardrails — they contain structured data from the gateway (already PII-stripped). Only `on_chat_model_stream` tokens pass through the guardrail pipeline.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST validate all LLM-generated output tokens through a guardrail pipeline before streaming them to the user via SSE.
- **FR-002**: The system MUST accumulate LLM tokens and split them into chunks at sentence boundaries (`.`, `!`, `?`, `\n` followed by whitespace or end-of-stream), NOT at fixed token counts.
- **FR-003**: The system MUST run guardrail checks using pipeline parallelism — validating chunk N+1 while streaming chunk N to the user.
- **FR-004**: The system MUST maintain a sliding window of the last N tokens (configurable, default 30) from the previous chunk, and test the overlap region (tail of previous chunk + head of current chunk) with the regex PII scanner before running the main guardrail check.
- **FR-005**: The system MUST run two guardrail layers on every chunk, in order: (1) Regex PII scanner, (2) NeMo output rail. If the regex scan fails, the NeMo check is skipped.
- **FR-006**: The system MUST perform a hard stop on any guardrail failure: stop consuming LLM tokens, send an `OUTPUT_GUARDRAIL_BLOCKED` SSE error event, persist the partial response up to the last safe chunk, and log a structured security event.
- **FR-007**: The SSE error event for output guardrail blocks MUST contain `{"code": "OUTPUT_GUARDRAIL_BLOCKED", "message": "Response was blocked for safety reasons.", "partialMessageId": "<uuid | null>"}`.
- **FR-008**: Security event logs MUST include the guardrail layer and rule that triggered but MUST NEVER include the content of the blocked chunk.
- **FR-009**: The system MUST NOT apply output guardrails to `tool_call`, `tool_result`, or `confirmation_required` SSE events — only to LLM-generated text tokens.
- **FR-010**: The system MUST skip sentence-boundary splitting inside triple-backtick fenced code blocks, accumulating the entire code block as a single chunk.
- **FR-011**: The system MUST enforce a configurable maximum chunk size (default 200 tokens). Sentences exceeding this limit are force-split.
- **FR-012**: The system MUST fail closed when the NeMo output rail service is unavailable — hard stop the stream rather than allowing unvalidated content through.
- **FR-013**: The overlap token count MUST be configurable via environment variable (`OUTPUT_GUARDRAIL_OVERLAP_TOKENS`, default 30).
- **FR-014**: The NeMo output rail MUST use a dedicated output-checking classification prompt, distinct from the input rail prompt.
- **FR-015**: The system MUST emit structured log entries for every guardrail check with: timestamp, session_id, chunk_index, layer, verdict, latency_ms.

### Key Entities

- **Output Guardrail Pipeline**: The processing pipeline that sits between the LLM token stream and the SSE stream to the user. Accumulates tokens → chunks at sentence boundaries → validates through layered guardrails → streams safe chunks.
- **Chunk Buffer**: Accumulates incoming LLM tokens until a sentence boundary is detected, producing complete semantic units for guardrail validation.
- **Sliding Window**: Maintains the tail tokens of the previous chunk for cross-boundary PII detection in the overlap region.
- **Regex PII Scanner (Output)**: Reuses the existing PII regex patterns from `pii_scrubber.py` for detection (not scrubbing) — passport, credit card (Luhn), email, phone.
- **NeMo Output Rail**: Extension of the existing NeMo guardrail service for output-side classification using an output-specific system prompt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of LLM output tokens pass through the guardrail pipeline before reaching the user — verified by E2E test with guardrail logging.
- **SC-002**: PII patterns (email, phone, passport, credit card) in LLM output are detected and blocked 100% of the time — verified by automated test suite with known PII payloads.
- **SC-003**: Cross-chunk boundary PII (spanning two sentences) is detected and blocked — verified by test cases with deliberately split PII.
- **SC-004**: Added latency per chunk ≤50ms for regex layer, ≤350ms total including NeMo — measured in benchmark tests.
- **SC-005**: Hard stop correctly persists partial responses up to the last safe chunk — verified by checking persisted messages after a guardrail block.
- **SC-006**: Security event logs contain guardrail metadata but zero content from blocked chunks — verified by log inspection in E2E tests.
- **SC-007**: Pipeline parallelism hides guardrail latency for chunks 2+ — measured by comparing per-chunk streaming latency with and without pipelining.

## Assumptions

- The chatbot agent service (JWT auth, SSE streaming, LangGraph orchestration, tool calling) is fully built and operational.
- Input guardrails (NeMo) are already implemented and functional.
- The existing PII regex patterns in `pii_scrubber.py` are sufficient for output PII detection.
- The NeMo/Mimo safety classification endpoint is available for output-side checks.
- Single-instance deployment — no distributed pipeline coordination needed.
- The frontend chat UI is a separate feature — sentence-boundary chunking UX smoothing (typewriter animation) is out of scope.
