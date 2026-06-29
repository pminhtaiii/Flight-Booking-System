# API Contracts: Python Agent SSE API

**Service**: `apps/agent` (Python/FastAPI) | **Consumer**: `apps/web` (Next.js frontend)

All endpoints require `Authorization: Bearer <jwt_token>` header.
Base URL: `http://localhost:3002`

---

## POST /chat/stream

Send a message and receive a streaming response via SSE.

**Request**:
```json
{
  "sessionId": "uuid",
  "message": "string"
}
```

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
data: {"code": "GUARDRAIL_BLOCKED", "message": "Your message could not be processed."}
```

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
- `GUARDRAIL_BLOCKED` and `LLM_ERROR` are returned as SSE error events (HTTP 200) because the SSE connection was already established
- Pre-connection errors (`UNAUTHORIZED`, `MESSAGE_TOO_LONG`, `QUEUE_FULL`, `GUARDRAIL_UNAVAILABLE`) return standard HTTP error responses before the SSE stream starts

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
    "guardrails": { "status": "ok | down" }
  },
  "version": "0.1.0"
}
```
