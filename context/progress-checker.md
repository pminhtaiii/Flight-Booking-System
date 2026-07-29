# Progress Tracker

Update this file after every completed feature. Any AI agent reading this should immediately know what is done, what is in progress, and what is next.

---

### Current Status

**Feature:** Ancillary Services — Seat Selection, Baggage & Price Tracker (Feature 15)
**Last completed:** Phase 3 / PR 4 of Feature 15 (Owned Ancillary Read/Commit API and Optimistic Recovery Boundary) on branch 015d-duffel-ancillary-catalog.
**Next:** Implement Phase 4 / PR 5: Custom seat map, baggage selection, and instant price tracker. See [ADR](file:///c:/Booking%20Systems/docs/adr/research-ancillary-services-grilling-session.md) for all architectural decisions.

---

## Progress by Feature

### [ ] Feature: Ancillary Services — Seat Selection, Baggage & Price Tracker (Feature 15)

- [x] Phase 0 / PR 1: Checkout Foundation (implemented `NEXT_PUBLIC_FEATURE_FLAG_CHECKOUT` feature flag defaulting to enabled/true unless set to false; created `protectCheckoutRoute` and `fetchBookingIntent` in `apps/web/lib/checkout.ts` to enforce authentication, feature flag presence, and booking intent ownership/expiration; created page shells for `/checkout/passengers`, `/checkout/[intentId]/ancillaries`, `/checkout/[intentId]/review`, and `/checkout/[intentId]/payment` mapping out flight/traveler contexts and dynamic placeholders; implemented search page `/search` and client form `SearchFormClient` using JWT tokens; implemented passenger details form component `PassengerFormClient` with dynamic guest counts, profile prefilling, DOB format checks, and conditional passport validations for international routes; set up cookie-driven mock scenarios for unit/E2E test pipelines; resolved booking link races persistence in `SearchFormClient`)
- [x] Phase 2 / PR 3: Duffel Ancillary Catalog, Normalization, and Cache Discipline (implemented shared ancillary types, raw SDK mappings, caching adapter under Redis key `seatmap:{duffelOfferId}` with 60s TTL and early-expiry/force-refresh rules, exact price verification, and extended order creation with validated service lines; verified with golden fixtures and unit tests for caching boundaries, normalization, repricing, and order creations)
- [x] Phase 1 / PR 2: Shared Contracts, State Repair, Additive Schema, and Migration (implemented shared ancillary catalog/selection/pricing/error types; append-only selection, seat, baggage, coverage, and payment snapshot-binding Prisma models with an additive migration; persisted Duffel passenger IDs at BookingIntent creation; and repaired payment eligibility to use `PENDING`. Prisma schema validation and whitespace checks pass.)
- [x] Phase 3 / PR 4: Owned Ancillary Read/Commit API and Optimistic Recovery Boundary (implemented protected catalog read and optimistic snapshot commit routes, request-scoped passenger projections over supplier-native cache data, pure authoritative selection validation and exact totals, append-only snapshot persistence with CAS and audit logging, and customer/path-scoped idempotency replay hardening; no payment, pricing action, order, or capture side effects.)
- [ ] Phase 5 / PR 6: Authoritative Validation, Payment Amount, and Duffel Order Services (implementation tasks T042-T050 are complete: short-lived lease/CAS validation before payment side effects, exact authoritative amount and immutable Payment binding, Payment-bound canonical Duffel services, and unchanged saga recovery/compensation. Documentation sync T053 is complete. Verification remains incomplete: T051/T052 are open because the local database migration history diverges, the Phase 5 lease migration is unapplied there, database-backed E2E was not run, and two bounded direct Jest selections found zero tests due path-selection mismatch.)

### [x] Feature: Disruption & Flight-Change Management (Feature 14)

- [x] Phase 7 / PR 8: Traveller booking disruption experience on the Next.js frontend (refactored app/bookings/[bookingId]/page.tsx to Next.js Server Component; implemented BookingDetailClient container; added semantic DisruptionAlert with plain-language reasons and warnings; implemented ItineraryChangeSummary displaying latest revision changes vs original booking; added ItineraryRevisionHistory timeline; supported Acknowledge and Accept actions with pending states, router refresh, and stale conflict handling; added disruption status badges to list cards; updated Playwright E2E tests, resolving CORS origin domain isolation and strict selector conflicts; verified all tests passing with 100% success rate)

- [x] Phase 6 / PR 7: Traveller disruption lifecycle actions, paginated history reads, read model extensions, and confirmed cancellation resolution (implemented owner-scoped booking read model extensions with DTO mapping and segments flat-to-nested deserialization under FEATURE_FLAG_DISRUPTION_SURFACING; implemented GET /api/bookings/:bookingId/disruptions paginated history; implemented Traveller lifecycle actions POST acknowledge/accept with active revision validation, state transitions, audit logging, and stale revision 409 conflict checks; updated cancelBooking to resolve active disruptions to RESOLVED/BOOKING_CANCELLED with traveler actor type metadata; verified with 100% test coverage in disruption and cancellation E2E suites passing cleanly with zero warnings/lint issues)

- [x] Phase 5 / PR 6: Budget-aware reconciliation and correct booking-completion lifecycle (implemented ReconciliationService with 30-minute cron wrapper, exact 72-hour window and stable ordering, Duffel budget limits tracking/concurrency controls, exponential backoff failure handling, and stale final-arrival completion sweep resolving active disruptions; verified with unit/E2E test coverage and lint checks passing cleanly)

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

- Booking-detail refreshes now clear action-specific success and conflict feedback before rendering a new itinerary revision.
- Logout requires a successful backend token-revocation request before clearing NextAuth. Missing API configuration or revocation failures leave the session active and display a safe error instead of leaving a live bearer token behind. Fixed the Playwright E2E configuration to default `NEXT_PUBLIC_API_URL` to `http://127.0.0.1:3001`, resolving test build crashes while keeping the logout configuration-omission scenario exercisable via a runtime window override.
- The test environment does not run PostgreSQL or Redis services locally. E2E tests use Jest spies on the PrismaClient instance to mock database states, keeping the API source code clean and genuine.
- Fixed a double-increment of `paymentAttemptCount` on stale-lock retry of `createPayment` by querying for an existing Payment record before updating `booking_intents` (Step 2) and reusing the existing Payment record if found (Step 5).
- Created a Mimo LLM diagnostic script (`apps/agent/src/agent/test_llm_connection.py`) allowing manual verification of API keys and endpoint connectivity directly from the terminal (securely prompts for keys via `getpass` and runs raw HTTP and LangChain tests).
