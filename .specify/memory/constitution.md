<!--
  ╔══════════════════════════════════════════════════════════════╗
  ║  SYNC IMPACT REPORT                                        ║
  ║  Version change: 1.0.0 → 2.0.0 (MAJOR — principle removal)║
  ║                                                             ║
  ║  Modified principles:                                      ║
  ║    I.   Flight-First Architecture (unchanged)              ║
  ║    II.  Deterministic Transaction Boundary (unchanged)     ║
  ║    III. API Budget Discipline (unchanged)                  ║
  ║    IV.  Observability & Operational Visibility (NEW)       ║
  ║    V.   Incremental Delivery (was VI, renumbered)          ║
  ║                                                             ║
  ║  Added sections:                                           ║
  ║    - Principle IV: Observability & Operational Visibility  ║
  ║                                                             ║
  ║  Removed sections:                                         ║
  ║    - Principle IV: Brainstorm-First Development             ║
  ║      → Relocated to .agents/AGENTS.md as procedural rule   ║
  ║    - Principle V: Test-First Development                    ║
  ║      → Relocated to .agents/AGENTS.md as procedural rule   ║
  ║                                                             ║
  ║  Templates requiring updates:                              ║
  ║    ✅ plan-template.md — Constitution Check still generic   ║
  ║    ✅ spec-template.md — scope/requirements compatible      ║
  ║    ✅ tasks-template.md — phase structure compatible        ║
  ║                                                             ║
  ║  Follow-up TODOs:                                          ║
  ║    - TODO(AUTH_STRATEGY): OAuth/JWT/social login TBD       ║
  ║    - TODO(TECH_STACK): Language/framework not yet chosen    ║
  ╚══════════════════════════════════════════════════════════════╝
-->

# Flight Booking System Constitution

## Core Principles

### I. Flight-First Architecture

The flight search-and-book flow is the **anchor of the entire user experience**.
All supplementary services (hotels, restaurants, activity suggestions) are
strictly deferred to future milestones and MUST NOT:

- Block, delay, or complicate the core flight booking pipeline.
- Introduce additional external API dependencies into the v1 critical path.
- Appear in the UI as required steps during the booking flow.

**Rationale**: A B2C travel platform lives or dies by the reliability of its
primary transaction. Keeping the v1 scope laser-focused on flights prevents
scope creep and reduces integration risk.

### II. Deterministic Transaction Boundary

AI agents (LLM-powered) MUST NEVER participate in the critical
booking/payment path. The boundary is defined as follows:

- **Deterministic services only**: flight search & pricing (Amadeus API),
  PNR creation, payment processing, ticket issuance, refund handling,
  user authentication, and notification delivery.
- **AI agents (advisory role only)**: smart search assistance, result
  interpretation, itinerary recommendations, customer support chatbot,
  price trend analysis, and fraud pattern detection.

Every transactional operation MUST produce an auditable, reproducible
record. LLM outputs are NEVER used as the source of truth for financial
or booking state.

**Rationale**: LLMs are non-deterministic and unsuitable for financial
transactions. Booking transactions MUST be auditable and reproducible.
PCI-DSS and payment regulations require strict, traceable flows.

### III. API Budget Discipline

The Amadeus Self-Service API free tier grants **2,000 calls/month**. This
hard constraint imposes the following non-negotiable rules:

- Every external API call MUST be justified with a clear user-facing purpose.
- Response caching MUST be implemented for search results (TTL-based).
- Rate limiting MUST be enforced at the application layer before requests
  reach external APIs.
- Batch and deduplication strategies MUST be used where the API supports them.
- API usage MUST be monitored with alerts at 50%, 75%, and 90% thresholds.

**Rationale**: Exceeding the free tier silently breaks the product for all
users. Budget discipline is an architectural constraint, not an optimization.

### IV. Observability & Operational Visibility

All production services MUST expose sufficient telemetry to diagnose
failures, measure performance, and audit behavior without requiring code
changes or redeployment. The following are non-negotiable:

- **Structured Logging**: All services MUST emit structured logs (JSON) with
  consistent fields: `timestamp`, `level`, `service`, `trace_id`,
  `correlation_id`, and `message`. Logs MUST NOT contain PII or payment
  card data (enforced by the Security Requirements section).
- **Health Checks**: Every deployable service MUST expose a `/health`
  endpoint (or equivalent) that reports readiness and liveness status.
  Health checks MUST include downstream dependency status (database,
  Amadeus API, payment provider).
- **Metrics**: Key operational metrics MUST be collected and exposed:
  - Request rate, error rate, and latency (p50, p95, p99) per endpoint.
  - API budget consumption (ties to Principle III thresholds).
  - Active booking transactions in progress.
  - Cache hit/miss ratios for search results.
- **Distributed Tracing**: All cross-service and cross-boundary calls MUST
  propagate a `trace_id` to enable end-to-end request tracing. This
  includes calls to the Amadeus API and payment processor.
- **Alerting**: Alerts MUST be defined for:
  - Error rate exceeding baseline by 2× over a 5-minute window.
  - Latency p95 exceeding SLO for any critical endpoint.
  - Health check failures on any service or dependency.
  - API budget thresholds (as defined in Principle III).
- **Dashboard**: A single operational dashboard MUST aggregate the above
  metrics for at-a-glance system health assessment.

**Rationale**: A booking system handles real money and real itineraries.
Silent failures or undetected performance degradation directly translate
to lost revenue and broken trust. Observability is not a nice-to-have —
it is a prerequisite for operating a transactional system responsibly.

### V. Incremental Delivery

Every milestone and user story MUST deliver a working, deployable
increment. The following rules apply:

- No big-bang releases — each story is a shippable slice.
- MVP-first: User Story 1 (flight search & booking) MUST be fully
  functional before supplementary stories begin.
- Each increment MUST pass all existing tests before merge.
- Rollback capability MUST be maintained at every deployment boundary.

**Rationale**: Incremental delivery reduces risk, enables early user
feedback, and ensures the system is always in a deployable state.

## Security Requirements

All security practices below are **non-negotiable** for any code that
touches user data or financial transactions:

- **PCI-DSS Compliance**: Payment card data MUST be handled through a
  PCI-compliant payment processor. Raw card numbers MUST NEVER be stored,
  logged, or transmitted by application code.
- **Authentication**: User authentication MUST use industry-standard
  protocols. TODO(AUTH_STRATEGY): Specific provider (OAuth 2.0, JWT,
  social login) to be decided during tech stack selection.
- **Data Protection**: All user PII MUST be encrypted at rest and in
  transit (TLS 1.2+). Database credentials and API keys MUST be stored
  in environment variables or a secrets manager, never in source code.
- **Input Validation**: All user-facing inputs MUST be validated and
  sanitized before processing. SQL injection, XSS, and CSRF protections
  are mandatory.
- **Audit Logging**: All booking, payment, and authentication events MUST
  be logged with timestamps, user identifiers, and action details.
  Logs MUST NOT contain PII or payment card data.

## Governance

This constitution is the supreme governing document for the Flight Booking
System project. It supersedes all other practices, conventions, and ad-hoc
decisions.

- **Compliance Verification**: All pull requests and code reviews MUST
  verify compliance with these principles. Non-compliant code MUST NOT
  be merged.
- **Amendment Procedure**: Any change to this constitution requires:
  1. A written proposal documenting the change and its rationale.
  2. Explicit approval from the project owner.
  3. A migration plan if existing code is affected.
  4. An updated version number following semantic versioning.
- **Versioning Policy**: MAJOR for principle removals or redefinitions,
  MINOR for new principles or material expansions, PATCH for
  clarifications and wording fixes.
- **Complexity Justification**: Any architectural complexity beyond the
  simplest viable solution MUST be explicitly justified in the
  implementation plan with reference to a specific principle.
- **Runtime Guidance**: Use the project's AGENTS.md and spec-kit
  artifacts for day-to-day development guidance aligned with these
  principles.

**Version**: 2.0.0 | **Ratified**: 2026-06-23 | **Last Amended**: 2026-06-23
