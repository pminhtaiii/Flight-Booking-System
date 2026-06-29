# API Contracts: Python Agent SSE API

**Service**: `apps/agent` (Python/FastAPI) | **Consumer**: `apps/web` (Next.js frontend)

All endpoints require `Authorization: Bearer <jwt_token>` header.
Base URL: `http://localhost:3002`

---

## CORS Configuration

The Python Agent service MUST enable CORS to allow the Next.js frontend (`FRONTEND_URL`, e.g. `http://localhost:3000`) to access the Server-Sent Events endpoint directly from the browser:
- `allow_origins`: `[FRONTEND_URL]`
- `allow_credentials`: `true`
- `allow_methods`: `["*"]`
- `allow_headers`: `["*"]`

---

## POST /chat/stream

Send a message and receive a streaming response via SSE.

**Request**:
```json
{
  "sessionId": "uuid | null",
  "message": "string"
}
```

**Notes**:
- If `sessionId` is null or omitted, the agent automatically creates a new session in NestJS on behalf of the user, and returns the new `sessionId` in the `done` event.

**Response**: SSE event stream (Content-Type: `text/event-stream`)

### SSE Events

**Token event** — incremental response token:
```
event: token
data: {"content": "Hello"}
```

**Done event** — response complete:
```
event: done
data: {"messageId": "uuid", "sessionId": "uuid"}
```

**Error event** — error occurred:
```
event: error
data: {"code": "GUARDRAIL_BLOCKED", "message": "Your message could not be processed.", "partialMessageId": "uuid | null"}
```

**Notes on Mid-Stream LLM Failure**:
- If the LLM connection fails or returns an error mid-stream, an `error` event is dispatched with `code: LLM_ERROR`.
- The partial user message and partial agent response generated up to the failure point are persisted to NestJS via the batch message endpoint.
- The `partialMessageId` field in the `error` event payload contains the UUID of the persisted partial agent message.

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid JWT |
| `GUARDRAIL_BLOCKED` | 200 (SSE) | Input blocked by safety guardrails |
| `GUARDRAIL_UNAVAILABLE` | 503 | Guardrail service down, fail-closed |
| `MESSAGE_TOO_LONG` | 400 | Input exceeds maximum length |
| `QUEUE_FULL` | 429 | Concurrent message limit exceeded for this conversation |
| `LLM_ERROR` | 200 (SSE) | LLM provider error, user-friendly message returned |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

**Notes**:
- `GUARDRAIL_BLOCKED` and `LLM_ERROR` are returned as SSE error events (HTTP 200) because the SSE connection was already established.
- Pre-connection errors (`UNAUTHORIZED`, `MESSAGE_TOO_LONG`, `QUEUE_FULL`, `GUARDRAIL_UNAVAILABLE`) return standard HTTP error responses before the SSE stream starts.

---

## GET /health

Health check endpoint (unauthenticated).

**Response** (200):
```json
{
  "status": "ok | degraded | down",
  "dependencies": {
    "llm": { "status": "ok | down", "latencyMs": 150 },
    "nestjsApi": { "status": "ok | down", "latencyMs": 25 },
    "guardrails": { "status": "ok | down", "modelLoaded": true }
  },
  "version": "0.1.0"
}
```
