# Feature 017 Phase 10B: Dark Create & Resolve Handoff Service & Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic NestJS `ChatHandoffService` and `ChatHandoffController` endpoints (`POST /api/chat-handoff/tokens` and `POST /api/chat-handoff/resolve`), enforcing strict attestation-bound credential creation, server-derived idempotency, feature flag gating (`FEATURE_FLAG_CHAT_HANDOFF_ISSUE` and `FEATURE_FLAG_CHAT_HANDOFF_ACCEPT`), active retry convergence, and user-authenticated token resolution without exposing client-supplied session/idempotency parameters.

**Architecture:** Extend `ChatHandoffService` and `ChatHandoffController` in NestJS with service-authenticated creation via `AgentApiKeyGuard` (and claim validation) and user-authenticated resolution via `JwtAuthGuard` with `Cache-Control: no-store`. Ensure strict DTO validation (`forbidNonWhitelisted: true`) rejecting extraneous fields.

**Tech Stack:** NestJS, TypeScript, Prisma, Jest, Supertest, crypto, class-validator.

**Spec:** `specs/017-chatbot-backend-infrastructure/spec.md` (FR-025, FR-026, FR-028, FR-032, FR-034, FR-036) and `specs/017-chatbot-backend-infrastructure/plan.md` (Phase 6 / Work Packages 6C & 6D).

## Global Constraints

- Never expose client-supplied `chatSessionId`, `userId`, or `idempotencyKey` in DTOs or public query params.
- Public issuance remains disabled by default (`FEATURE_FLAG_CHAT_HANDOFF_ISSUE=false`).
- Public acceptance remains gated by `FEATURE_FLAG_CHAT_HANDOFF_ACCEPT`.
- Responses returning credentials or checkout state must set `Cache-Control: no-store, private`.
- All tokens stored as SHA-256 hashes (`tokenHash`, `idempotencyKeyHash`).

---

### Task 1: Strict DTOs (`apps/api/src/chat-handoff/dto/`)

**Files:**
- Modify: `apps/api/src/chat-handoff/dto/create-chat-handoff.dto.ts`
- Modify: `apps/api/src/chat-handoff/dto/resolve-chat-handoff.dto.ts`
- Modify: `apps/api/src/chat-handoff/dto/chat-handoff-response.dto.ts`
- Test: `apps/api/src/chat-handoff/chat-handoff.service.spec.ts`

**Interfaces:**
- `CreateChatHandoffDto`: `selectionAttestationHash` / `attestation: string`, `selectedOfferIndex: number`.
- `ResolveChatHandoffDto`: `token: string`.
- `ChatHandoffResponseDto`: `token: string`, `expiresAt: string`.

- [ ] **Step 1: Write DTO validation tests in unit spec**
- [ ] **Step 2: Update DTO definitions ensuring class-validator annotations and forbidding extra fields**
- [ ] **Step 3: Verify tests pass**

---

### Task 2: Service-Level Creation & Active Retry Convergence (`ChatHandoffService`)

**Files:**
- Modify: `apps/api/src/chat-handoff/chat-handoff.service.ts`
- Test: `apps/api/src/chat-handoff/chat-handoff.service.spec.ts`

**Interfaces:**
- Consumes: `SelectionAttestationService.verifySelectionAttestation`, `ChatHandoffTokenService.deriveIdempotencyHash`, `ChatHandoffTokenService.generateToken`.
- Produces: `createHandoffToken(dto, context)` / `create(dto, context)` returning `{ token, expiresAt }`.

- [ ] **Step 1: Write unit tests for attestation validation, active retry returning existing token, offer freshness, session ownership, and flag checks**
- [ ] **Step 2: Implement `createHandoffToken` and active-retry convergence logic in `ChatHandoffService`**
- [ ] **Step 3: Run unit tests and ensure green**

---

### Task 3: Service-Level Resolution & Safe Allowlist Shape (`ChatHandoffService`)

**Files:**
- Modify: `apps/api/src/chat-handoff/chat-handoff.service.ts`
- Test: `apps/api/src/chat-handoff/chat-handoff.service.spec.ts`

**Interfaces:**
- Consumes: `ChatHandoffTokenService.verifyToken`, `PrismaService.chatHandoff`, `PrismaService.flightOffer`.
- Produces: `resolveHandoffToken(token, userId, context)` / `resolve(token, userId, context)` / `resolveSafe(token, userId, context)`.

- [ ] **Step 1: Write unit tests for resolve: owner verification, non-expired, non-consumed, active session, flag checks, and safe response mapping**
- [ ] **Step 2: Implement resolution logic in `ChatHandoffService`**
- [ ] **Step 3: Run unit tests and ensure green**

---

### Task 4: Controller Endpoints & Guards (`ChatHandoffController`)

**Files:**
- Modify: `apps/api/src/chat-handoff/chat-handoff.controller.ts`
- Modify: `apps/api/src/chat-handoff/chat-handoff.module.ts`
- Test: `apps/api/test/chat-handoff.e2e-spec.ts`

**Interfaces:**
- Endpoints:
  - `POST /api/chat-handoff/tokens` and `POST /api/chat-handoff` (`@UseGuards(AgentApiKeyGuard)`)
  - `POST /api/chat-handoff/resolve` and `GET /api/chat-handoff/resolve` (`@UseGuards(JwtAuthGuard)`)
  - Sets `Cache-Control: no-store, private` headers.

- [ ] **Step 1: Write E2E tests for service-auth create, user-auth resolve, flag gating, and cross-user rejection in `chat-handoff.e2e-spec.ts`**
- [ ] **Step 2: Update `ChatHandoffController` routing, guards, and headers**
- [ ] **Step 3: Run E2E and unit test suites**

---

### Task 5: Verification & Documentation Sync

**Files:**
- Modify: `specs/017-chatbot-backend-infrastructure/tasks.md` (check T066, T067, T075, T076, T077)
- Modify: `context/progress-checker.md`
- Modify: `context/architecture.md`

- [ ] **Step 1: Run complete test suite across `apps/api`**
- [ ] **Step 2: Run code review subagents (Standards and Spec)**
- [ ] **Step 3: Update documentation and progress tracking**
