# Contract: SSE Event Protocol

**Feature**: 003 — Agent Tool-Calling & Data Access
**Phase**: 1 — Design Contracts
**Date**: 2026-07-01

---

## Overview

Extension of the existing SSE streaming protocol to support tool-calling events. Three new event types are added alongside the existing `token`, `done`, and `error` events.

**Endpoint**: `POST /api/chat/send` (existing — unchanged)

**Content-Type**: `text/event-stream`

---

## Event Types

### Existing Events (Unchanged)

#### `token`

Streaming LLM token. Emitted as the agent generates response text.

```
data: {"type": "token", "content": "string"}
```

| Field     | Type   | Description                          |
|-----------|--------|--------------------------------------|
| `type`    | string | Always `"token"`                     |
| `content` | string | The text token fragment              |

#### `done`

Stream completion signal. Emitted once when the agent's turn is fully complete.

```
data: {"type": "done"}
```

| Field  | Type   | Description      |
|--------|--------|------------------|
| `type` | string | Always `"done"`  |

#### `error`

Error signal. Emitted when a fatal error terminates the stream.

```
data: {"type": "error", "code": "string", "message": "string"}
```

| Field     | Type   | Description                     |
|-----------|--------|---------------------------------|
| `type`    | string | Always `"error"`                |
| `code`    | string | Machine-readable error code     |
| `message` | string | Human-readable error description|

---

### New Events

#### `tool_call`

Emitted when the agent invokes a tool. Enables the frontend to show status feedback (e.g., "Searching flights...").

```
data: {"type": "tool_call", "tool": "string", "params": {}}
```

| Field    | Type   | Description                                       |
|----------|--------|---------------------------------------------------|
| `type`   | string | Always `"tool_call"`                               |
| `tool`   | string | Tool name (`search_flights`, `get_user_preferences`, `list_user_bookings`) |
| `params` | object | Sanitized parameters passed to the tool (PII-free) |

**Example**:

```
data: {"type": "tool_call", "tool": "search_flights", "params": {"origin": "HAN", "destination": "NRT", "date": "2026-07-15", "passengers": 2}}
```

#### `tool_result`

Emitted when a tool returns its result. Provides a brief summary for frontend status updates (e.g., "Found 5 flights").

```
data: {"type": "tool_result", "tool": "string", "summary": "string"}
```

| Field     | Type   | Description                                      |
|-----------|--------|--------------------------------------------------|
| `type`    | string | Always `"tool_result"`                            |
| `tool`    | string | Tool name that produced the result                |
| `summary` | string | Brief human-readable summary of the result        |

**Example**:

```
data: {"type": "tool_result", "tool": "search_flights", "summary": "Found 3 flights from HAN to NRT"}
```

#### `confirmation_required`

Emitted when a tool marked `requires_confirmation: true` is invoked. Suspends the graph and waits for user approval. **Dormant in this phase** — no write tools are implemented, but the event type is defined and the confirmation gate is architecturally functional.

```
data: {"type": "confirmation_required", "action": "string", "details": {}}
```

| Field     | Type   | Description                                        |
|-----------|--------|----------------------------------------------------|
| `type`    | string | Always `"confirmation_required"`                    |
| `action`  | string | Proposed action description (e.g., `"book_flight"`) |
| `details` | object | Action parameters for user review                   |

**Example** (future — not emitted in this phase):

```
data: {"type": "confirmation_required", "action": "book_flight", "details": {"flightNumber": "VN310", "date": "2026-07-15", "passengers": 2, "price": 904.00, "currency": "USD"}}
```

---

## Event Sequences

### (a) Simple Chat — No Tools

User asks a question the agent can answer from its own knowledge or conversation context. No tool calls are made.

```
Client → POST /api/chat/send  {"message": "What is IATA?"}

Server →
data: {"type": "token", "content": "IATA"}
data: {"type": "token", "content": " stands"}
data: {"type": "token", "content": " for"}
data: {"type": "token", "content": " the"}
data: {"type": "token", "content": " International"}
data: {"type": "token", "content": " Air"}
data: {"type": "token", "content": " Transport"}
data: {"type": "token", "content": " Association."}
data: {"type": "done"}
```

**Sequence**: `token*` → `done`

---

### (b) Single Tool Call

User asks a question that triggers one tool invocation.

```
Client → POST /api/chat/send  {"message": "Find flights from Hanoi to Tokyo on July 15"}

Server →
data: {"type": "tool_call", "tool": "search_flights", "params": {"origin": "HAN", "destination": "NRT", "date": "2026-07-15", "passengers": 1}}
data: {"type": "tool_result", "tool": "search_flights", "summary": "Found 3 flights from HAN to NRT"}
data: {"type": "token", "content": "I"}
data: {"type": "token", "content": " found"}
data: {"type": "token", "content": " 3"}
data: {"type": "token", "content": " flights"}
data: {"type": "token", "content": " from"}
data: {"type": "token", "content": " Hanoi"}
data: {"type": "token", "content": " to"}
data: {"type": "token", "content": " Tokyo..."}
data: {"type": "done"}
```

**Sequence**: `tool_call` → `tool_result` → `token*` → `done`

---

### (c) Multi-Tool Call

User asks a question that requires multiple tool invocations (e.g., preferences + flight search for personalized recommendations).

```
Client → POST /api/chat/send  {"message": "Find flights that match my preferences from Hanoi to Tokyo on July 15"}

Server →
data: {"type": "tool_call", "tool": "get_user_preferences", "params": {}}
data: {"type": "tool_result", "tool": "get_user_preferences", "summary": "Retrieved travel preferences"}
data: {"type": "tool_call", "tool": "search_flights", "params": {"origin": "HAN", "destination": "NRT", "date": "2026-07-15", "passengers": 1}}
data: {"type": "tool_result", "tool": "search_flights", "summary": "Found 5 flights from HAN to NRT"}
data: {"type": "token", "content": "Based"}
data: {"type": "token", "content": " on"}
data: {"type": "token", "content": " your"}
data: {"type": "token", "content": " preference"}
data: {"type": "token", "content": " for"}
data: {"type": "token", "content": " business"}
data: {"type": "token", "content": " class..."}
data: {"type": "done"}
```

**Sequence**: (`tool_call` → `tool_result`)+ → `token*` → `done`

> **Note**: The agent may interleave tokens between tool calls (e.g., emitting "Let me check your preferences first..." before the second tool call). The sequence above shows the minimal case where the agent chains tools without intermediate tokens.

---

### (d) Confirmation Flow (Dormant — Future Write Tools)

A write tool is invoked, triggering the confirmation gate. The graph suspends until the user responds.

```
Client → POST /api/chat/send  {"message": "Book the Vietnam Airlines flight"}

Server →
data: {"type": "tool_call", "tool": "book_flight", "params": {"flightNumber": "VN310", "date": "2026-07-15", "passengers": 1}}
data: {"type": "confirmation_required", "action": "book_flight", "details": {"flightNumber": "VN310", "date": "2026-07-15", "passengers": 1, "price": 452.00, "currency": "USD"}}

--- stream suspends, waiting for user confirmation ---

Client → POST /api/chat/confirm  {"confirmed": true}

Server →
data: {"type": "tool_result", "tool": "book_flight", "summary": "Flight VN310 booked successfully"}
data: {"type": "token", "content": "Your"}
data: {"type": "token", "content": " flight"}
data: {"type": "token", "content": " has"}
data: {"type": "token", "content": " been"}
data: {"type": "token", "content": " booked!"}
data: {"type": "done"}
```

**Sequence (confirmed)**: `tool_call` → `confirmation_required` → *(suspend)* → `tool_result` → `token*` → `done`

**Sequence (declined)**:

```
Client → POST /api/chat/confirm  {"confirmed": false}

Server →
data: {"type": "token", "content": "No"}
data: {"type": "token", "content": " problem,"}
data: {"type": "token", "content": " I've"}
data: {"type": "token", "content": " cancelled"}
data: {"type": "token", "content": " the"}
data: {"type": "token", "content": " booking."}
data: {"type": "done"}
```

**Sequence (declined)**: `tool_call` → `confirmation_required` → *(suspend)* → `token*` → `done`

---

## Error During Tool Call

If a tool call fails (e.g., gateway timeout), the error is handled gracefully — the agent receives the error message as a tool result and informs the user conversationally. The `error` event type is reserved for fatal stream errors that terminate the connection.

```
Server →
data: {"type": "tool_call", "tool": "search_flights", "params": {"origin": "HAN", "destination": "NRT", "date": "2026-07-15", "passengers": 1}}
data: {"type": "tool_result", "tool": "search_flights", "summary": "Flight search unavailable — service error"}
data: {"type": "token", "content": "I'm"}
data: {"type": "token", "content": " sorry,"}
data: {"type": "token", "content": " the"}
data: {"type": "token", "content": " flight"}
data: {"type": "token", "content": " search"}
data: {"type": "token", "content": " service"}
data: {"type": "token", "content": " is"}
data: {"type": "token", "content": " temporarily"}
data: {"type": "token", "content": " unavailable."}
data: {"type": "done"}
```

**Sequence**: `tool_call` → `tool_result` (with error summary) → `token*` → `done`

The stream completes normally with `done` — tool errors are **non-fatal**.
