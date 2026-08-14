# T098 Correctness Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the T098 security and canonical-consume invariants without regressing the 100-way latency gate.

**Architecture:** Keep PostgreSQL as the cross-process authority. The route-scoped process-local fast-fail reservation only sheds concurrent local losers and must be released by its owner. JWT validation retains only in-flight request coalescing; completed user and revocation outcomes are never cached. The final consume transaction restores the required active-session check while encryption and supplier work remain outside it.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Jest, Python pytest, Node HTTP benchmark harness.

## Global Constraints

- No raw handoff token/hash, offer ID, booking ID, or PII in telemetry.
- Losing consumers make zero Duffel/payment calls.
- JWT revocation and user activity are authoritative for every protected request.
- T098 is complete only after router, quota, handoff, and consume p95/count evidence is recorded.

---

### Task 1: Restore authoritative JWT validation

**Files:**
- Modify: `apps/api/src/auth/strategies/jwt.strategy.ts`
- Modify: `apps/api/src/auth/strategies/jwt.strategy.spec.ts`

- [ ] Write failing tests showing a concurrent lookup does not bypass a revoked token and a just-revoked/deactivated identity is denied on the next validation.
- [ ] Run the focused Jest tests and confirm RED against the completed-outcome cache.
- [ ] Keep only hashed-key in-flight lookup coalescing; remove completed user/revocation caches.
- [ ] Run the focused Jest tests and confirm GREEN.

### Task 2: Make fast-fail reservations route-scoped and releasable

**Files:**
- Modify: `apps/api/src/booking-intent/guards/handoff-fast-fail.guard.ts`
- Modify: `apps/api/src/booking-intent/booking-intent.module.ts`
- Modify: `apps/api/src/booking-intent/booking-intent.service.ts`
- Modify: `apps/api/src/chat-handoff/chat-handoff.service.ts`
- Modify: `apps/api/src/chat-handoff/chat-handoff.service.spec.ts`

- [ ] Write failing lifecycle tests for retry-after-failure, successful consume, and distinct user/token isolation.
- [ ] Run focused tests and confirm RED because reservations are never released.
- [ ] Remove global guard registration and introduce owner-safe route reservation release in the canonical intent `finally` path.
- [ ] Run focused tests and confirm GREEN.

### Task 3: Restore canonical handoff/session finalization

**Files:**
- Modify: `apps/api/src/chat-handoff/chat-handoff.service.ts`
- Modify: `apps/api/src/booking-intent/booking-intent.service.ts`
- Modify: `apps/api/src/chat-handoff/chat-handoff.service.spec.ts`
- Modify: `apps/api/src/booking-intent/booking-intent.service.spec.ts`
- Modify: `apps/api/test/chat-handoff-performance.e2e-spec.ts`

- [ ] Write failing public/service tests for deleted-session denial and pre-transaction snapshot building.
- [ ] Run focused tests and confirm RED.
- [ ] Add session ownership/deletion predicates to atomic claim and final CAS; build snapshots before `$transaction`; replace unsafe dynamic values and swallowed database failures with typed handling.
- [ ] Run unit and E2E tests and confirm GREEN.

### Task 4: Verify and record T098

**Files:**
- Modify: `docs/runbooks/chatbot-handoff.md`
- Modify: `context/progress-checker.md`
- Modify: `specs/017-chatbot-backend-infrastructure/tasks.md`

- [ ] Run router-overhead, quota-edge, API handoff/consume performance, observability, and focused regression suites using the documented commands.
- [ ] Record dated commands, counts, p95 values, and exit codes only when every required gate is green.
- [ ] Mark T098 `[x]` and synchronize project progress only after the evidence is recorded.
