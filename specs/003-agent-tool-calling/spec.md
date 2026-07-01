# Feature Specification: Agent Tool-Calling & Data Access

**Feature Branch**: `003-agent-tool-calling`

**Created**: 2026-07-01

**Status**: Draft

**Input**: User description: "Third feature — agent tool-calling service and NestJS agent gateway, based on decisions captured in research/agent-tool-calling-architecture.md"

## Clarifications

### Session 2026-07-01

- Q: How many flight search results should the agent return to avoid context window bloat? → A: Top 5 results for MVP; may increase to 10 in a future iteration.
- Q: Where should PII sanitization occur for user-typed inputs (e.g., "passport 12345")? → A: Sanitize before storage only. Raw input is allowed into the LLM context for intent parsing, but persisted messages, audit logs, and trace logs must have PII scrubbed.
- Q: How should the top 5 flight results be ranked/sorted? → A: Use the API's default ranking. Interactive sorting and filtering will be handled by a separate frontend dashboard feature, not by the agent.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Conversational Flight Search (Priority: P1)

A traveler asks the AI chatbot to search for flights using natural language (e.g., "find me flights from Hanoi to Tokyo next Friday") and receives accurate, real-time flight results directly in the chat conversation — without navigating the search UI.

**Why this priority**: This is the flagship domain capability that transforms the chatbot from a generic LLM wrapper into a useful travel assistant. Without flight search, the agent has zero domain value.

**Independent Test**: Can be fully tested by sending a flight search message to the chatbot and verifying that real flight results (airline, times, price) appear in the conversation stream. Delivers immediate user value as a standalone feature.

**Acceptance Scenarios**:

1. **Given** a logged-in traveler in the chat interface, **When** they send "find flights from Hanoi to Tokyo on July 15", **Then** the chatbot returns the top 5 matching flights with airline name, flight number, departure/arrival times, duration, stops, price, fare class, and baggage allowance.
2. **Given** the chatbot has already returned flight results, **When** the traveler asks a follow-up question about those results (e.g., "which one has the fewest stops?"), **Then** the chatbot answers from the existing conversation context without making a redundant search call.
3. **Given** a logged-in traveler, **When** they ask about flight details that are outside the data returned by the search tool (e.g., "what's the cancellation policy?"), **Then** the chatbot clearly states that this information is not available rather than guessing or fabricating an answer.

---

### User Story 2 - Personalized Recommendations via Preferences (Priority: P2)

A traveler expects the chatbot to know their saved preferences (seat preference, preferred airline, travel class, dietary needs) and factor these into responses and recommendations — without the traveler needing to repeat this information every time.

**Why this priority**: Personalization is the key differentiator between a generic search tool and a personal travel assistant. It builds on Story 1 by adding user-specific context to search results and recommendations.

**Independent Test**: Can be tested by configuring user preferences in the profile, then asking the chatbot a preference-related question (e.g., "what's my preferred airline?") and verifying the correct answer appears.

**Acceptance Scenarios**:

1. **Given** a traveler with saved preferences (e.g., window seat, Vietnam Airlines, business class), **When** they ask the chatbot "what are my travel preferences?", **Then** the chatbot retrieves and displays their preferences accurately.
2. **Given** a traveler with saved airline preferences, **When** they search for flights, **Then** the chatbot can reference their preferences when providing recommendations without the traveler restating them.
3. **Given** a traveler with no saved preferences, **When** they ask for their preferences, **Then** the chatbot informs them that no preferences are on file.

---

### User Story 3 - Booking Status Inquiry (Priority: P2)

A traveler asks the chatbot about their upcoming trips (e.g., "when is my next flight?") and receives accurate booking information from their existing reservations — delivered conversationally.

**Why this priority**: Equal to Story 2 because it addresses a core convenience use case. Travelers frequently check booking details and doing so conversationally is faster than navigating a bookings page.

**Independent Test**: Can be tested by creating a booking for a user, then asking the chatbot "when is my next flight?" and verifying correct booking details are returned.

**Acceptance Scenarios**:

1. **Given** a traveler with active bookings, **When** they ask "when is my next flight?", **Then** the chatbot returns the booking details including destination, dates, airline, flight info, and booking status.
2. **Given** a traveler with multiple bookings, **When** they ask "show me my bookings", **Then** the chatbot lists all active bookings with key details for each.
3. **Given** a traveler with no bookings, **When** they ask about their bookings, **Then** the chatbot clearly states they have no active bookings.

---

### User Story 4 - PII Protection in All Responses (Priority: P1)

A traveler's sensitive personal information — passport numbers, payment card details, PNR codes, and e-ticket numbers — must never appear in chatbot responses, regardless of what questions they ask or how they phrase their requests. Additionally, if a traveler types PII into their chat message (e.g., "book for John Doe, passport A12345678"), that PII must be scrubbed before the message is persisted to storage or written to logs.

**Why this priority**: Marked P1 because PII protection is a non-negotiable security requirement. It is a cross-cutting concern that must be enforced from the very first tool call. Failure here is a data breach.

**Independent Test**: Can be tested by having a user with passport, payment, and booking data ask the chatbot for their "full profile" or "booking confirmation number" and verifying that no PII fields appear in any response.

**Acceptance Scenarios**:

1. **Given** a traveler with a passport number on file, **When** they ask the chatbot any question, **Then** the passport number never appears in the chatbot's response.
2. **Given** a traveler with saved payment methods, **When** they ask about their account or bookings, **Then** no payment card numbers, CVVs, or billing details appear in the response.
3. **Given** a traveler with bookings, **When** they ask for booking details, **Then** PNR codes, e-ticket numbers, and payment references are never included in the response.
4. **Given** a system operator reviewing chatbot logs and traces, **When** they inspect any tool call or LLM context, **Then** no PII fields from tool responses are present — the data was stripped before entering the agent's context window.
5. **Given** a traveler types a message containing PII (e.g., "my passport number is A12345678"), **When** the message is persisted to conversation history or written to any log, **Then** the PII is scrubbed from the stored/logged version. The LLM may see the raw input for intent parsing, but storage never retains it.

---

### User Story 5 - Seamless Streaming with Tool Calls (Priority: P3)

A traveler experiences a smooth, real-time streaming conversation where tool calls happen transparently mid-stream — with visual feedback (e.g., "Searching flights...") so the experience feels responsive and natural rather than frozen.

**Why this priority**: Important for user experience polish, but the core functionality (Stories 1–4) must work correctly before optimizing the streaming feel.

**Independent Test**: Can be tested by sending a tool-triggering message and observing the SSE event stream for proper `tool_call`, `tool_result`, and `token` events in the correct sequence.

**Acceptance Scenarios**:

1. **Given** a traveler asks a question that triggers a tool call, **When** the agent invokes the tool, **Then** a status event is emitted (e.g., "Searching flights...") before results arrive.
2. **Given** a tool has returned results, **When** the agent formulates its response, **Then** the response streams token-by-token as before, incorporating the tool results naturally.
3. **Given** multiple tool calls are needed in one turn (e.g., preferences + search), **When** the agent invokes them, **Then** each tool call and result is signaled to the client with appropriate status events.

---

### User Story 6 - Human-in-the-Loop Confirmation Gate (Priority: P3)

The system is architecturally prepared for future write operations (booking, cancellation) by including a confirmation gate that suspends the agent and asks for user approval before any action that would affect bookings or money. While no write tools exist in this phase, the gate is functional and testable.

**Why this priority**: The confirmation mechanism is a safety-critical architectural component for future phases. Building it now avoids a full rewrite later, but it is lower priority because no write tools are being shipped.

**Independent Test**: Can be tested by defining a mock write tool with `requires_confirmation: true` and verifying the graph suspends, sends a confirmation event, and correctly resumes or aborts based on the user's response.

**Acceptance Scenarios**:

1. **Given** a tool is marked as requiring confirmation, **When** the agent routes to it, **Then** the graph suspends and emits a `confirmation_required` event with proposed action details.
2. **Given** the graph is suspended for confirmation, **When** the user confirms, **Then** the graph resumes and executes the tool.
3. **Given** the graph is suspended for confirmation, **When** the user declines, **Then** the graph aborts the tool call and the agent acknowledges the cancellation.

---

### User Story 7 - Operator Audit Trail (Priority: P2)

A system operator can review a complete audit log of every tool call the agent made — including which user triggered it, which tool was called, when, and the response size — for compliance, debugging, and abuse detection.

**Why this priority**: Auditability is a constitutional requirement (Observability principle). It must be present from the first tool call deployment for compliance.

**Independent Test**: Can be tested by triggering tool calls and then querying the audit log to verify all expected entries exist with correct metadata.

**Acceptance Scenarios**:

1. **Given** a traveler triggers a tool call via the chatbot, **When** the tool executes, **Then** an audit log entry is created with userId, tool name, timestamp, and response size.
2. **Given** a system operator, **When** they query the audit logs for a specific user, **Then** they see a chronological record of all tool calls that user triggered.
3. **Given** a tool call fails (e.g., gateway timeout), **When** the failure occurs, **Then** the audit log captures the failure with error details.

---

### Edge Cases

- What happens when the gateway is unreachable during a tool call? The agent must inform the user that the service is temporarily unavailable and not retry indefinitely.
- How does the system handle expired or tampered user claim tokens? The gateway must reject the request with an appropriate error, and the agent must not expose internal authentication details to the user.
- What happens when the agent exceeds the maximum tool-calling iterations per turn? The agent must stop calling tools, summarize what it has so far, and inform the user.
- What happens when the user asks a question that could be answered by multiple tools? The agent must select the most relevant tool and may chain tools if needed, within the iteration cap.
- How does the system handle a user whose account has been deactivated between JWT validation and tool call execution? The gateway must independently verify user active status and reject the request.
- What happens when a user types PII into their chat message (e.g., passport numbers, credit card numbers)? The raw input is processed by the LLM for intent parsing, but a sanitization layer must scrub PII from the message before it is persisted to conversation history, audit logs, or trace storage.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST enable travelers to search for flights conversationally by providing origin, destination, date, and passenger count to the chatbot.
- **FR-002**: The system MUST return flight search results containing airline name, flight number, departure/arrival times, duration, number of stops, price, fare class, and baggage allowance.
- **FR-018**: The system MUST limit flight search results presented to the agent to a maximum of 5 flights, using the data provider's default ranking order. Interactive sorting and filtering of results is out of scope for this feature and will be handled by a separate frontend dashboard.
- **FR-003**: The system MUST retrieve a traveler's saved preferences (seat, airline, class, dietary needs) when requested conversationally.
- **FR-004**: The system MUST retrieve a traveler's active bookings with flight details and status when requested conversationally.
- **FR-005**: The system MUST structurally prevent PII (passport numbers, payment details, PNR codes, e-ticket numbers) from ever entering the agent's context window — not by prompt instruction, but by ensuring the data is never included in tool responses.
- **FR-006**: The system MUST authenticate agent-to-backend data requests using a service-level credential combined with a cryptographically signed user claim token.
- **FR-007**: The system MUST reject data requests that present invalid, expired, or tampered user claim tokens.
- **FR-008**: The system MUST independently verify that the user account is active before serving any data request from the agent — user active status is not embedded in the claim token.
- **FR-009**: The system MUST answer follow-up questions from existing conversation context when the data is already available, avoiding redundant tool calls.
- **FR-010**: The system MUST refuse to fabricate or guess information that is outside the data fields returned by its tools — instead clearly stating the information is unavailable.
- **FR-011**: The system MUST emit real-time status events during tool calls (tool invocation and tool result) so the user sees responsive feedback during processing.
- **FR-012**: The system MUST enforce a configurable maximum number of tool-calling iterations per turn to prevent runaway loops.
- **FR-013**: The system MUST classify each tool as either read-only or requiring user confirmation, and route confirmation-required tools through a suspension gate that pauses execution and requests explicit user approval.
- **FR-014**: The system MUST log every tool call with user identifier, tool name, timestamp, and response size for audit purposes.
- **FR-019**: The system MUST sanitize user chat messages of PII (passport numbers, payment card numbers, and other personal identifiers) before persisting them to conversation history storage or writing them to any log or trace output.
- **FR-020**: The system MUST allow raw user input into the LLM context for intent parsing — sanitization applies only to the storage and logging layer, not to the in-flight LLM processing.
- **FR-015**: The system MUST scope all data queries to the authenticated user — no cross-user data access is permitted.
- **FR-016**: The system MUST support adding new tools by defining a tool schema, a corresponding data endpoint, and a confirmation flag — without requiring architectural changes to the orchestration layer.
- **FR-017**: The claim token time-to-live MUST be configurable per deployment without code changes.

### Key Entities

- **Agent Gateway**: A dedicated data access boundary that exposes curated, PII-stripped data to the agent. Acts as the single chokepoint for all agent data access, enabling centralized auditing and access control.
- **Claim Token**: A short-lived, cryptographically signed token containing only user identity and issuance timestamp. Used to prove that the agent is acting on behalf of a validated user without forwarding the user's original authentication credential.
- **Tool**: A defined capability the agent can invoke — consisting of a name, parameter schema, a data source endpoint, and a confirmation requirement flag. Tools are the atomic unit of agent-to-backend interaction.
- **Tool Call Audit Entry**: A log record capturing who triggered a tool, which tool was called, when, and the response characteristics — used for compliance and operational monitoring.
- **Confirmation Gate**: A suspension mechanism that pauses agent execution when a tool requires user approval, sends a confirmation request to the user, and resumes or aborts based on the user's response.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Travelers can search for flights, check bookings, and retrieve preferences entirely through chat conversation — completing each query within 10 seconds end-to-end.
- **SC-002**: 100% of tool responses are free of PII (passport, payment, PNR, e-ticket data) — verified by automated testing against a known PII field list.
- **SC-003**: The agent correctly refuses to answer questions about data outside its tool schema in at least 95% of test cases, responding with a clear "unavailable" statement instead of fabricated information.
- **SC-004**: Follow-up questions about data already in the conversation context are answered without triggering a redundant tool call in at least 90% of cases.
- **SC-005**: Invalid, expired, or tampered claim tokens are rejected 100% of the time — no unauthorized data access occurs.
- **SC-006**: Every tool call produces a complete audit log entry — zero gaps in the audit trail.
- **SC-007**: The agent completes multi-tool queries (e.g., preferences + search) within the configured iteration cap without entering runaway loops.
- **SC-008**: New tools can be added and operational with only a tool schema definition, a data endpoint, and a confirmation flag — no changes to the orchestration layer are required.
- **SC-009**: Flight search results never exceed 5 items per query — verified by automated testing across varied search inputs.
- **SC-010**: 100% of persisted chat messages and log entries are free of user-typed PII — verified by automated scanning of stored conversation history and logs after test sessions containing known PII inputs.

## Assumptions

- The chatbot agent service (JWT auth, SSE streaming, memory management, concurrency queue) is fully built and operational as a prerequisite — this feature extends that service with tool-calling capabilities.
- The NestJS backend already has functional services for flight search (Amadeus integration), user profiles, and booking management that can be proxied through the gateway.
- The Amadeus Self-Service API is the sole flight data provider; API budget constraints (2,000 calls/month) apply to agent-initiated searches equally.
- Users typically have a small number of active bookings (1–5), so booking list queries do not require pagination in this phase.
- The LLM provider (Mimo) supports OpenAI-compatible function/tool calling API natively — no text-based parsing or ReAct-style workarounds are needed.
- Single-instance deployment is assumed for this phase. Distributed checkpointing and horizontal scaling are deferred.
- No write operations (booking, payment, cancellation) are implemented in this phase — the confirmation gate is architecturally ready but dormant.
- The frontend chat UI is a separate feature — this specification covers only the backend agent and gateway capabilities.
- Sorting, filtering, and interactive exploration of flight search results is a frontend dashboard feature — the agent returns results in the data provider's default order.
