# Progress Tracker

Update this file after every completed feature. Any AI agent reading this should immediately know what is done, what is in progress, and what is next.

---

### Current Status

**Feature:** Chatbot Backend Infrastructure & Booking Handoff (Feature 17)
**Last completed:** Phase 8C Privacy Corpus (T099) and Full Regression Suite (T100) (2026-08-14).
**In progress:** None.
**Next:** Separately approved Phase 8 polish/cleanup tasks (T101 proxy cleanup and T102 plaintext DB column drop require separate explicit approvals). See [plan.md](file:///c:/Booking%20Systems/specs/017-chatbot-backend-infrastructure/plan.md) for details.

---

## Progress by Feature

### [ ] Feature: Chatbot Backend Infrastructure & Booking Handoff (Feature 17)

- [x] Phase 1 / Contract & Config Freeze (T001–T008): Shared contracts compile, all flags default off, runtime behavior unchanged.
- [x] Phase 2 / Foundational — Additive Storage & Redis Primitives (T009–T024):
  - [x] WP 2A: Redis lifecycle/health — 2 tests GREEN
  - [x] WP 2B: Atomic daily/burst admission Lua — 6 tests GREEN
  - [x] WP 2C: Fenced session leases + message queue — 4 tests GREEN
  - [x] WP 2D: Trusted snapshot repository (PII-free) — 10 tests GREEN
  - [x] WP 2E: Prisma additive schema + migration + backfill scripts
  - [x] WP 2F: Inert AES-256-GCM crypto service + ChatHandoff module/controller/service/DTO skeletons
  - [x] Resolved 15 critical bugs and code smells identified during Phase 2 code review (SSE leaks, NestJS write fence, unpaginated backfills, feature flag handling, task GC risks, dataclass refactoring, and test fixtures).
  - [x] Resolved Issue 1 (write fence validation race condition in NestJS ChatService transaction) and Issue 2 (agent NestJSClient missing X-Fencing-Token header propagation).
  - [x] Resolved background summarization fencing token race condition in Python agent sse.py.
  - [x] Resolved stale owner queue depth leak in Python agent MessageQueueManager.release.
  - [x] Resolved failed acquisition double-decrement depth bug in Python agent sse.py and MessageQueueManager.release.
  - **22/22 Redis regression tests PASS; 159 Python Agent tests PASS; 6/6 E2E migration tests PASS; NestJS backend build compiles cleanly.**
- [x] Phase 3 / US1: Secure, Budgeted Conversation (T025–T038):
  - [x] WP 3A: Canonical auth/access ordering — real token, revocation, deactivation, and pre-cost denial tests pass (T025, T032)
  - [x] WP 3B: Atomic admission integration — two-instance accepted-only charge tests pass (T026, T030)
  - [x] WP 3C: Fenced turn ownership — session lock repository, fence revalidation, refresh-loss cancellation pass (T027, T031)
  - [x] WP 3D: Encrypted service-auth persistence — record-bound AES-256-GCM dual-write/read, soft-delete, service auth endpoints pass (T028, T033, T034)
  - [x] WP 3E: Direct-server readiness — strict CORS, direct bearer streaming, health degradation pass (T029, T035, T036)
  - [x] WP 3F: Session continuity checkpoint — ChatWidget sessionId reuse and full US1 regression suite GREEN (T037, T038)
  - **All Phase 3 US1 focused test suites (31 Python pytest, 20 NestJS unit/gateway E2E) 100% PASS.**
- [x] Phase 4 / US2: Correct Specialist Routing (T039–T052)
  - [x] WP 4A: Router schema/fallback (T039, T047)
  - [x] WP 4B: Checkout gate/state (T040, T048)
  - [x] WP 4C: Graph topology/removal (T041, T050, T051)
  - [x] WP 4D: Signed search split (T042, T049)
  - [x] WP 4E: General/Travel inventory (T043, T044, T045)
  - [x] WP 4F: Checkout adapter/integration (T046, T052)
  - **All tests in apps/agent pass successfully (201/201).**
- [ ] Phase 5 / US3: Privacy-Minimized Booking Answers (T053–T063)
- [x] Phase 6 / US4: Deterministic Checkout Handoff (T064–T084)
  - [x] WP 6A: Deterministic credential primitive — attestation verifier, server-derived idempotency, HMAC/hash rotation
  - [x] WP 6B: Dark create/resolve API — service-auth create, user-auth token-only resolve, ISSUE/ACCEPT gates
  - [x] WP 6C: Deterministic action and clean web bootstrap — ACTION_HANDOFF SSE parsing, strict card, CSRF bootstrap cookie, clean checkout URL
  - [x] WP 6D: Claimed canonical consume — Token-only readiness, pre-supplier claim, final atomic intent/consume CAS
  - **All Checkout Handoff tests pass (NestJS create/resolve/consume, agent signal integration, and Playwright UI tests).**
- [x] Phase 7 / US5: Observable, Reversible Rollout (T085–T093)
  - [x] WP 7A: Flag/direct-client gate — independent ISSUE/ACCEPT behavior, direct-stream boundary coverage, and ChatWidget direct streaming with proxy fallback (T085, T087, T091)
  - [x] WP 7B: PII-safe telemetry — per-field closed schemas, fail-open agent metrics/logs, opaque trace/correlation IDs, real Agent→NestJS trace verification, and NestJS create/resolve/consume/replay audit linkage (T086, T088, T089)
  - **WP 7B GREEN evidence:** agent focused suites `83 passed`; API focused unit suites `51 passed`; chat-handoff E2E `8 passed`; handoff-consumption E2E `1 passed`; Ruff and Python compile checks passed. Playwright was not rerun per handoff instruction.
  - [x] WP 7C: Correlation propagation — independent bounded opaque browser trace/correlation IDs, Agent sanitization, NestJS gateway forwarding, and sanitized proxy fallback forwarding (T090)
  - **WP 7C GREEN evidence (2026-08-10):** the three-service test invokes the production browser request builder and preserves its generated opaque pair through real FastAPI access, memory, turn persistence, handoff creation, NestJS telemetry, and audit. NestJS handoff E2E passed `9/9`; gateway E2E passed `11/11`; Agent client tests passed `24/24`; the focused direct-stream test passed `1` with `11` deselected; and web trace/direct/proxy unit suites passed `17/17`. Duplicate API-base composition, canonical/legacy signed-JWT handling, memory-query coercion, and NestJS-token-to-`ACTION_HANDOFF` adaptation are fixed. Playwright was not rerun; user-provided successful browser runs remain accepted evidence.
  - [x] WP 7D/T092: Proxy rollback checkpoint — same-origin proxy retained, explicit direct-stream flag honored, opaque headers filtered, and legacy `ACTION_REQUIRED` SSE passed through unchanged.
  - **WP 7D/T092 GREEN evidence:** route-level proxy tests `2/2` passed; the user-provided `chat-checkout-handoff.spec.ts` browser run passed. The proxy rollback matrix remains retained.
  - [x] WP 7D/T093: Reversible observation — direct-stream signed-search/selection/action ordering, strict authenticated clean bootstrap, owner/internal-session resolution, readiness/claim/consume regression, legacy `ACTION_REQUIRED`, session continuity, encrypted persistence, and credential privacy assertions.
  - **WP 7D/T093 GREEN evidence (2026-08-12):** exact-final-source real browser→Next.js→FastAPI→NestJS→bootstrap→resolve→readiness→consume Playwright run exited `0` with `1 passed (7.4m)`. Assertions proved one BookingIntent and one consumed handoff under 16-way concurrency, two expected supplier calls and zero payment calls, four encrypted plaintext-free messages, retained session continuity, clean URL/DOM/storage/cookie/console/request privacy, and distinct legacy `ACTION_REQUIRED`. Focused web boundary tests passed `11/11`, focused API handoff tests passed `20/20`, and the Next production build passed with both cookie-backed checkout proxy routes compiled. Phase 8 remains unchecked and was not started.
- [ ] Phase 8 / Polish & Cleanup (T094–T102)
  - [x] T098 / Handoff latency and concurrency: post-remediation gates passed on 2026-08-14. Router p95 11.338 ms; quota race 1 accepted/99 denied; handoff create/resolve p95 13.9823/24.0127 ms; 100-consumer p95 150.7542 ms with one supplier call, one intent, 99 expected conflicts, and zero payment calls.
  - [x] T099 / Negative Privacy Corpus: verified zero exposure across LLM fixtures, SSE, bootstrap/access logs, traces, audits, clean URLs, DOM, cookies, and browser storage on 2026-08-14. Closed crypto fallback, claim token logging gaps, raw stack logging in agent gateway controller/service, telemetry privacy detection order, runtime redirect builder verification, and dynamic test encryption key fixtures.
  - [x] T100 / Full Regression Suite: full agent pytest (264/264 PASS), shared types build, NestJS unit suites (575/575 PASS), Next.js production build (21 routes), web boundary unit suites (16/16 PASS), and API E2E privacy/chat suites passed cleanly on 2026-08-14.
  - [ ] T101 (Proxy cleanup) & T102 (Plaintext columns drop) require separate explicit approvals.

### [ ] Feature: Traveler Profile & Booking Readiness (Feature 16)


- [x] Phase 1 / PR 1: Setup — Shared Contracts, Flags, and Observability Vocabulary (implemented shared types for traveler profiles, passenger sources, readiness scopes, results, reason codes, profile sections, and masked summaries; added API and web feature flags `FEATURE_FLAG_BOOKING_READINESS` and `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS` defaulting to false; created client helper `apps/web/lib/featureFlags.ts`; defined PII-safe operation names, metric names, and allowed metadata keys in `booking-readiness-observability.types.ts`; verified with configuration schema parser tests and contract allowlist validation tests)
- [x] Phase 2 / PR 2: Additive Schema, Bound Encryption, and Migration Safety (implemented additive traveler profile and passenger snapshot database models and applied SQL migration safely preserving legacy data; added record-bound versioned AES-256-GCM encryption helper methods to EncryptionService with backward-compatibility for legacy unbound ciphertext; created idempotent data-quality backfill service with revision-checking CAS updates, mismatched-date validation quarantine, and abort thresholds; registered ProfileModule, PassportExpiryBackfillController, and a daily scheduled cron task for backfill execution; secured backfill encryption with context-bound AAD keys tied to travelerProfileId and fieldName; verified with a comprehensive migration compatibility E2E test suite, unit tests, and controller integration tests)
- [x] Phase 3 / PR 3: Owned Traveler Profile API (implemented secure, owner-scoped `GET/PATCH /api/profile` endpoints with optimistic concurrency control (`revision` CAS checks), atomic travel document section replacement, versioned bound AES-256-GCM encryption for passport numbers and shadow expiry ciphertext, disagreement integrity checks for shadow reads, PII-safe audit logging with `changedFields` metadata, `Cache-Control: no-store, private` headers with ETag stripping, and `FEATURE_FLAG_BOOKING_READINESS` 404 behavior; verified with 38 unit tests and 5 E2E API tests all passing cleanly)
- [ ] Phase 4 / PR 4: Secure Profile UI (protected `/profile`, server-side JWT proxy, one-page accessible form, optional travel-document section, revision conflict recovery, safe return-target allowlist, feature-disabled fallback, and Playwright owner/privacy coverage added; frontend typecheck passes; live E2E execution awaits healthy local services and profile-client contract tests remain)
- [x] Phase 5 / `016f-pure-booking-readiness-evaluator`: Pure normalized-input evaluator, deterministic domestic/international/unknown scope, atomic international document checks, date-only expiry warnings, deferred entry-eligibility projection, bounded advisory-buffer parsing, and table-driven boundary/purity tests are implemented and verified via runtime test suites.
- [x] Phase 6 / `016g-advisory-booking-readiness-endpoint`: Added the feature-gated, read-only `POST /api/bookings/intents/readiness` path with discriminated passenger sources, owner-scoped profile projection, local-offer segment normalization, batched airport-country lookup, evaluator delegation, safe error mapping, no-store response headers, and PII-safe structured observability; focused Jest, API build, and endpoint E2E verification pass.
- [x] Phase 7 / Passenger source and snapshot foundation: Added canonical nested discriminated intent passenger DTO validation with revision and matrix rules, owner/revision-aware detached source normalization, complete immutable passenger snapshot data with zero-based positions and AAD-bound passport encryption, safe masked projections, module providers, canonical create-path wiring, legacy completeness validation, backfill-context compatibility, bound snapshot reads, transaction-time revision checks, and 80 passing focused/regression tests.
- [x] Phase 8 / Atomic intent creation and safe route migration: Added authoritative readiness parity before persistence, zero-write rejection behavior, transaction-time profile revision rechecks, atomic intent/snapshot/audit creation, allowlisted authoritative observability, canonical plural create/get/readiness routes, deprecated singular compatibility aliases, safe masked intent responses, explicit source/revision checkout submission, stable offer passenger IDs, and masked review rendering. API unit/E2E and frontend verification were run successfully after the final fixes.

### [ ] Feature: Ancillary Services — Seat Selection, Baggage & Price Tracker (Feature 15)

- [x] Phase 0 / PR 1: Checkout Foundation (implemented `NEXT_PUBLIC_FEATURE_FLAG_CHECKOUT` feature flag defaulting to enabled/true unless set to false; created `protectCheckoutRoute` and `fetchBookingIntent` in `apps/web/lib/checkout.ts` to enforce authentication, feature flag presence, and booking intent ownership/expiration; created page shells for `/checkout/passengers`, `/checkout/[intentId]/ancillaries`, `/checkout/[intentId]/review`, and `/checkout/[intentId]/payment` mapping out flight/traveler contexts and dynamic placeholders; implemented search page `/search` and client form `SearchFormClient` using JWT tokens; implemented passenger details form component `PassengerFormClient` with dynamic guest counts, profile prefilling, DOB format checks, and conditional passport validations for international routes; set up cookie-driven mock scenarios for unit/E2E test pipelines; resolved booking link races persistence in `SearchFormClient`)
- [x] Phase 2 / PR 3: Duffel Ancillary Catalog, Normalization, and Cache Discipline (implemented shared ancillary types, raw SDK mappings, caching adapter under Redis key `seatmap:{duffelOfferId}` with 60s TTL and early-expiry/force-refresh rules, exact price verification, and extended order creation with validated service lines; verified with golden fixtures and unit tests for caching boundaries, normalization, repricing, and order creations)
- [x] Phase 1 / PR 2: Shared Contracts, State Repair, Additive Schema, and Migration (implemented shared ancillary catalog/selection/pricing/error types; append-only selection, seat, baggage, coverage, and payment snapshot-binding Prisma models with an additive migration; persisted Duffel passenger IDs at BookingIntent creation; and repaired payment eligibility to use `PENDING`. Prisma schema validation and whitespace checks pass.)
- [x] Phase 3 / PR 4: Owned Ancillary Read/Commit API and Optimistic Recovery Boundary (implemented protected catalog read and optimistic snapshot commit routes, request-scoped passenger projections over supplier-native cache data, pure authoritative selection validation and exact totals, append-only snapshot persistence with CAS and audit logging, and customer/path-scoped idempotency replay hardening; no payment, pricing action, order, or capture side effects.)
- [x] Phase 4 / PR 5: Custom seat map, baggage selection, and instant price tracker (implemented custom accessible seat grids, roving tabindexes and keyboard navigation, segment tab switching and passenger stepper, journey-wide baggage selection, sticky decimal-safe price breakdowns, catalog refresh reconciliation, and UUID-driven double submit blocks on continue.)
- [x] Phase 5 / PR 6: Authoritative validation, payment amount, and Duffel order services (implemented pre-payment CAS-freeze and Duffel validation pipeline, pricing delta user acknowledgement block, payment bound snapshots integration with minor-unit conversions, Stripe manual capture saga binding, and idempotent Duffel order creation with compensation fallback.)
- [x] Phase 6 / PR 7: Read-only review, targeted edits, recovery, and cancellation disclosure (implemented server-rendered read-only review with edit routes, PII-safe versioned localStorage recovery helper, conflict re-routing on payment failure, minimal post-purchase confirmed summary under booking details, and supplier-authoritative cancellation/refund quote fields serialization within the existing quote ID column.)

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
- Chatbot backend infrastructure uses AES-256-GCM dual-write/read for encrypted persistence, soft deletion for preserving relational structure without PII, and X-Fencing-Token alongside X-Service-Auth to protect write operations and backend-to-backend communication.

---

## Notes

- Booking-detail refreshes now clear action-specific success and conflict feedback before rendering a new itinerary revision.
- Logout requires a successful backend token-revocation request before clearing NextAuth. Missing API configuration or revocation failures leave the session active and display a safe error instead of leaving a live bearer token behind. Fixed the Playwright E2E configuration to default `NEXT_PUBLIC_API_URL` to `http://127.0.0.1:3001`, resolving test build crashes while keeping the logout configuration-omission scenario exercisable via a runtime window override.
- The test environment does not run PostgreSQL or Redis services locally. E2E tests use Jest spies on the PrismaClient instance to mock database states, keeping the API source code clean and genuine.
- Fixed a double-increment of `paymentAttemptCount` on stale-lock retry of `createPayment` by querying for an existing Payment record before updating `booking_intents` (Step 2) and reusing the existing Payment record if found (Step 5).
- Created a Mimo LLM diagnostic script (`apps/agent/src/agent/test_llm_connection.py`) allowing manual verification of API keys and endpoint connectivity directly from the terminal (securely prompts for keys via `getpass` and runs raw HTTP and LangChain tests).
- Fixed backend runtime emission after the root type-check configuration enabled `noEmit`: API and shared-package build configs now explicitly emit JavaScript, preserving root type-check-only behavior and ensuring `apps/api/dist/main.js` exists for NestJS startup.
