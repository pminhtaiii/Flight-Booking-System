# Phase 8C Execution Plan: Privacy Verification & Full Regression

**Feature**: `017-chatbot-backend-infrastructure`  
**Phase**: `Phase 8C: Privacy and Full Regression (T099, T100)`  
**Scope**: Complete T099 and T100. Do NOT start T101 or T102.

---

## 1. Objectives

1. **T099 Privacy Verification**:
   - Verify zero leakage of the seeded negative privacy corpus (handoff tokens, hashes, offer IDs, booking IDs, PNRs, passenger PII, contact info, passport numbers, card/payment data, plaintext chat content) across:
     - LLM fixtures, ToolMessages, and agent prompts
     - SSE payloads and server logs
     - NestJS structured telemetry and audit metadata
     - Access logs, request URLs, and bootstrap paths
     - Browser DOM, URLs, console, localStorage, sessionStorage, and readable cookies
     - Database encrypted content/title models and dual-read fallback boundaries
     - Bounded opaque trace (`chat_<32 lowercase hex>`) and correlation headers
   - Close known privacy release gaps:
     - `ChatMessageCryptoService`: sanitize fallback warning logs (remove raw message/session IDs and raw error strings)
     - `ClaimTokenService`: sanitize database/inactive user warning logs (remove raw `userId` interpolation)
   - Add/verify automated privacy test suites across `apps/agent`, `apps/api`, and `apps/web`.
   - Record comprehensive privacy evidence in `docs/runbooks/chatbot-handoff.md`.

2. **T100 Full Regression Suite & Documentation Reconciliation**:
   - Run complete Python Agent test suite (`uv run pytest` in `apps/agent`).
   - Run shared package build & type checks (`pnpm --filter @shared/types build`).
   - Run API unit tests (`pnpm --filter @api/backend test`).
   - Run API E2E tests (`npm run test:e2e --workspace=apps/api`).
   - Run Web unit/boundary tests and production Next.js build (`next build` in `apps/web`).
   - Run Playwright tests using Windows-safe commands.
   - Reconcile Feature 017 documentation against verified behavior (`spec.md`, `plan.md`, `data-model.md`, `contracts/api.md`, `tasks.md`, `quickstart.md`, `context/architecture.md`, `context/progress-checker.md`, `docs/runbooks/chatbot-handoff.md`).

---

## 2. Target Files

### Production & Harness Modifications
- `apps/api/src/chat/chat-message-crypto.service.ts` (close logging leakage)
- `apps/api/src/agent-gateway/auth/claim-token.service.ts` (close user ID logging leakage)
- `apps/agent/tests/test_phase8c_privacy.py` (comprehensive agent privacy corpus test suite)
- `apps/api/test/chat-privacy-corpus.e2e-spec.ts` (comprehensive API privacy corpus test suite)
- `apps/web/tests/handoff-privacy.unit.ts` (comprehensive web boundary privacy test suite)

### Documentation Reconciliation
- `specs/017-chatbot-backend-infrastructure/tasks.md` (mark T099, T100 as `[x]`)
- `specs/017-chatbot-backend-infrastructure/quickstart.md` (record Phase 8C evidence)
- `context/architecture.md` (update Phase 8C privacy & regression status)
- `context/progress-checker.md` (update Feature 17 Phase 8 status)
- `docs/runbooks/chatbot-handoff.md` (record T099 privacy corpus results & update Section 10)

---

## 3. Step-by-Step Implementation & Verification

### Step 1: RED Test for Privacy Gaps & Privacy Corpus
1. Create failing privacy tests:
   - In `apps/api/src/chat/chat-message-crypto.service.spec.ts` or `apps/api/test/chat-privacy-corpus.e2e-spec.ts` to assert that decryption fallback logs do not contain raw message IDs, session IDs, or unredacted error details.
   - In `apps/api/test/agent-gateway.e2e-spec.ts` / `apps/api/test/chat-privacy-corpus.e2e-spec.ts` to assert claim-token validation failures do not log raw user IDs.
   - In `apps/agent/tests/test_phase8c_privacy.py` to assert that all agent specialist prompts, ToolMessage serializations, SSE payloads, and telemetry events strictly reject the forbidden privacy corpus.
   - In `apps/web/tests/handoff-privacy.unit.ts` to assert that web bootstrap, card components, and client storage helpers never store or expose credentials, offer IDs, or PII.
2. Confirm tests run RED where logging/boundary gaps exist.

### Step 2: GREEN Implementation
1. Fix `apps/api/src/chat/chat-message-crypto.service.ts`:
   - Replace sensitive logger strings with constant/opaque diagnostic messages.
2. Fix `apps/api/src/agent-gateway/auth/claim-token.service.ts`:
   - Replace `User ${payload.userId}` logging with opaque warning without user ID.
3. Run the focused privacy tests to GREEN.

### Step 3: Full Regression Execution (T100)
1. **Agent Pytest**: `uv run pytest` in `apps/agent`.
2. **Shared build**: `pnpm --filter @shared/types build`.
3. **API Unit tests**: `pnpm --filter @api/backend test`.
4. **API E2E tests**: `npm run test:e2e --workspace=apps/api`.
5. **Web Unit & Build**: `pnpm --filter @web/frontend build`.
6. **Playwright verification**: Run verified Playwright handoff / direct-stream tests.

### Step 4: Code Review (Parallel Subagents)
1. Standards Subagent: Check repository standards, logging rules, TypeScript/Python conventions, and no Tailwind/hex violations.
2. Spec Subagent: Check Feature 017 spec/contract compliance, privacy boundary rules, and ensure no T101/T102 scope leakage.
3. Resolve all P0/P1 findings.

### Step 5: Documentation Reconciliation & Convergence
1. Update `docs/runbooks/chatbot-handoff.md` with T099 privacy corpus results, resolved release gaps, and T098/T099/T100 evidence.
2. Reconcile `tasks.md`, `quickstart.md`, `context/architecture.md`, and `context/progress-checker.md`.
3. Run `speckit-converge` to verify no remaining gaps.
4. Output redacted handoff artifact in user Temp directory.
