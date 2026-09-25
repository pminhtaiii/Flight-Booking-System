# Data Model: Chat Turn Decomposition

No persistent entity, table, key format, or migration changes. These are transient application values; existing Pydantic event payloads and NestJS/Redis records remain authoritative.

| Concept | Fields / relationship | Invariant |
|---|---|---|
| TurnContext | Session/user identity, validated command, graph configuration, safe memory and snapshot references | One context per admitted turn; no raw unauthorized data reaches graph execution. |
| ValidatedInput | Existing guardrail decision/data passed from SSE admission through ChatController to runner | Evaluated once for SSE admission; direct runner calls retain their existing fallback validation. |
| ValidatedConversationContext | Existing summary and recent messages after fetch, slice, and re-scan | Unsafe history fails closed; unsafe summary follows existing discard behavior. |
| AdmissionContext | Existing user ID, chat session ID, trace ID, correlation ID, and policy version for history re-scan | Values are preserved from the turn; no synthetic replacement identity is created. |
| Tool completion | Guardrail-validated ToolMessage from the `tools` chain-end output, tool name/call ID, and safe content | Resolver receives only the validated result; timing-only `on_tool_end` is not its source. |
| Handoff node completion | Untrusted output of `create_handoff_token`, `create_handoff_token_node`, or `validate_handoff` chain-end | Resolver checks the existing shape and handles rejection/success and force-persistence; coordinator enforces active fence before event delivery. |
| Tool resolution | Accepted result with safe summary override and optional specialized follow-up, or blocked result with safe error code/message | Resolve before ToolResultEvent; invalid readiness emits no result. |
| Action projection | Optional ActionRequiredEvent or ActionHandoffEvent based on existing projection rules | Coordinator validates the active fence before external emission. |
| Output stream session | One gateway-owned session for one turn, approved partial response, flush/close state | Every model-output branch passes through it; close never flushes. |
| Turn lease | Existing queue request ID/fencing token and release state | Cleanup persists approved partial response, closes output session, then releases lease. |

**Transitions**: Admission → session/lease → safe memory/snapshot → graph events → approved output → final persistence/compaction → cleanup. Any block or exception goes to fail-closed cleanup with existing event and release behavior.
