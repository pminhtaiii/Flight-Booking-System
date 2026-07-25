# Progress Tracker

Update this file after every completed feature. Any AI agent reading this should immediately know what is done, what is in progress, and what is next.

---

### Current Status

**Feature:** Disruption & Flight-Change Management (Feature 14)
**Last completed:** Feature 14 Phase 4: Signed Duffel Webhook receiver, durable inbox, and async processor.
**Next:** Feature 14 Phase 5: Re-trigger matching and schedule re-notification.

---

## Progress by Feature

### [/] Feature: Disruption & Flight-Change Management (Feature 14)

- [x] Phase 4 / PR 5: Signed Duffel Webhook receiver, durable inbox, and async processor (implemented HMAC-SHA256 signature verification with 5-minute replay tolerance, fast-ack response, durable inbox insertion, duplicate delivery convergence, async leasing using compare-and-swap token claims, stale lease recovery, independent batch processing, exponential retry backoff, 5th-attempt escalation, and 30-day raw payload PII redaction; verified with 100% unit and E2E coverage passing cleanly)

- [x] Phase 3 / PR 4: Supplier synchronization transaction and concurrency (implemented pessimism-based concurrency lock using syncLockedAt and a CAS random token, Duffel complete order retrieval outside transactions, normalization & fingerprint validation, short transactional write re-checking status and versioning with loop retries for unique constraint collision, and daily outbox throttling. Resolved code review items: created REST controller trigger secured by JwtAuthGuard with caller ownership checks, prevented cancellation masking by using sourceEventId-based verification, and serialized concurrent syncs/cancellations with an early dummy update row lock in the transaction; verified with unit/integration/E2E coverage passing cleanly)
- [x] Phase 2 / PR 3: Pure Itinerary Normalization, Matching, Diff, and Classification (implemented framework-independent domain core: itinerary normalizer, canonical serialization and fingerprint, cascade one-to-one segment matcher, diff generator with slice/connection details, and disruption-v1 materiality classifier with threshold rules; verified with 42 tests passing with zero lint issues)
- [x] Phase 1 / PR 2: Contracts, Additive Schema, Migration, and Shared Types (implemented additive schema, generated and applied migration cleanly, extended segment snapshots and DTO definitions in shared packages, updated Duffel service with segment ID extraction mapping and complete order retrieval, added config validation, and passed all schema and unit/E2E verification tests)

### [x] Feature: Flight Cancellation & Automated Refund System (Feature 12)

- [x] PR 1 (Issue #62): Schema Migration & Cancellation Quote API (Prisma schema update, DB sync, shared DTOs & enums, DuffelService quote creation, BookingService & Controller getCancellationQuote endpoint with atomic claim concurrency protection, resolved CodeRabbit review issues: concurrent quote overwrite prevention, missing Duffel token configuration guard, strict pending claim isolation, and status-guarded finalization)
- [x] PR 2 (Issue #63): Duffel Order Cancellation & Refund Processing Pipeline (supplier-first CAS cancellation, remote Duffel recovery, bounded inline Stripe retries, and atomic refund finalization)
- [x] PR 3 (Issue #64): Background Refund Recovery Worker & Admin Escalation (durable retry scheduling, one-minute CAS worker, stable Stripe keys, 22-hour escalation guard, and ADMIN-only manual resolution endpoint)
- [x] PR 4 (Issue #65): Cancellation & Refund User Interface (Frontend) (cancellation quote review modal, dynamic alert banners for pending/refund states, 48-hour support escalation logic, and operator manual refund resolution dashboard)
- [x] PR 5 (Issue #66): End-to-End Resilience Verification (Jest API E2E coverage for quote expiry, concurrency races, remote Duffel recovery, background worker recovery, and Playwright journeys for quote review, confirm, pending refund, support escalation, and manual refund resolution; validated and passing both test suites)

### [x] Feature: Booking Management & Confirmation (Feature 11)

- [x] Phase 1: Database Schema & Shared Types (Prisma enums/models, database migrations, shared Typescript exports)
- [x] Phase 2: Booking Service & REST API (NestJS BookingModule, service CRUD, list/detail query, endpoints, validation)
- [x] Phase 3: Payment Pipeline Integration (Integrated booking creation, UUID validation, concurrency resolution, error mapping, and background/reactive sweeper crons)
- [x] Phase 4: Checkout Loading Escalation (Frontend) (client UUID v4 confirmation payload, authenticated confirmation request, four-phase loading escalation, safe booking-status escape hatch, and unload protection)
- [x] Phase 5: Booking Detail Page (Frontend) (status-specific booking detail rendering, confirmation banner, payment-aware failure handling, and safe retry routing)
- [x] Phase 6: My Bookings List Page (Frontend) (authenticated server-rendered booking history, URL-driven Upcoming/Past tabs and pagination, null-safe status cards, retry links, and empty-state CTA)
- [x] Phase 7: E2E Testing & Verification (API list/detail authorization, pagination and null-state coverage; conditional transition race coverage; and Playwright booking-list, detail, retry, and checkout-escalation journeys)

### [x] Feature: Stripe Payment System (Feature 10)

- [x] Phase 1: Database Schema & Enums (Setup environment variables, Zod validation, schema modifications, database migrations, shared types)
- [x] Phase 2: Stripe SDK Wrapper & Shared Infrastructure (Injectable StripeService with create/capture/cancel PaymentIntent, Customer and Refund operations, and signature verification)
- [x] Phase 3: Payment State Machine (State machine helpers for valid transition enforcement and dispute state resolution with 100% unit test coverage)
- [x] Phase 4: Idempotency Key Service (PaymentIdempotencyService with lock acquisition, response replay caching, deterministic hashing, and custom @IdempotencyKey header parameter decorator)
- [x] Phase 5: Core Payment Pipeline (Create + Authorize) (Pessimistic claim lock on BookingIntent, lazy Customer creation, creation-based reconciliation, and Payment creation)
- [x] Phase 6: Core Payment Pipeline (Confirm + Capture) (Resuming from recovery points, Duffel PNR creation with 30s timeout, Stripe manual capture, ledger entries, and post-capture reconciliation)
- [x] Phase 7: Webhook Processing (Stripe signature verification, deduplication, event routing, FSM validation, self-healing reconciliation, and structured logging)
- [x] Phase 8: Refund System (RefundPaymentDto, PaymentRefundService with initiateRefund/handleChargeRefunded/triggerAutomatedRefund, charge.refunded webhook handler, POST /:paymentId/refund endpoint, RefundResponse shared type)

### [x] Feature: Booking Intent Foundation (Feature 9)

- [x] Phase 1: Database Schema & Encryption Foundation
- [x] Phase 2: BookingIntentModule Core Service & DTOs (DTOs, controller, service, module registration, Duffel re-pricing with timeout mapping, and transactional audit logging)
- [x] Phase 3: Two-Phase Cron Cleanup
- [x] Phase 4: E2E Testing & Verification

### [x] Feature: Cabin Class & Passenger Type Enhancement (Feature 8)

- [x] Phase 1: Database Schema Migration (Prisma model updates for FlightOffer and SearchHistory, database migrations, client regeneration)
- [x] Phase 2: DuffelService — Cabin Class & Passenger Mapper (Implemented mapPassengersToDuffel, updated searchFlights signature, cache key SHA-256, mock data generation and Duffel API payload)
- [x] Phase 3: FlightsModule — Cabin Match Classification & DTOs (Implemented FlightSearchRequestDto, FlightSegmentDto, FlightOfferDto, FlightDetailResponseDto, cabin mismatch details, and longest-duration segment cabin match classification, write-behind, detail endpoint recovery)
- [x] Phase 4: Passenger Type Selector & Frontend Integration (Implemented unified passenger picker dropdown for Adults, Children, Infants with increment/decrement validation)
- [x] Phase 5: Agent Gateway — Honest Degradation (Implemented keyword detection, honest limitation response, audit logging, and Python agent integration)
- [x] Phase 6: Polish & Cross-Cutting Concerns (Update documentation and execute validation scenarios)
- [x] Phase 7: E2E Testing & Verification (NestJS and Playwright E2E tests for flights search, detail recovery, and agent gateway limitations)

### [x] Feature: Duffel Flight Search Service Setup & Agent Gateway Refactoring (Feature 6)

- [x] Phase 1: Duffel Service Setup & Agent Gateway Refactoring (Duffel module extraction, SDK setup, cache, budget check, and agent gateway service updates)
- [x] Phase 2: Database Schema & Cron Cleanup (Prisma model updates for FlightOffer and SearchHistory, daily cron retention task)
- [x] Phase 3: FlightsModule & User Search Endpoint and Frontend Integration
- [x] Phase 4: Flight Detail & Re-pricing API
- [x] Phase 5: Frontend Integration & Search History Analytics Capture
- [x] Phase 6: E2E Verification & Testing (Automated Jest/Playwright tests, chatbot integration verification)

### [x] Feature: LLM Output Guardrails

- [x] Phase 1: Design & Contracts
- [x] Phase 2: Configuration & PII Detection — Foundation
- [x] Phase 3: Sentence-Boundary Chunking — Token Accumulation
- [x] Phase 4: NeMo Output Rail — Safety Classification
- [x] Phase 5: Output Guardrail Pipeline — Orchestration
- [x] Phase 6: SSE Integration — Wire Pipeline Into Streaming
- [x] Phase 7: Hard Stop & Partial Persistence — Failure Handling
- [x] Phase 8: Pipeline Parallelism — Latency Optimization
- [x] Phase 9: Observability & Logging — Structured Telemetry
- [x] Phase 10: E2E Testing & Validation — Final Verification

### [x] Feature: Agent Tool-Calling & Data Access

- [x] T001–T004: Database Schema & Mock Seed Data (Phase 1)
- [x] T005–T011: Agent Gateway REST Endpoints & Authentication (Phase 2)
- [x] T012–T015: PII Stripping, Caching & Auditing (Phase 3)
- [x] T016–T019: Python Client, Auth Headers & PII Scrubber (Phase 4)
- [x] T020–T025: LangGraph State Machine & Read-Only Tools (Phase 5)
- [x] T026–T028: Human-in-the-Loop Gate & SSE Streaming Status (Phase 6)
- [x] T029–T031: Polish & Cross-Cutting Concerns (Phase 7)

### [x] Feature: Chatbot Agent Service


- [x] Define ChatSession and ChatMessage database schema
- [x] Implement NestJS ChatModule endpoints (CRUD, batch, memory)
- [x] Implement structured audit logs for chat operations
- [x] Implement FastAPI Python Agent Service Scaffold & JWT Auth middleware
- [x] Implement NeMo Guardrails input guardrails
- [x] Implement SSE streaming foundation (Phase 4A)
- [x] Implement LangChain agent completion & persistence (Phase 4B)
- [x] Implement sliding window & summary memory manager
- [x] Implement per-conversation concurrency queue

### [x] Feature: Agent Gateway & Tool Execution (NestJS/LangGraph)

- [x] Phase 1: Database Schema & Mock Seed Data (Prisma models `TravelerProfile`, `Booking`, and database migrations)
- [x] Phase 2: Agent Gateway REST Endpoints & Authentication
- [x] Phase 3: PII Stripping, Caching & Auditing
- [x] Phase 4: Python Client, Auth Headers & PII Scrubber
- [x] Phase 5: LangGraph State Machine & Read-Only Tools
- [x] Phase 6: Human-in-the-Loop Gate & SSE Streaming Status
- [x] Phase 7: Polish & Cross-Cutting Concerns

### [x] Feature: Monorepo Scaffold & Shared Infrastructure

- [x] Configure workspace `package.json` and workspaces
- [x] Set up strict compiler, linting, and formatting rules
- [x] Define shared domain models, types, and constants

### [x] Feature: Database & Health Endpoint

- [x] Define User and AuditLog schemas in Prisma
- [x] Implement PrismaService database wrapper
- [x] Add `GET /health` verification endpoint with E2E tests

### [x] Feature: User Registration

- [x] Define registration validation contracts
- [x] Build PII-safe logger and AuditLog writer
- [x] Implement AuthService registration with password hashing
- [x] Expose `POST /auth/register` and build Registration UI

### [x] Feature: User Login & Rate-Limited Lockout

- [x] Define login validation contracts
- [x] Set up Redis cache service wrapper
- [x] Implement escalating brute-force lockout logic
- [x] Expose `POST /auth/login` and build Login UI

### [x] Feature: JWT Session Handshake

- [x] Configure Passport JWT Strategy and Guards
- [x] Implement `GET /auth/me` identity endpoint
- [x] Configure NextAuth credentials provider session
- [x] Create apiClient helper and protect `/dashboard` route

### [x] Feature: User Logout

- [x] Expose `POST /auth/logout` audit endpoint
- [x] Implement frontend logout flow and NextAuth clear-session

### [x] Feature: E2E Polish & Verification

- [x] Clean ESLint and type checking globally
- [x] Run concurrency stress tests (100 parallel requests)
- [x] Walkthrough verification and documentation

### [x] Feature: Map Integration

- [x] Phase 1: Setup (Shared Infrastructure)
- [x] Phase 2: Foundational (Database Schema & Seed)
- [x] Phase 3: Airport Map & REST API (Backend & Frontend MVP)
- [x] Phase 4: Airport Autocomplete with Map Preview
- [x] Phase 5: Flight Route Details Map
- [x] Phase 6: Dark Mode & Destination Explorer (tile style toggle, app theme sync, explore map with popular destinations pre-fill/redirect)
- [x] Phase 7: Polish & E2E Validation

---

## Decisions Made During Build

- Consolidated separate PostgreSQL and Redis standalone docker containers into a single `docker-compose.yml` file at the project root for streamlined development service management.
- Refactored `PrismaService` to remove the query interceptor facade. This ensures it behaves as a genuine client and reports health status truthfully based on real database availability.
- Implemented clean Jest spies and mock lifecycles directly in `test/health.e2e-spec.ts` to manage database connectivity states in local environments where PostgreSQL and Redis are unavailable.
- Added client warming to E2E setup in `health.e2e-spec.ts` to bypass Express/NestJS router bootstrap cold-start latencies.

---

## Notes

- The test environment does not run PostgreSQL or Redis services locally. E2E tests use Jest spies on the PrismaClient instance to mock database states, keeping the API source code clean and genuine.
- Fixed a double-increment of `paymentAttemptCount` on stale-lock retry of `createPayment` by querying for an existing Payment record before updating `booking_intents` (Step 2) and reusing the existing Payment record if found (Step 5).
- Created a Mimo LLM diagnostic script (`apps/agent/src/agent/test_llm_connection.py`) allowing manual verification of API keys and endpoint connectivity directly from the terminal (securely prompts for keys via `getpass` and runs raw HTTP and LangChain tests).
