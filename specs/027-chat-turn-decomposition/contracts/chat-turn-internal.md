# Internal Contracts: Chat Turn Decomposition

## GraphEventInterpreter

- Input: existing LangGraph v2 asynchronous event stream, TurnContext, and resolver port.
- Output: asynchronous existing ChatTurnEvent values, including raw TokenEvent values.
- For every guardrail-validated ToolMessage in `on_chain_end` of the `tools` node: emit safe ToolCallEvent when current rules do, call resolver once, then either raise a typed projection-block decision for coordinator cleanup or emit ToolResultEvent with its safe summary and any specialized follow-up. Invalid readiness emits no ToolResultEvent. No raw payload leaks.
- `on_tool_end` continues timing telemetry. Model stream, model-end fallback, and node-end fallback retain current deduplication. Interpreter does not inspect tool names, call Redis/NestJS, or construct output guardrails.

## ToolResultResolver

Conceptual tool port: `resolve(tool_name, validated_result, context) -> ToolResolution`, where ToolResolution is either an accepted result carrying a safe ToolResultEvent summary override and optional specialized follow-up, or a blocked result carrying the current safe error code/message. Non-significant tools return an accepted result with no follow-up. Invalid booking readiness returns a block before ToolResultEvent. The concrete resolver owns search snapshot and readiness projection.

Conceptual node port: `resolve_handoff_node(node_name, node_output, context) -> HandoffResolution`. Its input is the existing chain-end node name (`create_handoff_token`, `create_handoff_token_node`, or `validate_handoff`) and untrusted output object; the resolver applies the current shape/error checks before projection. HandoffResolution is no event, an accepted ActionHandoffEvent with `force_persistence`, or a blocked `HANDOFF_FAILED` decision with safe message/detail. The interpreter routes only those node completions to this entry point and remains tool-name-agnostic. Blocked ToolResolution or HandoffResolution raises an internal projection-block decision carrying only the safe code/message/detail; it is never yielded as a ChatTurnEvent. The coordinator catches it and performs existing cleanup. The coordinator checks the active fence before forwarding ActionRequiredEvent or ActionHandoffEvent; a stale fence retains the current PERSISTENCE_ERROR path and emits no action event.

## ConversationMemory

- `get_context(session_id, client, admission_context: AdmissionContext) -> ValidatedConversationContext`: fetch existing recent history/summary, apply current window/offset, re-scan through gateway using the exact per-turn user/session/trace/correlation/policy values, return safe context or fail closed.
- `schedule_compaction(session_id, client, message_count)`: delegate to existing MemoryManager without blocking the SSE turn. Preserve current `totalMessageCount + 2` accounting.

## Admission and SSE

- Shared services: AuthService, InputAdmissionService, QuotaService. FastAPI Depends wrappers invoke them in the current auth → length/gateway health → input scan → quota order. Wrappers contain no policy logic.
- InputAdmissionService returns the current validated decision/data. Blocked PII produces the exact legacy one-event error with zero Redis/quota calls. Gateway unavailable returns existing 503 before scan/quota.
- SSE adapter passes validated input to ChatController and never re-evaluates it. `format_sse(event)` lives in `streaming/sse.py` with the current `event: ...\ndata: ...\n\n` encoding. Domain `events.py` exports event definitions only.

## Coordinator

The coordinator owns one output stream session and all lifecycle cleanup. Only guardrail-approved chunks reach SSE or persistence. On all exits, preserve approved partial persistence → non-flushing close → lease release. Public HTTP/SSE and stored records are unchanged.
