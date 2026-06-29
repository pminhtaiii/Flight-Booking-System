# API Contracts: NestJS Chat Data API

**Service**: `apps/api` (NestJS) | **Consumer**: `apps/agent` (Python/FastAPI)

All endpoints require `Authorization: Bearer <jwt_token>` header.
All endpoints are scoped to the authenticated user (userId from JWT payload).
Base URL: `http://localhost:3001/api`

---

## POST /chat/sessions

Create a new chat session.

**Request**:
```json
{
  "title": "string | null"
}
```

**Response** (201):
```json
{
  "id": "uuid",
  "userId": "uuid",
  "title": "string | null",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "lastActiveAt": "ISO-8601"
}
```

**Errors**:
- `401` — Missing or invalid JWT
- `400` — Validation error

---

## GET /chat/sessions

List the authenticated user's chat sessions, paginated by recent activity.

**Query Parameters**:
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| limit | number | 20 | Max 50 |
| cursor | ISO-8601 string | null | `lastActiveAt` of last item from previous page |

**Response** (200):
```json
{
  "sessions": [
    {
      "id": "uuid",
      "title": "string | null",
      "createdAt": "ISO-8601",
      "lastActiveAt": "ISO-8601",
      "messagePreview": "string | null"
    }
  ],
  "nextCursor": "ISO-8601 | null"
}
```

---

## GET /chat/sessions/:sessionId

Get session details.

**Response** (200):
```json
{
  "id": "uuid",
  "userId": "uuid",
  "title": "string | null",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "lastActiveAt": "ISO-8601",
  "messageCount": 42
}
```

**Errors**:
- `404` — Session not found or does not belong to user

---

## PATCH /chat/sessions/:sessionId

Update session metadata.

**Request**:
```json
{
  "title": "string | null"
}
```

**Response** (200): Updated session object.

---

## DELETE /chat/sessions/:sessionId

Delete a session and all its messages (cascade).

**Response** (204): No content.

---

## POST /chat/sessions/:sessionId/messages

Create a message in a session. Also updates `session.lastActiveAt`.

**Request**:
```json
{
  "sender": "USER | AGENT",
  "type": "STANDARD | SUMMARY",
  "content": "string"
}
```

**Response** (201):
```json
{
  "id": "uuid",
  "sessionId": "uuid",
  "sender": "USER | AGENT",
  "type": "STANDARD | SUMMARY",
  "content": "string",
  "createdAt": "ISO-8601"
}
```

**Errors**:
- `404` — Session not found or does not belong to user
- `400` — Content exceeds maximum length

---

## GET /chat/sessions/:sessionId/messages

Get messages for a session, paginated in chronological order.

**Query Parameters**:
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| limit | number | 50 | Max 100 |
| cursor | ISO-8601 string | null | `createdAt` of last item |
| direction | "before" \| "after" | "before" | Pagination direction |

**Response** (200):
```json
{
  "messages": [
    {
      "id": "uuid",
      "sender": "USER | AGENT",
      "type": "STANDARD | SUMMARY",
      "content": "string",
      "createdAt": "ISO-8601"
    }
  ],
  "nextCursor": "ISO-8601 | null",
  "totalCount": 42
}
```

---

## POST /chat/sessions/:sessionId/messages/batch

Persist a batch of messages (e.g. user message + agent response pair, or partial messages during mid-stream drop) atomically in a single transaction. Also updates `session.lastActiveAt` and writes to the audit log.

**Request**:
```json
{
  "messages": [
    {
      "sender": "USER | AGENT",
      "type": "STANDARD | SUMMARY",
      "content": "string"
    }
  ]
}
```

**Response** (201):
```json
{
  "messages": [
    {
      "id": "uuid",
      "sessionId": "uuid",
      "sender": "USER | AGENT",
      "type": "STANDARD | SUMMARY",
      "content": "string",
      "createdAt": "ISO-8601"
    }
  ]
}
```

**Errors**:
- `404` — Session not found or does not belong to user
- `400` — Validation error / message length exceeded

---

## GET /chat/sessions/:sessionId/memory

Get conversation memory for LLM context assembly. Returns the most recent summary (if any) plus the last N standard messages.

**Query Parameters**:
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| recentCount | number | 20 | Number of recent standard messages to return |

**Response** (200):
```json
{
  "summary": "string | null",
  "recentMessages": [
    {
      "id": "uuid",
      "sender": "USER | AGENT",
      "content": "string",
      "createdAt": "ISO-8601"
    }
  ],
  "totalMessageCount": 85
}
```

**Notes**:
- `summary` is the content of the most recent SUMMARY-type message
- `recentMessages` are STANDARD-type messages only, ordered oldest → newest
- This is the primary endpoint the Python agent calls before each LLM invocation

---

## Audit Logging Requirements

Every write endpoint MUST log a structured record to the `audit_logs` table via `AuditService`:
- `POST /chat/sessions` → action: `chat_session_create`, resourceType: `ChatSession`
- `DELETE /chat/sessions/:sessionId` → action: `chat_session_delete`, resourceType: `ChatSession`
- `POST /chat/sessions/:sessionId/messages` → action: `chat_message_create`, resourceType: `ChatMessage`
- `POST /chat/sessions/:sessionId/messages/batch` → action: `chat_message_batch_create`, resourceType: `ChatMessage`
