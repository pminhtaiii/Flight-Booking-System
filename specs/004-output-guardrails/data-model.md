# Data Model: LLM Output Guardrails

**Feature**: 004-output-guardrails | **Date**: 2026-07-03

**Input**: [spec.md](file:///c:/Booking%20Systems/specs/004-output-guardrails/spec.md), [research.md](file:///c:/Booking%20Systems/specs/004-output-guardrails/research.md)

---

## Entities

### 1. OutputGuardrailConfig

Configuration model for the output guardrail pipeline. Loaded from environment variables via `config.py`.

| Field              | Type    | Default | Env Var                             | Description                                                      |
| ------------------ | ------- | ------- | ----------------------------------- | ---------------------------------------------------------------- |
| `enabled`          | `bool`  | `True`  | `OUTPUT_GUARDRAIL_ENABLED`          | Kill switch — disables output guardrails entirely when False     |
| `overlap_tokens`   | `int`   | `30`    | `OUTPUT_GUARDRAIL_OVERLAP_TOKENS`   | Number of tokens from previous chunk tail used in sliding window |
| `max_chunk_tokens` | `int`   | `200`   | `OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS` | Force-split threshold for chunks without sentence boundaries     |
| `nemo_timeout`     | `float` | `2.0`   | `OUTPUT_GUARDRAIL_NEMO_TIMEOUT`     | Timeout in seconds for NeMo classification API call              |

---

### 2. ChunkBuffer

Accumulates incoming LLM tokens and produces sentence-boundary chunks. Tracks code fence state to avoid splitting inside code blocks.

| Field              | Type   | Description                                                                 |
| ------------------ | ------ | --------------------------------------------------------------------------- |
| `buffer`           | `str`  | Accumulated token text not yet emitted as a chunk                           |
| `in_code_fence`    | `bool` | Whether the current position is inside a triple-backtick code block         |
| `token_count`      | `int`  | Approximate token count of the current buffer (1 token ≈ 4 chars heuristic) |
| `max_chunk_tokens` | `int`  | Force-split threshold from config                                           |

**Methods**:

| Method      | Signature                       | Returns                | Description                                                                                                                                 |
| ----------- | ------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `add_token` | `(token: str) -> Optional[str]` | Chunk text or None     | Adds a token to the buffer. Returns a complete chunk if sentence boundary detected or max size reached. Returns None if still accumulating. |
| `flush`     | `() -> Optional[str]`           | Remaining text or None | Forces emission of remaining buffer content (called at end of stream).                                                                      |

**Sentence boundary detection rules** (from research):

1. Character is `.`, `!`, `?`, or `\n`
2. Next non-whitespace char is uppercase OR end-of-stream
3. NOT inside code fence
4. `.` NOT preceded by single uppercase letter (abbreviation)
5. `.` NOT preceded by only digits (decimal number)
6. `.` NOT part of a URL (e.g., `example.com`) or email address (e.g., `john.doe@domain.com`)

---

### 3. SlidingWindow

Maintains the tail tokens of the previous chunk for cross-boundary PII detection.

| Field            | Type  | Description                                         |
| ---------------- | ----- | --------------------------------------------------- |
| `tail_text`      | `str` | Last N tokens worth of text from the previous chunk |
| `overlap_tokens` | `int` | Number of tokens to retain (default 30)             |

**Methods**:

| Method               | Signature                  | Returns           | Description                                                                  |
| -------------------- | -------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `update`             | `(chunk: str) -> None`     | None              | Replaces tail_text with the last `overlap_tokens` tokens of the given chunk. |
| `get_overlap_region` | `(next_chunk: str) -> str` | Concatenated text | Returns `tail_text + head_N_tokens(next_chunk)` for boundary PII scanning.   |

---

### 4. OutputGuardrailResult

Result of a guardrail check on a single chunk.

| Field         | Type   | Description                                             |
| ------------- | ------ | ------------------------------------------------------- |
| `passed`      | `bool` | Whether the chunk passed all guardrail layers           |
| `layer`       | `str`  | Which layer produced the verdict: `"regex"` or `"nemo"` |
| `reason`      | `str`  | Human-readable reason if blocked (empty if passed)      |
| `latency_ms`  | `int`  | Time taken for the check in milliseconds                |
| `chunk_index` | `int`  | 0-based index of the chunk in the current response      |

> [!NOTE]
> The boundary check is executed as a separate precheck on the overlap window. If the boundary check fails (detecting structured PII), it is reported under the `"regex"` layer.

```python
class OutputGuardrailResult(BaseModel):
    passed: bool
    layer: str  # "regex" | "nemo"
    reason: str
    latency_ms: int
    chunk_index: int
```

---

### 5. OutputGuardrailPipeline

Orchestrates the full output guardrail flow. Stateful per-response — created fresh for each SSE stream.

| Field            | Type                    | Description                                             |
| ---------------- | ----------------------- | ------------------------------------------------------- |
| `config`         | `OutputGuardrailConfig` | Pipeline configuration                                  |
| `chunk_buffer`   | `ChunkBuffer`           | Token accumulator                                       |
| `sliding_window` | `SlidingWindow`         | Cross-chunk overlap tracker                             |
| `chunk_index`    | `int`                   | Current chunk counter                                   |
| `safe_chunks`    | `list[str]`             | Chunks that passed guardrails (for partial persistence) |
| `is_stopped`     | `bool`                  | Whether hard stop has been triggered                    |

**Methods**:

| Method                 | Signature                                         | Returns            | Description                                                                                                                            |
| ---------------------- | ------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `process_token`        | `async (token: str) -> AsyncGenerator[str, None]` | Yields safe chunks | Feeds token to buffer. When a chunk is ready, validates it. Yields the chunk if safe. Raises `OutputGuardrailBlockedError` if blocked. |
| `flush`                | `async () -> AsyncGenerator[str, None]`           | Yields final chunk | Flushes remaining buffer and validates. Called at end of LLM stream.                                                                   |
| `_validate_chunk`      | `async (chunk: str) -> OutputGuardrailResult`     | Validation result  | Runs the layered guardrail check: boundary → regex → NeMo.                                                                             |
| `get_partial_response` | `() -> str`                                       | Safe text          | Returns concatenated safe_chunks for partial persistence on hard stop.                                                                 |

---

### 6. OutputGuardrailBlockedError

Custom exception raised when a chunk fails any guardrail layer.

| Field              | Type                    | Description                               |
| ------------------ | ----------------------- | ----------------------------------------- |
| `result`           | `OutputGuardrailResult` | The failing guardrail result              |
| `partial_response` | `str`                   | Safe content accumulated before the block |

---

## SSE Event Extension

New error code added to the existing SSE error event contract:

| Code                       | Description                                    | Emitted When                                                        |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `OUTPUT_GUARDRAIL_BLOCKED` | LLM output blocked by output safety guardrails | Any chunk fails regex PII scan, NeMo output rail, or boundary check |

**Event payload**:

```json
{
  "code": "OUTPUT_GUARDRAIL_BLOCKED",
  "message": "Response was blocked for safety reasons.",
  "partialMessageId": "uuid | null"
}
```

The `partialMessageId` is the ID of the persisted partial response (if any safe chunks were streamed before the block). It is `null` if the first chunk failed.

---

## Relationships

```
OutputGuardrailPipeline
├── uses → ChunkBuffer (1:1, per response)
├── uses → SlidingWindow (1:1, per response)
├── uses → OutputGuardrailConfig (shared, singleton)
├── calls → pii_scrubber.scrub_pii() patterns (regex detection, not scrubbing)
├── calls → NemoGuardrailService.validate_output_chunk() (NeMo classification)
├── produces → OutputGuardrailResult (per chunk)
└── raises → OutputGuardrailBlockedError (on failure)

SSE Producer (sse.py)
├── creates → OutputGuardrailPipeline (per request)
├── feeds → tokens from LangGraph astream_events
├── receives → safe chunks from pipeline
├── emits → SSE token events (sentence-sized)
└── handles → OutputGuardrailBlockedError → SSE error event
```

---

## State Transitions

```
ChunkBuffer states:
  ACCUMULATING → (sentence boundary detected) → CHUNK_READY
  ACCUMULATING → (max chunk size reached) → CHUNK_READY
  ACCUMULATING → (end of stream) → FLUSH → CHUNK_READY
  CHUNK_READY → (chunk consumed) → ACCUMULATING

OutputGuardrailPipeline states:
  ACTIVE → (chunk passes all layers) → ACTIVE (yield chunk)
  ACTIVE → (chunk fails any layer) → STOPPED (raise error)
  ACTIVE → (end of stream) → COMPLETE (flush + final check)
  STOPPED → (no further processing)
```
