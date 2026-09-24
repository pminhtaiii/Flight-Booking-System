# Internal Contracts: Chat Turn Decomposition

## GraphEventInterpreter

- Input: existing LangGraph v2 asynchronous event stream, TurnContext, and resolver port.
- Output: asynchronous existing ChatTurnEvent values, including raw TokenEvent values.
- For every validated ToolMessage in `on_chain_end` of the `tools` node: emit safe ToolCallEvent when current rules do, emit the current ToolResultEvent, call resolver once, then emit any specialized follow-up event. Invalid readiness/tool blocks remain fail-closed and do not leak raw payloads.
- `on_tool_end` continues timing telemetry. Model stream, model-end fallback, and node-end fallback retain current deduplication. Interpreter does not inspect tool names, call Redis/NestJS, or construct output guardrails.

## ToolResultResolver

Conceptual port: `resolve(tool_name, validated_result, context) -> optional specialized ChatTurnEvent`. Concrete resolver owns search snapshot projection, booking readiness projection, and checkout handoff projection/rules. Where a current path can block instead of emit, return or raise a typed internal decision for coordinator cleanup; do not turn it into a successful ToolResultEvent. Handoff's existing chain-end nodes remain routed through the same resolver ownership without changing wire order.

## ConversationMemory

- `get_context(session_id, client) -> ValidatedConversationContext`: fetch existing recent history/summary, apply current window/offset, re-scan through gateway, return safe context or fail closed.
- `schedule_compaction(session_id, client, message_count)`: delegate to existing MemoryManager without blocking the SSE turn. Preserve current `totalMessageCount + 2` accounting.

## Admission and SSE

- Shared services: AuthService, InputAdmissionService, QuotaService. FastAPI Depends wrappers invoke them in the current auth → length/gateway health → input scan → quota order. Wrappers contain no policy logic.
- InputAdmissionService returns the current validated decision/data. Blocked PII produces the exact legacy one-event error with zero Redis/quota calls. Gateway unavailable returns existing 503 before scan/quota.
- SSE adapter passes validated input to ChatController and never re-evaluates it. `format_sse(event)` lives in `streaming/sse.py` with the current `event: ...\ndata: ...\n\n` encoding. Domain `events.py` exports event definitions only.

## Coordinator

The coordinator owns one output stream session and all lifecycle cleanup. Only guardrail-approved chunks reach SSE or persistence. On all exits, preserve approved partial persistence → non-flushing close → lease release. Public HTTP/SSE and stored records are unchanged.
