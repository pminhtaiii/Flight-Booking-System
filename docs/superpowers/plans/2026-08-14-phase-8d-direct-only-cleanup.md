# Phase 8D Execution Plan: Approved Direct-Only Transport Cleanup

**Feature**: `017-chatbot-backend-infrastructure`  
**Phase**: `Phase 8D: Approved Direct-Only Cleanup (T101)`  
**Scope**: Complete only T101. Explicit prior approval granted for Phase 8D. Do NOT start T102.

---

## 1. Objectives

1. **Archive Proxy Rollback Matrix**:
   - Preserve and archive the historical proxy rollback test matrix and evidence in `specs/017-chatbot-backend-infrastructure/quickstart.md` and `docs/runbooks/chatbot-handoff.md`.
   - Update architecture diagrams and runbooks to reflect the permanent direct-only browser-to-agent streaming topology.

2. **Remove Proxy Route & Obsolete Configuration**:
   - Delete `apps/web/app/api/chat/stream/route.ts` and `apps/web/app/api/chat/stream/route.spec.ts`.
   - Remove temporary exception in `context/code-standards.md`.
   - Remove obsolete `NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM` from `apps/web/.env.example` and document `NEXT_PUBLIC_AGENT_URL`.
   - Clean up `apps/web/lib/chatStream.ts` to direct-stream without proxy fallback branching.
   - Clean up `apps/agent/src/agent/config.py`, `apps/agent/.env.example`, and `apps/agent/tests/test_config.py` mirror settings.

3. **Direct-Only Configuration Tests (TDD)**:
   - In `apps/web/lib/featureFlags.spec.ts`, replace `Direct=false` test with direct-only configuration validation / legacy proxy removal tests.
   - In `apps/web/lib/chatStream.spec.ts`, replace proxy fallback tests with direct-only endpoint resolution and header generation tests.
   - In `apps/web/tests/chat-direct-stream.spec.ts`, assert that `/api/chat/stream` proxy route is 404 (removed) and direct stream functions with bearer authentication and opaque trace headers.

4. **Verify Direct-Stream Continuity & Full Regressions**:
   - Web boundary unit tests: `pnpm --filter @web/frontend test` / `tsx --test`.
   - Next.js production build: `node node_modules/next/dist/bin/next build` in `apps/web`.
   - API handoff & gateway tests: `npm run test -- chat-handoff` in `apps/api`.
   - Playwright direct-only stream & checkout handoff flow (exit 0).
   - Agent pytest suite: `uv run pytest` in `apps/agent`.

5. **Reconciliation & Handoff**:
   - Update `specs/017-chatbot-backend-infrastructure/tasks.md` (mark T101 `[x]`).
   - Update `context/architecture.md`, `context/progress-checker.md`, `quickstart.md`, `docs/runbooks/chatbot-handoff.md`.
   - Generate redacted handoff artifact in user Temp directory.

---

## 2. File Modification & Deletion Inventory

### Deletions
- `apps/web/app/api/chat/stream/route.ts`
- `apps/web/app/api/chat/stream/route.spec.ts`

### Modifications
- `apps/web/lib/chatStream.ts`
- `apps/web/lib/chatStream.spec.ts`
- `apps/web/lib/featureFlags.ts`
- `apps/web/lib/featureFlags.spec.ts`
- `apps/web/.env.example`
- `apps/web/tests/playwright.config.ts`
- `apps/web/tests/chat-checkout-handoff.spec.ts`
- `apps/web/tests/chat-booking-readiness.spec.ts`
- `apps/web/tests/chat-direct-stream.spec.ts`
- `apps/api/test/chat-handoff.e2e-spec.ts`
- `apps/agent/src/agent/config.py`
- `apps/agent/.env.example`
- `apps/agent/tests/test_config.py`
- `context/code-standards.md`
- `context/architecture.md`
- `context/progress-checker.md`
- `docs/runbooks/chatbot-handoff.md`
- `specs/017-chatbot-backend-infrastructure/quickstart.md`
- `specs/017-chatbot-backend-infrastructure/tasks.md`
- `AGENTS.md`

---

## 3. Step-by-Step Implementation & Verification Flow

```mermaid
flowchart TD
    A[Step 1: Write Failing Direct-Only Tests (RED)] --> B[Step 2: Remove Proxy Route & Refactor chatStream.ts (GREEN)]
    B --> C[Step 3: Update Test Harnesses & Clean Config]
    C --> D[Step 4: Execute Full Regression Suite]
    D --> E[Step 5: Two-Axis Code Review Subagents]
    E --> F[Step 6: Reconcile Documentation & Tasks]
    F --> G[Step 7: Redacted Handoff Artifact]
```

### Step 1: RED Test for Direct-Only Configuration
- Add tests in `apps/web/lib/featureFlags.spec.ts` and `apps/web/lib/chatStream.spec.ts` asserting direct-only transport behavior and rejecting/disallowing false transport toggles.
- Add test in `apps/web/tests/chat-direct-stream.spec.ts` asserting `/api/chat/stream` is not found.

### Step 2: GREEN Code Cleanup
- Delete `apps/web/app/api/chat/stream/route.ts` and `apps/web/app/api/chat/stream/route.spec.ts`.
- Simplify `apps/web/lib/chatStream.ts` to always target direct agent endpoint with Authorization header and opaque trace headers.
- Update `apps/web/lib/featureFlags.ts` and `.env.example`.
- Update `apps/agent/src/agent/config.py` and `.env.example`.

### Step 3: Harness Updates & Build Verification
- Update Playwright route intercepts from `**/api/chat/stream` to direct agent endpoint.
- Verify web unit tests: `pnpm --filter @web/frontend test`.
- Verify Next.js production build compiles without proxy route.

### Step 4: Regressions
- Run full agent pytest suite: `uv run pytest`.
- Run NestJS API unit and E2E suites: `npm run test -- chat-handoff` and E2E.
- Run Playwright browser direct-stream & handoff test with exit code 0.

### Step 5: Dual-Axis Review
- Run standards review subagent (caveman style, standards adherence, no hardcoded Tailwind/hex).
- Run spec review subagent (Feature 017 spec compliance, no T102 scope leakage).

### Step 6: Documentation & Progress
- Archive rollback evidence in `docs/runbooks/chatbot-handoff.md` and `quickstart.md`.
- Mark T101 `[x]` in `tasks.md`.
- Update `context/architecture.md` and `context/progress-checker.md`.

### Step 7: Handoff
- Create redacted handoff artifact in user Temp directory.
