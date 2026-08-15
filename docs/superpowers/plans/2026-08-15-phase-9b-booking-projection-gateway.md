# Phase 9B: Exact Booking Projection Gateway Read Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose service-authenticated, user-scoped Agent Gateway read endpoints (`/api/agent-gateway/users/bookings/summaries` and `/api/agent-gateway/users/bookings/:bookingReference`) that query exclusively from `BookingAgentProjection` and return strict summary and detail DTO tiers without loading raw Booking, passenger, payment, PNR, or provider snapshot data.

**Architecture:** Extend NestJS `AgentGatewayController` and `AgentGatewayService` to query exclusively from `BookingAgentProjection`. Use `AgentApiKeyGuard` and `ClaimTokenGuard` for authentication. Enforce strict DTO allowlists and uniform 404 (`BOOKING_REFERENCE_NOT_FOUND`) error behavior.

**Tech Stack:** TypeScript, NestJS 10, Prisma 5, Jest, Supertest

**Spec:** `specs/017-chatbot-backend-infrastructure/spec.md` (FR-022, FR-023, FR-024)

## Global Constraints
- Queries MUST select ONLY from `BookingAgentProjection`.
- Spies MUST prove zero database queries touch `Booking.flightSnapshot`, `Booking.passengerSnapshot`, `Payment`, `pnrReference`, or `User` credentials.
- Summary tier MUST return only: `bookingReference`, `airline`, `origin`, `destination`, `departureTime`, `arrivalTime`, `status`, `durationMinutes`, `stops`.
- Detail tier MUST return only: Summary tier fields PLUS `flightNumber`, `baggageAllowance`, `changeable`, `refundable`.
- Cross-owner access MUST return `404` (`BOOKING_REFERENCE_NOT_FOUND`) with zero record existence metadata leakage.
- Never weaken or skip tests; follow strict TDD (RED -> GREEN -> REFACTOR).

---

### Task 1: Strict DTO Definitions and Shared Types (T058)

**Files:**
- Create: `apps/api/src/agent-gateway/dto/booking-summary.dto.ts`
- Create: `apps/api/src/agent-gateway/dto/booking-detail.dto.ts`
- Modify: `packages/shared/src/types/chat.types.ts`
- Modify: `apps/api/src/agent-gateway/dto/index.ts` (if existing, or export from dto directory)

- [ ] **Step 1: Write strict `BookingSummaryDto` and `BookingSummariesResponseDto`**
  Define fields with class-validator: `bookingReference`, `airline`, `origin`, `destination`, `departureTime`, `arrivalTime`, `status`, `durationMinutes`, `stops`.

- [ ] **Step 2: Write strict `BookingDetailDto`**
  Inherit or extend `BookingSummaryDto` with `@IsOptional() flightNumber?: string | null`, `@IsOptional() baggageAllowance?: string | null`, `@IsOptional() changeable?: boolean | null`, `@IsOptional() refundable?: boolean | null`.

- [ ] **Step 3: Update `packages/shared/src/types/chat.types.ts`**
  Synchronize `BookingSummary` and `BookingDetail` types to match exact field names.

- [ ] **Step 4: Build shared package**
  Run: `pnpm --filter @shared/types build`
  Expected: PASS

---

### Task 2: Service Unit Tests with Query Spies and Privacy Bounds (T054)

**Files:**
- Modify: `apps/api/src/agent-gateway/agent-gateway.service.spec.ts`

- [ ] **Step 1: Write failing unit tests for `getBookingSummaries`**
  - Verify query uses `prisma.bookingAgentProjection.findMany`.
  - Spies verify `prisma.booking.findMany`, `prisma.booking.findUnique`, `prisma.payment.*` are never queried for raw snapshot fields.
  - Assert forbidden fields are absent from response objects.

- [ ] **Step 2: Write failing unit tests for `getBookingDetailByReference`**
  - Verify valid owned reference returns exact detail tier.
  - Verify malformed reference (`invalid_ref`, `bkref_bad`) throws 404 `BOOKING_REFERENCE_NOT_FOUND`.
  - Verify non-existent reference throws 404 `BOOKING_REFERENCE_NOT_FOUND`.
  - Verify foreign reference throws 404 `BOOKING_REFERENCE_NOT_FOUND`.
  - Spies verify absence of raw snapshot queries.

- [ ] **Step 3: Run unit tests to confirm RED**
  Run: `npx jest apps/api/src/agent-gateway/agent-gateway.service.spec.ts`
  Expected: FAIL with `getBookingSummaries is not a function`

---

### Task 3: Service Implementation with Projection Exclusivity (T060)

**Files:**
- Modify: `apps/api/src/agent-gateway/agent-gateway.service.ts`

- [ ] **Step 1: Implement `getBookingSummaries(userId, traceId?, correlationId?)`**
  Query `prisma.bookingAgentProjection.findMany({ where: { booking: { userId } }, select: { ... } })`, map to DTO, log tool call, return `{ bookings }`.

- [ ] **Step 2: Implement `getBookingDetailByReference(userId, bookingReference, traceId?, correlationId?)`**
  Validate regex `/^bkref_[0-9a-fA-F-]{36}$/`, query `prisma.bookingAgentProjection.findUnique({ where: { agentReference: bookingReference }, select: { ..., booking: { select: { userId: true } } } })`, enforce ownership, map to DTO, log tool call, return detail DTO.

- [ ] **Step 3: Run unit tests to confirm GREEN**
  Run: `npx jest apps/api/src/agent-gateway/agent-gateway.service.spec.ts`
  Expected: PASS

---

### Task 4: Controller Endpoints and E2E Tests (T055, T061)

**Files:**
- Modify: `apps/api/src/agent-gateway/agent-gateway.controller.ts`
- Modify: `apps/api/test/agent-gateway.e2e-spec.ts`

- [ ] **Step 1: Write failing E2E tests in `apps/api/test/agent-gateway.e2e-spec.ts`**
  - `GET /agent-gateway/users/bookings/summaries`: Authenticated summaries, cross-owner filtering, empty result.
  - `GET /agent-gateway/users/bookings/:bookingReference`: Authenticated detail, cross-owner 404, malformed 404, non-existent 404.
  - Absence of forbidden keys in HTTP responses.

- [ ] **Step 2: Run E2E tests to confirm RED**
  Run: `npx jest apps/api/test/agent-gateway.e2e-spec.ts --runInBand`
  Expected: FAIL (404 for missing routes)

- [ ] **Step 3: Implement controller endpoints in `apps/api/src/agent-gateway/agent-gateway.controller.ts`**
  - Expose `GET users/bookings/summaries`
  - Expose `GET users/bookings/:bookingReference`
  - Delegate to `AgentGatewayService`

- [ ] **Step 4: Run E2E tests to confirm GREEN**
  Run: `npx jest apps/api/test/agent-gateway.e2e-spec.ts --runInBand`
  Expected: PASS

---

### Task 5: Code Review, Verification and Context Synchronization

**Files:**
- Modify: `context/progress-checker.md`
- Modify: `context/architecture.md` (if needed)

- [ ] **Step 1: Run code-review with standards and spec subagents**
- [ ] **Step 2: Run full regression tests**
- [ ] **Step 3: Update `context/progress-checker.md` and check-off tasks T054, T055, T058, T060, T061**
