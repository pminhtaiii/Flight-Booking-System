# Feature Specification: AI Chatbot Agent Service

**Feature Branch**: `002-chatbot-agent-service`

**Created**: 2026-06-29

**Status**: Draft

**Input**: User description: "Specify the AI chatbot agent service from the chatbot-backend-architecture grilling session — a standalone Python/FastAPI service within the monorepo that receives user questions via SSE streaming, validates authentication, applies input safety guardrails, orchestrates LLM-powered agents, manages conversation memory with sliding window + summary, and persists all chat data through the NestJS API."

## Clarifications

### Session 2026-06-29

- Q: When the guardrail service is unavailable, should the system fail open (allow messages) or fail closed (block messages)? → A: Fail closed — block all messages when guardrails are unavailable.
- Q: How should the system handle concurrent messages from the same user in the same conversation? → A: Queue and serialize — one message processed at a time per conversation, with a maximum queue depth limit. Messages exceeding the limit are rejected.
- Q: When does the system check the token budget and run summarization relative to the request cycle? → A: After completing a response — check token budget after the agent finishes streaming; if exceeded, summarize asynchronously before the next message is processed (no user-visible latency).
- Q: What happens when conversation summary generation fails? → A: Fall back to truncation — use the most recent N messages without a summary; older context is temporarily lost but the conversation continues.
- Q: What happens when a user sends an extremely long message that exceeds input limits? → A: Reject with limit — enforce a maximum message length and reject messages exceeding it with a clear error showing the limit.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Real-Time Chat Conversation (Priority: P1)

A logged-in user opens the chat interface and sends a question about their travel plans. The system streams back a response in real time, token by token, so the user sees the answer being composed progressively rather than waiting for the entire response to load.

**Why this priority**: Real-time streaming is the core interaction model. Without it, there is no chatbot product. Every other feature depends on this foundational request-response loop.

**Independent Test**: Can be fully tested by sending a message to the agent endpoint with a valid auth token and verifying that an SSE event stream returns with progressive response tokens.

**Acceptance Scenarios**:

1. **Given** a logged-in user with a valid session, **When** the user sends a text message through the chat interface, **Then** the system begins streaming a response via SSE within 3 seconds, delivering tokens progressively until the response is complete.
2. **Given** a logged-in user is receiving a streamed response, **When** the stream completes, **Then** the final message is persisted as a complete chat message accessible in the user's conversation history.
3. **Given** a user sends a message, **When** the connection drops mid-stream, **Then** the partial response is still persisted and the user can resume the conversation without data loss.

---

### User Story 2 - Authenticated Access Control (Priority: P1)

Only authenticated users can interact with the chatbot. The system validates the user's identity on every request and ensures each user can only access their own conversations and data.

**Why this priority**: Security is a launch blocker. An unauthenticated or user-crossover vulnerability in a conversational AI system is a critical risk that must be addressed from day one.

**Independent Test**: Can be tested by sending requests with valid, expired, and missing tokens and verifying the system correctly accepts or rejects each.

**Acceptance Scenarios**:

1. **Given** a request without an authentication token, **When** the user attempts to start or continue a conversation, **Then** the system rejects the request with a clear "unauthorized" response.
2. **Given** a request with an expired or tampered token, **When** the user attempts to interact, **Then** the system rejects the request and does not process the message.
3. **Given** User A's valid token, **When** the agent makes data requests on behalf of User A, **Then** all downstream data calls include User A's identity and the data layer enforces that only User A's data is returned.

---

### User Story 3 - Malicious Input Protection (Priority: P1)

The system detects and blocks prompt injection attacks, jailbreak attempts, and other adversarial inputs before they reach the LLM, protecting both the system and the user from harmful outputs.

**Why this priority**: An unguarded LLM endpoint is a liability. Input guardrails are a security requirement on par with authentication — the system must not be exploitable from day one.

**Independent Test**: Can be tested by sending known prompt injection patterns and verifying the system blocks them before the LLM processes the input.

**Acceptance Scenarios**:

1. **Given** a user submits a message containing a known prompt injection pattern, **When** the message is processed, **Then** the guardrail system blocks the message before it reaches the LLM and returns a safe, user-friendly response indicating the input was not processed.
2. **Given** a user submits a legitimate travel question, **When** the message is processed, **Then** the guardrail system allows the message through to the LLM without interference or added latency beyond 500 milliseconds.
3. **Given** the guardrail blocks a message, **When** the event is logged, **Then** the log captures the reason for blocking (without storing the full malicious payload) for security auditing purposes.

---

### User Story 4 - Conversation History & Memory (Priority: P2)

A returning user can view their previous conversations and continue where they left off. The system maintains context across messages within a session, remembering what was discussed earlier in the conversation without degrading response quality as conversations grow long.

**Why this priority**: Conversation continuity is what makes a chatbot genuinely useful versus a stateless Q&A tool. However, the core streaming + security stories must work first.

**Independent Test**: Can be tested by sending a sequence of related messages and verifying the agent's responses demonstrate awareness of earlier context in the conversation.

**Acceptance Scenarios**:

1. **Given** a user has sent 5+ messages in a conversation, **When** the user sends a follow-up that references something from an earlier message, **Then** the agent's response demonstrates awareness of the earlier context.
2. **Given** a conversation exceeds the recent message window (e.g., 20+ messages), **When** the user sends a new message, **Then** the agent still has access to a summary of older messages and responds coherently.
3. **Given** a user returns to the chat after closing the browser, **When** they open a previous conversation, **Then** they see their full message history and can continue the conversation with context preserved.

---

### User Story 5 - Conversation Management (Priority: P3)

A user can start new conversations, switch between existing conversations, and view a list of their past chat sessions. Each conversation is an isolated thread with its own context.

**Why this priority**: Multi-conversation management improves usability but is not required for the core chatbot to function. The system works with a single conversation thread first.

**Independent Test**: Can be tested by creating multiple conversations and verifying they are isolated and independently accessible.

**Acceptance Scenarios**:

1. **Given** a logged-in user, **When** the user starts a new conversation, **Then** a new session is created with no prior context and the user can immediately begin chatting.
2. **Given** a user has multiple past conversations, **When** the user views their conversation list, **Then** all sessions are displayed with identifiable labels (e.g., first message preview, date).
3. **Given** a user switches from Conversation A to Conversation B, **When** they send a message in Conversation B, **Then** the agent responds using only Conversation B's context, with no bleed-through from Conversation A.

---

### Edge Cases

- What happens when the LLM provider is temporarily unavailable or returns an error mid-stream?
- Messages exceeding the maximum allowed length are rejected before processing, with a clear error message indicating the character limit.
- When the guardrail service is unavailable, the system fails closed — all messages are blocked until guardrails recover. Users receive a clear error message indicating temporary unavailability.
- If conversation summary generation fails, the system falls back to truncation — using only the most recent N messages without a summary. Older context is temporarily unavailable but the conversation continues without interruption. Summarization is retried on the next turn.
- Concurrent messages from the same user in the same conversation are queued and processed one at a time in arrival order. A maximum queue depth limit is enforced — messages exceeding the limit are rejected with a clear error asking the user to wait.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: System MUST accept user messages and stream responses in real time via Server-Sent Events (SSE).
- **FR-002**: System MUST validate user authentication tokens on every request before processing any message.
- **FR-003**: System MUST propagate the authenticated user's identity to all downstream data requests so the data layer enforces per-user access control.
- **FR-004**: System MUST run all user inputs through a safety guardrail layer before the input reaches the LLM.
- **FR-005**: System MUST persist every chat message (both user messages and agent responses) to durable storage via the existing data API.
- **FR-006**: System MUST maintain a sliding window of recent messages plus a compressed summary of older messages as the working memory provided to the LLM. Summarization MUST be triggered when the token count of older messages exceeds a defined budget, checked after the agent completes a response. Summarization MUST run asynchronously before the next message is processed and MUST NOT execute during active streaming or response generation.
- **FR-007**: System MUST support multiple independent conversation sessions per user, each with isolated context.
- **FR-008**: System MUST expose a health check endpoint that reports the service's readiness and the status of its dependencies (LLM provider, data API, guardrail service).
- **FR-009**: System MUST log all security-relevant events (blocked inputs, authentication failures, guardrail triggers) in a structured format without including PII or raw malicious payloads.
- **FR-010**: System MUST gracefully handle LLM provider failures by returning a user-friendly error message rather than exposing internal errors or hanging the connection.
- **FR-011**: System MUST reside within the existing monorepo as a co-located service, sharing configuration and contract definitions with the other services.
- **FR-012**: System MUST fail closed when the guardrail service is unavailable — all user messages MUST be blocked until guardrails recover, and the user MUST receive a clear error message indicating temporary unavailability.
- **FR-013**: System MUST process only one message at a time per conversation, queuing additional messages in arrival order. The queue MUST enforce a maximum depth limit; messages exceeding this limit MUST be rejected with a user-friendly error.
- **FR-014**: If conversation summary generation fails, the system MUST fall back to truncation (most recent N messages only) and continue processing messages. Summarization MUST be retried on the next applicable turn.
- **FR-015**: System MUST enforce a maximum message length. Messages exceeding this limit MUST be rejected before processing, with a clear error message indicating the allowed character limit.

### Key Entities

- **ChatSession**: Represents a single conversation thread belonging to a user. Contains metadata such as creation time, last activity time, and an optional label/title. A user can have many sessions.
- **ChatMessage**: A single message within a session — either from the user or the agent. Contains the message content, sender type, timestamp, and an optional type flag (e.g., "summary" for compressed memory entries).
- **ConversationMemory**: The working memory context constructed for each LLM invocation — composed of a system prompt, an optional summary of older messages, the most recent N messages, and the new user input.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: First token within 3 seconds, measured from when the message exits the guardrail layer.
- **SC-002**: 100% of requests without a valid authentication token are rejected before any processing occurs.
- **SC-003**: Legitimate user messages pass through the guardrail layer with less than 500 milliseconds of added latency in 95% of cases.
- **SC-004**: Users can retrieve and continue conversations from previous sessions with full history preserved.
- **SC-005**: The service health check endpoint responds within 1 second and accurately reflects dependency status.
- **SC-006**: No user can access another user's conversation data, verified through access control testing.

## Assumptions

- The existing NestJS API service is operational and can be extended with new endpoints for chat data persistence (ChatSession and ChatMessage CRUD).
- The existing PostgreSQL database managed by Prisma can accommodate new models for chat data without requiring a separate database.
- The authentication system (JWT-based) from the `001-db-init-auth-handshake` spec is implemented and tokens can be validated independently by the agent service using a shared secret.
- The LLM provider exposes an API compatible with standard chat-completion interfaces (e.g., OpenAI-compatible endpoint).
- The guardrail library (NeMo Guardrails) is available as a dependency and can run as an in-process component within the agent service.
- Conversation memory summarization is triggered when the token count of older messages exceeds a defined budget threshold, checked after the agent finishes streaming a response. If the budget is exceeded, summarization runs asynchronously before the next message is processed. Summarization MUST NOT run during active streaming or response generation to avoid interfering with the user's experience.
- The multi-agent topology (router vs. single agent vs. supervisor graph) is out of scope for this spec — this spec covers the foundational service infrastructure, not the internal agent orchestration strategy.
- The specific LLM model/provider selection is out of scope — the service will use an abstraction layer that supports swapping providers.
