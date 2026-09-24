# Data Model: Chat Turn Decomposition

No persistent entity, table, key format, or migration changes. These are transient application values; existing Pydantic event payloads and NestJS/Redis records remain authoritative.

| Concept | Fields / relationship | Invariant |
|---|---|---|
| TurnContext | Session/user identity, validated command, graph configuration, safe memory and snapshot references | One context per admitted turn; no raw unauthorized data reaches graph execution. |
| ValidatedInput | Existing guardrail decision/data passed from SSE admission through ChatController to runner | Evaluated once for SSE admission; direct runner calls retain their existing fallback validation. |
| ValidatedConversationContext | Existing summary and recent messages after fetch, slice, and re-scan | Unsafe history fails closed; unsafe summary follows existing discard behavior. |
| Tool completion | Guardrail-validated ToolMessage from the `tools` chain-end output, tool name/call ID, and safe content | Resolver receives only the validated result; timing-only `on_tool_end` is not its source. |
| Tool projection | Optional FlightResultsEvent, ActionRequiredEvent, or ActionHandoffEvent based on existing projection rules | Existing ToolResultEvent and specialized follow-up ordering is preserved. |
| Output stream session | One gateway-owned session for one turn, approved partial response, flush/close state | Every model-output branch passes through it; close never flushes. |
| Turn lease | Existing queue request ID/fencing token and release state | Cleanup persists approved partial response, closes output session, then releases lease. |

**Transitions**: Admission → session/lease → safe memory/snapshot → graph events → approved output → final persistence/compaction → cleanup. Any block or exception goes to fail-closed cleanup with existing event and release behavior.
