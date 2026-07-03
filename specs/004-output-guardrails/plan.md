# Implementation Plan: LLM Output Guardrails

**Branch**: `004-output-guardrails` | **Date**: 2026-07-03 | **Spec**: [spec.md](file:///c:/Booking%20Systems/specs/004-output-guardrails/spec.md)

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

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Justification |
|-----------|--------|---------------|
| I. Flight-First Architecture | ✅ PASS | Output guardrails protect the flight search conversation flow without blocking or complicating the booking pipeline. |
| II. Deterministic Transaction Boundary | ✅ PASS | Output guardrails operate entirely within the advisory AI agent layer. No booking/payment path changes. |
| III. API Budget Discipline | ⚠️ WATCH | NeMo output rail calls the Mimo classification endpoint once per chunk. A 10-sentence response = 10 API calls. Monitor API budget impact. Regex fast-fail reduces unnecessary NeMo calls. |
| IV. Observability & Operational Visibility | ✅ PASS | Structured logging for every guardrail check (layer, verdict, latency). Security event logging on blocks. |
| V. Incremental Delivery | ✅ PASS | Output guardrails are a self-contained, independently deployable feature. No dependency on frontend changes. |
| Security Requirements | ✅ PASS | Enforces PII protection in LLM output (constitution mandate). No PII in logs. Fail-closed behavior. |

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

## Phase 0: Research — Complete

See [research.md](file:///c:/Booking%20Systems/specs/004-output-guardrails/research.md). All 4 unknowns resolved:

1. ✅ Sentence detection edge cases → heuristic boundary detector
2. ✅ Sliding window token count → 30 tokens default, configurable
3. ✅ NeMo output rail config → reuse Mimo endpoint with output-specific prompt
4. ✅ Streaming UX → out of scope (frontend typewriter animation)

---

## Phase 1: Design & Contracts — Complete

See [data-model.md](file:///c:/Booking%20Systems/specs/004-output-guardrails/data-model.md), [contracts/](file:///c:/Booking%20Systems/specs/004-output-guardrails/contracts/), [quickstart.md](file:///c:/Booking%20Systems/specs/004-output-guardrails/quickstart.md).

### Key Design Decisions

1. **Chunk Buffer** (`chunk_buffer.py`): Accumulates tokens, detects sentence boundaries with code-fence awareness, enforces max chunk size. Pure function — no side effects, easily testable.

2. **Output Pipeline** (`output_pipeline.py`): Orchestrates the full pipeline:
   - Receives token stream from LangGraph
   - Feeds tokens to ChunkBuffer
   - On chunk ready: run sliding window boundary check → regex PII scan → NeMo output rail
   - On pass: yield chunk to SSE stream
   - On fail: hard stop → error event → persist partial → log security event
   - Pipeline parallelism: uses `asyncio.Task` to pre-validate next chunk while current streams

3. **NeMo Output Rail** (`nemo.py` extension): New `validate_output_chunk(chunk: str)` method with output-specific system prompt. Same `httpx` call pattern, same fail-closed behavior.

4. **SSE Integration** (`sse.py` modification): The producer function wraps token events through the output pipeline. Safe chunks are emitted as `token` events (now containing sentence-sized content). Tool events bypass the pipeline.

5. **Configuration** (`config.py` extension):
   - `OUTPUT_GUARDRAIL_OVERLAP_TOKENS`: default 30
   - `OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS`: default 200
   - `OUTPUT_GUARDRAIL_ENABLED`: default True (kill switch)
   - `OUTPUT_GUARDRAIL_NEMO_TIMEOUT`: default 2.0s
