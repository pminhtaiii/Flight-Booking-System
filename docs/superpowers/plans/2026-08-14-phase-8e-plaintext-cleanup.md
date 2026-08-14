# Phase 8E: Approved Encrypted-Chat Plaintext Cleanup (T102) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently drop legacy plaintext storage (`ChatMessage.content` and `ChatSession.title`) from PostgreSQL and remove legacy fallback readers/writers across NestJS, transitioning to 100% AES-256-GCM encrypted persistence with record-bound authenticated envelopes.

**Architecture:** 
1. Strict AES-256-GCM encryption with record-bound AAD in `ChatMessageCryptoService` (no legacy plaintext fallback).
2. Service writes in `ChatService` write exclusively to ciphertext envelope columns (`contentCiphertext`, `titleCiphertext`, nonce, authTag, keyVersion).
3. `AgentGatewayService` and readers decrypt message envelopes using `ChatMessageCryptoService`.
4. Preflight-guarded migration `20260805010000_chat_message_plaintext_cleanup` drops columns `content` from `chat_messages` and `title` from `chat_sessions` only after verifying zero unmigrated rows.
5. All test suites updated to use encrypted envelopes and verify zero plaintext database persistence.

**Tech Stack:** NestJS, Prisma ORM, PostgreSQL, AES-256-GCM (`crypto`), Jest, TypeScript.

**Spec:** `specs/017-chatbot-backend-infrastructure/spec.md`

## Global Constraints

- Never weaken, delete, or skip existing tests.
- Maintain constant-time token comparison and opaque trace/correlation ID format (`chat_<32 hex>`).
- Plaintext `ChatMessage.content` and `ChatSession.title` must never appear in PostgreSQL, backups, logs, or error traces.
- No rollback to plaintext is possible once migration is applied.

---

### Task 1: Write Failing Privacy & Cleanup Verification Tests (TDD RED)

**Files:**
- Create: `apps/api/test/chat-plaintext-cleanup.e2e-spec.ts`
- Modify: `apps/api/src/chat/chat-message-crypto.service.spec.ts`

**Interfaces:**
- Consumes: `ChatMessageCryptoService`, `ChatService`, `PrismaService`
- Produces: Test assertions for zero-plaintext schema columns, raw database table plaintext scans, record-bound decryption, and strict decryption errors without plaintext fallback.

- [ ] **Step 1: Write failing E2E test `apps/api/test/chat-plaintext-cleanup.e2e-spec.ts`**
  - Verify `information_schema.columns` has 0 rows for `table_name = 'chat_messages' AND column_name = 'content'`.
  - Verify `information_schema.columns` has 0 rows for `table_name = 'chat_sessions' AND column_name = 'title'`.
  - Verify `prisma.chatMessage.create` with `content: ...` is rejected by TypeScript / schema.
  - Verify raw DB row contains only ciphertext envelopes and raw database scan finds 0 instances of seeded message strings.
  - Verify API endpoints `GET /api/chat/sessions/:id` and `GET /api/chat/sessions/:id/messages` return decrypted content.

- [ ] **Step 2: Add strict decryption unit tests to `apps/api/src/chat/chat-message-crypto.service.spec.ts`**
  - Verify `decryptMessageContent` throws an error when ciphertext is corrupted or missing without falling back to `message.content`.
  - Verify `decryptSessionTitle` throws when title ciphertext is corrupted without falling back to `session.title`.

- [ ] **Step 3: Run test suites and verify expected failure (RED)**
  - Run: `pnpm --filter @api/backend test -- chat-message-crypto.service.spec.ts`

---

### Task 2: Refactor Legacy Readers & Writers in NestJS Backend

**Files:**
- Modify: `apps/api/src/chat/chat-message-crypto.service.ts`
- Modify: `apps/api/src/chat/chat.service.ts`
- Modify: `apps/api/src/agent-gateway/agent-gateway.service.ts`

**Interfaces:**
- Consumes: `ChatMessageCryptoService`, `ChatService`, `PrismaService`
- Produces: Encrypted-only writes and strict authenticated decryption.

- [ ] **Step 1: Update `ChatMessageCryptoService`**
  - Remove fallback to `message.content` and `session.title`.
  - Enforce strict decryption and throw controlled error on decryption failure.

- [ ] **Step 2: Update `ChatService`**
  - In `createSession` and `updateSession`: write exclusively to `titleCiphertext`, `titleNonce`, `titleAuthTag`, `titleKeyVersion`.
  - In `createMessage` and `createMessageBatch`: write exclusively to `contentCiphertext`, `contentNonce`, `contentAuthTag`, `contentKeyVersion`.
  - Ensure `CHAT_ENCRYPTION_KEY` is validated.

- [ ] **Step 3: Update `AgentGatewayService`**
  - Inject `ChatMessageCryptoService`.
  - In `searchFlights` and `searchFlightsAttested`: decrypt `lastMessage` with `decryptMessageContent` before evaluating keyword triggers (`business`, `infant`).

- [ ] **Step 4: Update Existing Tests Seeding Legacy Columns**
  - Update direct Prisma inserts in `apps/api/test/chat.e2e-spec.ts`, `apps/api/test/agent-chat-gateway.e2e-spec.ts`, `apps/api/test/agent-gateway.e2e-spec.ts`, `apps/api/test/booking-intent.e2e-spec.ts`, and `apps/api/test/chat-handoff-observability.e2e-spec.ts` to use ciphertext fields or `chatService`.

- [ ] **Step 5: Run unit & service tests to verify GREEN**
  - Run: `pnpm --filter @api/backend test -- chat-message-crypto.service.spec.ts`
  - Run: `pnpm --filter @api/backend test -- chat.service.spec.ts`

---

### Task 3: Apply Migration & Update Prisma Schema

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260805010000_chat_message_plaintext_cleanup/migration.sql`

**Interfaces:**
- Consumes: PostgreSQL Database (`test_db`)
- Produces: Schema without `ChatMessage.content` or `ChatSession.title` columns.

- [ ] **Step 1: Update `apps/api/prisma/schema.prisma`**
  - Remove `title String?` from `ChatSession`.
  - Remove `content String?` from `ChatMessage`.

- [ ] **Step 2: Create Migration SQL `apps/api/prisma/migrations/20260805010000_chat_message_plaintext_cleanup/migration.sql`**
  - Include DO $$ preflight check asserting 0 rows with plaintext and missing ciphertext envelopes.
  - Drop columns:
    ```sql
    ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "content";
    ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "title";
    ```

- [ ] **Step 3: Run Prisma Generate and Migrate**
  - Run: `pnpm --filter @api/backend exec prisma generate`
  - Run: `pnpm --filter @api/backend exec prisma migrate dev` (or migrate deploy)
  - Verify migration status: `pnpm --filter @api/backend exec prisma migrate status`

- [ ] **Step 4: Run `chat-plaintext-cleanup.e2e-spec.ts` and E2E Suites to verify GREEN**
  - Run: `npm run test:e2e --workspace=apps/api -- --runTestsByPath test/chat-plaintext-cleanup.e2e-spec.ts`

---

### Task 4: Full Regression & Privacy Corpus Gate Verification

**Files:**
- Test all API E2E suites: `npm run test:e2e --workspace=apps/api`
- Test Python Agent suites: `uv run pytest`
- Test Web Unit suites: `pnpm --filter @web/frontend test`

- [ ] **Step 1: Run Privacy Corpus E2E Test**
  - Run: `npm run test:e2e --workspace=apps/api -- --runTestsByPath test/chat-privacy-corpus.e2e-spec.ts`
- [ ] **Step 2: Run Full API Unit and E2E Tests**
  - Run: `pnpm --filter @api/backend test`
  - Run: `npm run test:e2e --workspace=apps/api -- --runTestsByPath test/agent-chat-gateway.e2e-spec.ts test/chat-handoff.e2e-spec.ts test/chat.e2e-spec.ts test/chat-persistence-migration.e2e-spec.ts`
- [ ] **Step 3: Run Full Agent Pytest Suite**
  - Run: `uv run pytest` in `apps/agent`
- [ ] **Step 4: Run Web Unit Suites and Build**
  - Run: `pnpm --filter @web/frontend build`

---

### Task 5: Document Completion Evidence & Update Feature Specifications

**Files:**
- Modify: `specs/017-chatbot-backend-infrastructure/tasks.md` (mark T102 `[x]`)
- Modify: `specs/017-chatbot-backend-infrastructure/quickstart.md`
- Modify: `specs/017-chatbot-backend-infrastructure/data-model.md`
- Modify: `specs/017-chatbot-backend-infrastructure/plan.md`
- Modify: `specs/017-chatbot-backend-infrastructure/contracts/api.md`
- Modify: `context/architecture.md`
- Modify: `context/progress-checker.md`
- Modify: `docs/runbooks/chatbot-handoff.md`

- [ ] **Step 1: Update task tracking and checklists in `tasks.md`**
- [ ] **Step 2: Record irreversible cleanup evidence and commands in `quickstart.md` and `docs/runbooks/chatbot-handoff.md`**
- [ ] **Step 3: Update `context/architecture.md`, `context/progress-checker.md`, and data model specs**
- [ ] **Step 4: Generate completion handoff in Temp directory**
