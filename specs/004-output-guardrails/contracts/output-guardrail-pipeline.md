# Contract: Output Guardrail Pipeline

**Feature**: 004-output-guardrails | **Date**: 2026-07-03

---

## Pipeline Public Interface

The output guardrail pipeline exposes a simple async generator interface that the SSE producer consumes.

### Integration Point

The SSE producer (`sse.py`) creates an `OutputGuardrailPipeline` per request and feeds LLM tokens through it. Safe chunks are yielded back. On guardrail failure, `OutputGuardrailBlockedError` is raised.

```python
# In SSE producer (sse.py)
pipeline = OutputGuardrailPipeline(config=output_config, nemo_service=guardrails)

try:
    async for event in event_stream:
        if kind == "on_chat_model_stream":
            token_content = chunk.content
            async for safe_chunk in pipeline.process_token(token_content):
                partial_response += safe_chunk
                await q.put({"event": "token", "data": json.dumps({"content": safe_chunk})})

    # End of stream — flush remaining buffer
    async for safe_chunk in pipeline.flush():
        partial_response += safe_chunk
        await q.put({"event": "token", "data": json.dumps({"content": safe_chunk})})

except OutputGuardrailBlockedError as e:
    # Hard stop: persist partial, send error, log
    partial_response = e.partial_response
    # ... persist partial_response ...
    await q.put({
        "event": "error",
        "data": json.dumps({
            "code": "OUTPUT_GUARDRAIL_BLOCKED",
            "message": "Response was blocked for safety reasons.",
            "partialMessageId": partial_message_id
        })
    })
```

### Key Behaviors

1. **Token events only**: Only `on_chat_model_stream` tokens flow through the pipeline. `tool_call`, `tool_result`, `confirmation_required` bypass it entirely.
2. **Sentence-sized chunks**: The SSE `token` event now contains a full sentence (or force-split chunk) instead of a single token. The frontend should implement typewriter animation.
3. **Hard stop propagation**: `OutputGuardrailBlockedError` propagates up to the producer, which handles persistence and error event emission.
4. **Kill switch**: When `OUTPUT_GUARDRAIL_ENABLED=false`, the pipeline passes tokens through without validation.

---

## OutputGuardrailService Protocol Extension

The existing `GuardrailService` protocol in `base.py` handles input validation. The output guardrail extends this with a new method.

### Current Protocol (input)

```python
class GuardrailService(Protocol):
    async def validate_message(self, message: str) -> Tuple[bool, str]: ...
    def is_healthy(self) -> bool: ...
```

### Extended Protocol (input + output)

```python
class GuardrailService(Protocol):
    async def validate_message(self, message: str) -> Tuple[bool, str]: ...
    async def validate_output_chunk(self, chunk: str) -> Tuple[bool, str]: ...
    def is_healthy(self) -> bool: ...
```

The `validate_output_chunk` method:
- Takes a chunk of LLM output text
- Returns `(True, "")` if safe, `(False, reason)` if unsafe
- Uses the output-specific system prompt (see research.md Finding 3)
- Shares the same fail-closed behavior as `validate_message`
- Shares the same health tracking

---

## SSE Event Contract Changes

### Existing Events (unchanged)

| Event | Payload | Description |
|-------|---------|-------------|
| `token` | `{"content": "<text>"}` | Incremental response text |
| `done` | `{"messageId": "<uuid>", "sessionId": "<uuid>"}` | Response complete |
| `error` | `{"code": "<CODE>", "message": "<text>", "partialMessageId": "<uuid|null>"}` | Error occurred |
| `tool_call` | `{"name": "<tool>", "inputs": {...}}` | Tool invoked |
| `tool_result` | `{"name": "<tool>", "result": "<summary>"}` | Tool completed |
| `confirmation_required` | `{"action": "<desc>", ...}` | Write tool needs approval |

### New Error Code

| Code | Description |
|------|-------------|
| `OUTPUT_GUARDRAIL_BLOCKED` | LLM output blocked by output safety guardrails |

This code is used in the existing `error` event — no new event type is needed. The error event payload includes `partialMessageId` which is the ID of the persisted partial response (safe chunks streamed before the block).

### Behavioral Change

The `token` event payload now contains sentence-sized text instead of single tokens when output guardrails are enabled. This is backward compatible — the frontend already handles arbitrary-length `content` strings.

---

## Configuration Contract

| Env Var | Type | Default | Description |
|---------|------|---------|-------------|
| `OUTPUT_GUARDRAIL_ENABLED` | bool | `true` | Kill switch for output guardrails |
| `OUTPUT_GUARDRAIL_OVERLAP_TOKENS` | int | `30` | Sliding window overlap size |
| `OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS` | int | `200` | Max chunk size before force-split |
| `OUTPUT_GUARDRAIL_NEMO_TIMEOUT` | float | `2.0` | NeMo classification timeout (seconds) |

All values configurable per deployment without code changes. Added to `apps/agent/src/agent/config.py` via pydantic `BaseSettings`.
