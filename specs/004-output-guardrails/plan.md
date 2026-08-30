# Implementation Plan: LLM Output Guardrails

**Branch**: `004-output-guardrails` | **Date**: 2026-07-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-output-guardrails/spec.md`

## Summary

Add a guardrail pipeline between the LLM token stream and the SSE output to the user. The pipeline accumulates tokens into sentence-boundary chunks, validates each chunk through a layered guardrail (regex PII scanner → NeMo output rail), and uses pipeline parallelism to hide guardrail latency. On any guardrail failure, the stream is hard-stopped, a partial response is persisted, and a security event is logged.

## Technical Context

**Language/Version**: Python 3.11+

**Primary Dependencies**: FastAPI, LangGraph, LangChain, httpx, sse-starlette, NeMo Guardrails (via Mimo endpoint)

**Storage**: N/A (extends existing — uses existing NestJS persistence for partial response storage)

**Testing**: pytest, pytest-asyncio

**Target Platform**: Linux server (single-instance)

**Project Type**: Web-service extension (adds output pipeline to existing agent service)

**Performance Goals**: Regex layer ≤50ms/chunk, total pipeline ≤350ms/chunk, pipeline parallelism hides latency for chunks 2+

**Constraints**: Fail-closed on NeMo unavailability. No PII in logs. Must not break existing SSE event protocol.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                                  | Status   | Justification                                                                                                                                                                             |
| ------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Flight-First Architecture               | ✅ PASS  | Output guardrails protect the flight search conversation flow without blocking or complicating the booking pipeline.                                                                      |
| II. Deterministic Transaction Boundary     | ✅ PASS  | Output guardrails operate entirely within the advisory AI agent layer. No booking/payment path changes.                                                                                   |
| III. API Budget Discipline                 | ⚠️ WATCH | NeMo output rail calls the Mimo classification endpoint once per chunk. A 10-sentence response = 10 API calls. Monitor API budget impact. Regex fast-fail reduces unnecessary NeMo calls. |
| IV. Observability & Operational Visibility | ✅ PASS  | Structured logging for every guardrail check (layer, verdict, latency). Security event logging on blocks.                                                                                 |
| V. Incremental Delivery                    | ✅ PASS  | Output guardrails are a self-contained, independently deployable feature. No dependency on frontend changes.                                                                              |
| Security Requirements                      | ✅ PASS  | Enforces PII protection in LLM output (constitution mandate). No PII in logs. Fail-closed behavior.                                                                                       |

**Post-Phase-1 Re-check**: API Budget concern mitigated by (1) regex fast-fail skipping NeMo for obvious PII violations, (2) sentence-boundary chunking producing ~5-15 chunks per response (acceptable NeMo call volume), (3) existing NeMo health probe pattern for monitoring.

## Project Structure

### Documentation (this feature)

```text
specs/004-output-guardrails/
├── plan.md              # This file
├── research.md          # Phase 0 output — 4 unknowns resolved
├── data-model.md        # Phase 1 output — data structures
├── quickstart.md        # Phase 1 output — validation guide
├── contracts/           # Phase 1 output — pipeline interface contracts
│   └── output-guardrail-pipeline.md
└── tasks.md             # Phase 2 output (created by /speckit-tasks)
```

### Source Code (repository root)

```text
apps/agent/src/agent/
├── guardrails/
│   ├── base.py                    # [MODIFY] Add OutputGuardrailService protocol
│   ├── nemo.py                    # [MODIFY] Add validate_output_chunk method
│   └── output_pipeline.py         # [NEW] OutputGuardrailPipeline class
├── streaming/
│   ├── sse.py                     # [MODIFY] Integrate output pipeline into producer
│   └── chunk_buffer.py            # [NEW] SentenceBoundaryChunkBuffer
├── sanitization/
│   └── pii_scrubber.py            # [REUSE] Existing regex patterns for output PII detection
└── config.py                      # [MODIFY] Add output guardrail config vars

apps/agent/tests/
├── test_output_pipeline.py        # [NEW] Unit tests for output guardrail pipeline
├── test_chunk_buffer.py           # [NEW] Unit tests for sentence boundary detection
└── test_output_guardrail_nemo.py  # [NEW] Unit tests for NeMo output rail
```

**Structure Decision**: All new code lives within the existing `apps/agent/` Python service. The output guardrail pipeline is a new module (`output_pipeline.py`) that the SSE streaming producer calls. No new services or deployable units.

## Complexity Tracking

No constitution violations requiring justification. All changes are within the existing agent service boundary.

---

## Phase Overview

```text
Phase 0: Research ──────────────────────── ✅ Complete
Phase 1: Design & Contracts ────────────── ✅ Complete
Phase 2: Configuration & PII Detection ─── Foundation layer
Phase 3: Sentence-Boundary Chunking ────── Token accumulation + splitting
Phase 4: NeMo Output Rail ─────────────── Safety classification layer
Phase 5: Output Guardrail Pipeline ─────── Orchestration + sliding window
Phase 6: SSE Integration ──────────────── Wire pipeline into streaming
Phase 7: Hard Stop & Partial Persistence ─ Failure handling
Phase 8: Pipeline Parallelism ─────────── Latency optimization
Phase 9: Observability & Logging ──────── Structured logs + security events
Phase 10: E2E Testing & Validation ─────── Integration tests + benchmarks
```

### Dependency Graph

```text
Phase 2 (Config + PII Detection)
    ↓
Phase 3 (ChunkBuffer)
    ↓
Phase 4 (NeMo Output Rail) ─────────┐
    ↓                                │
Phase 5 (Pipeline Orchestration) ←───┘
    ↓
Phase 6 (SSE Integration)
    ↓
Phase 7 (Hard Stop + Partial Persistence)
    ↓
Phase 8 (Pipeline Parallelism)
    ↓
Phase 9 (Observability)
    ↓
Phase 10 (E2E Tests + Validation)
```

---

## Phase 0: Research — ✅ Complete

See [research.md](research.md). All 4 unknowns resolved:

1. ✅ Sentence detection edge cases → heuristic boundary detector
2. ✅ Sliding window token count → 30 tokens default, configurable
3. ✅ NeMo output rail config → reuse Mimo endpoint with output-specific prompt
4. ✅ Streaming UX → out of scope (frontend typewriter animation)

---

## Phase 1: Design & Contracts — ✅ Complete

See [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md).

---

## Phase 2: Configuration & PII Detection — Foundation

**Depends on**: Phase 1  
**FRs covered**: FR-011, FR-013  
**Delivers**: Config model + reusable PII detection function

### Files

| File                           | Action | What                                                                                                                                                           |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.py`                    | MODIFY | Add 4 env vars: `OUTPUT_GUARDRAIL_ENABLED`, `OUTPUT_GUARDRAIL_OVERLAP_TOKENS`, `OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS`, `OUTPUT_GUARDRAIL_NEMO_TIMEOUT`            |
| `sanitization/pii_scrubber.py` | MODIFY | Extract regex patterns into a reusable `detect_pii(text) -> bool` function (returns True if PII found, does not scrub). Keep existing `scrub_pii()` unchanged. |

### Acceptance

- [ ] `OutputGuardrailConfig` pydantic model loads from env vars with correct defaults
- [ ] `detect_pii("john@example.com")` → `True`
- [ ] `detect_pii("Hello world")` → `False`
- [ ] `detect_pii("4111111111111111")` → `True` (Luhn valid)
- [ ] Existing `scrub_pii()` behavior unchanged

### Tests

- `test_config_defaults.py` — verify default values load correctly
- `test_pii_detection.py` — parameterized across all 4 PII types (email, phone, passport, card)

---

## Phase 3: Sentence-Boundary Chunking — Token Accumulation

**Depends on**: Phase 2 (uses `max_chunk_tokens` from config)  
**FRs covered**: FR-002, FR-010, FR-011  
**Delivers**: `ChunkBuffer` class

### Files

| File                        | Action | What                                                                                        |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `streaming/chunk_buffer.py` | NEW    | `ChunkBuffer` class with `add_token(token) -> Optional[str]` and `flush() -> Optional[str]` |

### Acceptance

- [ ] Splits on `.` + whitespace + uppercase: `"Hello world. This is next"` → chunk at `". "`
- [ ] Splits on `!` and `?` boundaries
- [ ] Splits on `\n` boundaries
- [ ] Does NOT split inside triple-backtick code fences
- [ ] Does NOT split on abbreviations: `"Dr. Smith"` stays together
- [ ] Does NOT split on decimals: `"$1,234.56"` stays together
- [ ] Force-splits at `max_chunk_tokens` (default 200) when no boundary found
- [ ] `flush()` returns remaining buffer at end-of-stream

### Tests

- `test_chunk_buffer.py` — unit tests for all boundary rules, code fence handling, force-split, flush

---

## Phase 4: NeMo Output Rail — Safety Classification

**Depends on**: Phase 2 (uses `nemo_timeout` from config)  
**FRs covered**: FR-005 (layer 2), FR-012, FR-014  
**Delivers**: `validate_output_chunk()` method on `NemoGuardrailService`

### Files

| File                 | Action | What                                                                                                         |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `guardrails/base.py` | MODIFY | Add `validate_output_chunk(chunk: str) -> Tuple[bool, str]` to `GuardrailService` protocol                   |
| `guardrails/nemo.py` | MODIFY | Implement `validate_output_chunk()` with output-specific system prompt, same httpx call pattern, fail-closed |

### Acceptance

- [ ] `validate_output_chunk("Hello, how can I help?")` → `(True, "")`
- [ ] `validate_output_chunk(<harmful content>)` → `(False, "Output safety violation.")`
- [ ] Fails closed on API timeout → `(False, "Safety check unavailable.")`
- [ ] Fails closed on unexpected classification → `(False, "Output safety violation.")`
- [ ] Uses output-specific system prompt (distinct from input rail)
- [ ] `is_healthy()` reflects output rail availability

### Tests

- `test_output_guardrail_nemo.py` — SAFE/UNSAFE classification, timeout, fail-closed, unexpected response

---

## Phase 5: Output Guardrail Pipeline — Orchestration

**Depends on**: Phase 3 (ChunkBuffer), Phase 4 (NeMo output rail), Phase 2 (PII detection)  
**FRs covered**: FR-001, FR-004, FR-005  
**Delivers**: `OutputGuardrailPipeline` class with layered validation + sliding window

### Files

| File                            | Action | What                                                                                                       |
| ------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `guardrails/output_pipeline.py` | NEW    | `OutputGuardrailPipeline` with `process_token()`, `flush()`, `_validate_chunk()`, `get_partial_response()` |

### Acceptance

- [ ] Tokens fed in → sentence-sized chunks yielded out
- [ ] Regex PII scan runs on each chunk — blocks on PII detection
- [ ] NeMo output rail runs after regex passes — blocks on UNSAFE classification
- [ ] Sliding window: overlap region (tail N-1 + head N) scanned for boundary PII
- [ ] `OutputGuardrailBlockedError` raised on any layer failure
- [ ] `get_partial_response()` returns safe chunks accumulated before block
- [ ] Kill switch: `OUTPUT_GUARDRAIL_ENABLED=false` → tokens pass through unvalidated
- [ ] Regex layer executes first; if it fails, NeMo is skipped

### Tests

- `test_output_pipeline.py` — end-to-end token→chunk→validate→emit flow, PII types, boundary PII, kill switch, layer ordering

---

## Phase 6: SSE Integration — Wire Pipeline Into Streaming

**Depends on**: Phase 5 (OutputGuardrailPipeline)  
**FRs covered**: FR-001, FR-009  
**Delivers**: Output guardrail pipeline active in the SSE streaming producer

### Files

| File               | Action | What                                                                                                                                                                                            |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `streaming/sse.py` | MODIFY | Create `OutputGuardrailPipeline` in producer. Feed `on_chat_model_stream` tokens through it. Yield safe chunks as `token` events. Tool events (`on_tool_start`, `on_tool_end`) bypass pipeline. |

### Acceptance

- [ ] Safe responses stream with sentence-sized `token` events
- [ ] Tool call/result events are NOT processed by output guardrails
- [ ] `confirmation_required` events bypass pipeline
- [ ] When pipeline raises `OutputGuardrailBlockedError`, producer handles it (Phase 7)
- [ ] Existing SSE behavior unchanged when `OUTPUT_GUARDRAIL_ENABLED=false`

### Tests

- Integration tests in `test_sse_output_guardrail.py` — mock LangGraph stream, verify SSE event output with guardrails active vs. disabled

---

## Phase 7: Hard Stop & Partial Persistence — Failure Handling

**Depends on**: Phase 6 (SSE integration)  
**FRs covered**: FR-006, FR-007, FR-008  
**Delivers**: Complete hard stop behavior with partial response persistence

### Files

| File               | Action | What                                                                                                                                                                                      |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `streaming/sse.py` | MODIFY | Add `OutputGuardrailBlockedError` handler in producer: stop consuming tokens, emit `OUTPUT_GUARDRAIL_BLOCKED` error event, persist partial response via NestJS client, log security event |

### Acceptance

- [ ] On guardrail block: stream stops immediately (no more tokens emitted)
- [ ] SSE error event: `{"code": "OUTPUT_GUARDRAIL_BLOCKED", "message": "Response was blocked for safety reasons.", "partialMessageId": "uuid | null"}`
- [ ] Partial response (safe chunks before block) persisted to NestJS via batch message endpoint
- [ ] `partialMessageId` populated when persistence succeeds, `null` when first chunk fails
- [ ] Security event logged with layer + rule that triggered — NO blocked content in logs
- [ ] `done` event is NOT sent after a block (stream ends with error event)

### Tests

- `test_hard_stop.py` — mid-stream block behavior, partial persistence, error event format, log verification

---

## Phase 8: Pipeline Parallelism — Latency Optimization

**Depends on**: Phase 7 (hard stop must work before parallelism)  
**FRs covered**: FR-003  
**Delivers**: Concurrent chunk validation hiding guardrail latency

### Files

| File                            | Action | What                                                                                          |
| ------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `guardrails/output_pipeline.py` | MODIFY | Add `asyncio.Task` one-chunk lookahead: while chunk N streams to user, pre-validate chunk N+1 |

### Acceptance

- [ ] First chunk: unavoidable latency (no overlap)
- [ ] Chunks 2+: guardrail check runs concurrently with previous chunk streaming
- [ ] Pre-validated chunk is yielded immediately when previous chunk streaming completes
- [ ] If pre-validation fails, hard stop triggers before the unsafe chunk would stream
- [ ] No race conditions between concurrent validation and streaming

### Tests

- `test_pipeline_parallelism.py` — timing assertions: chunk 2+ latency < chunk 1 latency, correctness under concurrency

---

## Phase 9: Observability & Logging — Structured Telemetry

**Depends on**: Phase 7 (hard stop logging)  
**FRs covered**: FR-008, FR-015  
**Delivers**: Structured log entries for every guardrail check

### Files

| File                            | Action | What                                                                                                   |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `guardrails/output_pipeline.py` | MODIFY | Emit structured JSON log per chunk: `{timestamp, session_id, chunk_index, layer, verdict, latency_ms}` |
| `streaming/sse.py`              | MODIFY | Pass `session_id` to pipeline for log context                                                          |

### Acceptance

- [ ] Every chunk check emits a structured log entry
- [ ] Log fields: `timestamp`, `session_id`, `chunk_index`, `layer` (regex/nemo/boundary), `verdict` (pass/fail), `latency_ms`
- [ ] Security block events: include `guardrail_layer` and `rule_name` — NEVER include blocked content
- [ ] Log entries use the existing `logger = logging.getLogger("agent.guardrails")` pattern
- [ ] Logs are JSON-formatted (consistent with constitution Principle IV)

### Tests

- `test_guardrail_logging.py` — capture log output, verify structured fields, verify no PII in logs

---

## Phase 10: E2E Testing & Validation — Final Verification

**Depends on**: All previous phases  
**FRs covered**: All (cross-cutting verification)  
**Delivers**: Complete test suite + benchmark results

### Files

| File                                      | Action | What                                            |
| ----------------------------------------- | ------ | ----------------------------------------------- |
| `tests/test_e2e_output_guardrails.py`     | NEW    | Integration tests against running agent service |
| `tests/test_benchmark_output_pipeline.py` | NEW    | Latency benchmarks per guardrail layer          |

### Acceptance — Success Criteria Verification

- [ ] **SC-001**: 100% of LLM output tokens pass through pipeline — verified by log count matching
- [ ] **SC-002**: All 4 PII types detected and blocked 100% — parameterized test suite
- [ ] **SC-003**: Cross-chunk boundary PII detected — test cases with split PII
- [ ] **SC-004**: Regex ≤50ms, total ≤350ms per chunk — benchmark measurements
- [ ] **SC-005**: Partial response persisted correctly on mid-stream block
- [ ] **SC-006**: Zero blocked content in any log entry — log scanning assertion
- [ ] **SC-007**: Pipeline parallelism measurably reduces chunk 2+ latency

### Checklist

- [ ] All unit tests pass (`pytest tests/ -k "output" -v`)
- [ ] E2E tests pass against running service
- [ ] Benchmark results documented
- [ ] Kill switch verified (disabled = baseline behavior)
- [ ] Code fence handling verified
- [ ] Abbreviation/decimal/URL edge cases verified
- [ ] Fail-closed behavior verified (NeMo unavailable → block)
