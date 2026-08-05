# Quickstart Validation Guide: LLM Output Guardrails

**Feature**: 004-output-guardrails | **Date**: 2026-07-03

---

## Prerequisites

1. **Agent service running**: `apps/agent/` with FastAPI on port 3002
2. **NestJS API running**: `apps/api/` on port 3001 (for persistence)
3. **Environment variables set**:
   - `MIMO_API_URL` and `MIMO_API_KEY` — for NeMo output rail classification
   - `OUTPUT_GUARDRAIL_ENABLED=true`
   - `OUTPUT_GUARDRAIL_OVERLAP_TOKENS=30`
   - `OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS=200`
4. **Valid JWT token** for authenticated requests

---

## Scenario 1: Safe Response Streams Normally

**Purpose**: Verify that safe LLM output passes through the guardrail pipeline without being blocked.

**Steps**:

```bash
# Send a normal chat message
curl -N -X POST http://localhost:3002/chat/stream \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"message": "What airlines fly from Hanoi to Tokyo?", "sessionId": null}'
```

**Expected outcome**:

- SSE stream contains `token` events with sentence-sized content
- Stream ends with a `done` event containing `messageId` and `sessionId`
- No `error` events with code `OUTPUT_GUARDRAIL_BLOCKED`
- Agent logs show structured entries: `layer=regex, verdict=pass` and `layer=nemo, verdict=pass` for each chunk

---

## Scenario 2: PII in Output Triggers Hard Stop

**Purpose**: Verify that PII patterns in LLM output are caught by the regex PII scanner and trigger a hard stop.

**Steps**:

This scenario requires either:

- (a) A test-mode LLM endpoint that returns a response containing PII, or
- (b) A unit test that feeds PII-containing tokens directly to the pipeline

**Unit test approach** (recommended):

```python
# In tests/test_output_pipeline.py
async def test_email_in_output_triggers_block():
    pipeline = OutputGuardrailPipeline(config=test_config, nemo_service=mock_nemo)

    # Feed tokens that form a sentence with an email
    tokens = ["Please ", "contact ", "john.doe@example.com ", "for ", "details."]

    with pytest.raises(OutputGuardrailBlockedError) as exc_info:
        for token in tokens:
            async for _ in pipeline.process_token(token):
                pass
        async for _ in pipeline.flush():
            pass

    assert exc_info.value.result.layer == "regex"
    assert exc_info.value.result.passed is False
```

**Expected outcome**:

- `OutputGuardrailBlockedError` raised with `layer="regex"`
- No safe chunks yielded (PII detected on first/only chunk)
- `partial_response` is empty (first chunk failed)

---

## Scenario 3: Boundary PII Detected by Sliding Window

**Purpose**: Verify that PII spanning two chunks is caught by the cross-chunk sliding window.

**Unit test approach**:

```python
async def test_boundary_email_detection():
    pipeline = OutputGuardrailPipeline(config=test_config, nemo_service=mock_nemo_safe)

    # Chunk 1: ends with partial email — passes regex on its own
    chunk1_tokens = ["Please ", "contact ", "john.doe@"]
    # Force a sentence boundary after chunk 1
    chunk1_tokens.append("Something else. ")

    # Chunk 2: starts with domain — passes regex on its own
    chunk2_tokens = ["Gmail.com ", "is ", "the ", "provider. "]

    # Process chunk 1 — should pass (no complete email pattern)
    for token in chunk1_tokens:
        async for safe_chunk in pipeline.process_token(token):
            pass  # chunk 1 passes

    # Process chunk 2 — sliding window should catch "john.doe@" + "Gmail.com"
    with pytest.raises(OutputGuardrailBlockedError) as exc_info:
        for token in chunk2_tokens:
            async for _ in pipeline.process_token(token):
                pass

    assert exc_info.value.result.layer == "regex"
```

**Expected outcome**:

- Chunk 1 passes guardrails (no complete PII pattern)
- Chunk 2 triggers boundary check failure (sliding window overlap reveals complete email)
- `partial_response` contains chunk 1 text only

---

## Scenario 4: NeMo Output Rail Blocks Harmful Content

**Purpose**: Verify that content passing regex PII scan but classified UNSAFE by NeMo is blocked.

**Unit test approach**:

```python
async def test_nemo_unsafe_classification_blocks():
    # Mock NeMo to return UNSAFE for any chunk containing "harmful"
    mock_nemo = MockNemoService(unsafe_keywords=["harmful"])
    pipeline = OutputGuardrailPipeline(config=test_config, nemo_service=mock_nemo)

    tokens = ["This ", "contains ", "harmful ", "content. "]

    with pytest.raises(OutputGuardrailBlockedError) as exc_info:
        for token in tokens:
            async for _ in pipeline.process_token(token):
                pass
        async for _ in pipeline.flush():
            pass

    assert exc_info.value.result.layer == "nemo"
```

**Expected outcome**:

- Regex PII scan passes (no PII patterns)
- NeMo classifies chunk as UNSAFE
- Hard stop triggered with `layer="nemo"`

---

## Scenario 5: Partial Response Persisted on Block

**Purpose**: Verify that when a mid-stream block occurs, safe chunks streamed before the block are persisted.

**Integration test approach** (requires NestJS API):

```python
async def test_partial_persistence_on_mid_stream_block():
    # Stream 3 chunks: chunk 1 safe, chunk 2 safe, chunk 3 has PII
    # After block, verify chunks 1+2 are persisted as partial response

    # ... setup pipeline and feed tokens for 3 sentences ...
    # Sentence 1: "Vietnam Airlines has daily flights."  → safe
    # Sentence 2: "The price starts at $500."  → safe
    # Sentence 3: "Contact support at john@airline.com for help."  → blocked

    # Verify: partial_response = "Vietnam Airlines has daily flights. The price starts at $500. "
    # Verify: NestJS API received persistence call with partial content
    # Verify: SSE error event contains partialMessageId
```

**Expected outcome**:

- Chunks 1-2 streamed to user and persisted
- Chunk 3 blocked
- `partialMessageId` is non-null in the error event

---

## Scenario 6: Kill Switch Disables Guardrails

**Purpose**: Verify that setting `OUTPUT_GUARDRAIL_ENABLED=false` bypasses the pipeline.

**Steps**:

1. Set `OUTPUT_GUARDRAIL_ENABLED=false` in environment
2. Send a message that would normally trigger the guardrail
3. Verify response streams token-by-token (no sentence chunking)

**Expected outcome**:

- Tokens stream directly without guardrail pipeline
- No structured guardrail log entries
- Behavior matches pre-feature baseline

---

## Running Tests

```bash
# Unit tests for output guardrail pipeline
cd apps/agent
python -m pytest tests/test_output_pipeline.py -v

# Unit tests for sentence boundary detection
python -m pytest tests/test_chunk_buffer.py -v

# Unit tests for NeMo output rail
python -m pytest tests/test_output_guardrail_nemo.py -v

# All output guardrail tests
python -m pytest tests/ -k "output" -v
```

---

## Verification Checklist

- [ ] Safe responses stream with sentence-sized token events
- [ ] Email, phone, passport, credit card patterns in output trigger hard stop
- [ ] Boundary PII (spanning chunks) detected by sliding window
- [ ] NeMo UNSAFE classification triggers hard stop
- [ ] Partial response persisted on mid-stream block
- [ ] Security logs contain guardrail metadata, never blocked content
- [ ] Kill switch disables guardrails completely
- [ ] Pipeline parallelism hides latency for chunks 2+
- [ ] Code blocks are not split at internal `.` characters
- [ ] Force-split triggers at max chunk size
