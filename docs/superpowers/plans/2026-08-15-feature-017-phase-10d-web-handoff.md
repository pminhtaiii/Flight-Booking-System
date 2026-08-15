# Feature 017 Phase 10D: Web Handoff Bootstrap & Clean Checkout Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the frontend checkout handoff card, same-origin CSRF/origin-protected bootstrap route, HttpOnly cookie binding, and clean-URL checkout passenger resolution (Work Package 6G / Tasks T072, T081, T082) for Feature 017.

**Architecture:** Connect Next.js frontend to streaming `ACTION_HANDOFF` SSE events via `CheckoutHandoffCard`, execute same-origin POST bootstrap to `/checkout/handoff` that sets short-lived `HttpOnly; Secure; SameSite=Strict` cookie (`chat_handoff_token`), and cleanly resolve checkout context in Server Component `/checkout/passengers` via backend `POST /api/bookings/handoffs/resolve` (and fallback mock resolution in test mode) with zero token leakage in URLs, browser storage, or client telemetry.

**Tech Stack:** Next.js 14 App Router, React 18, Semantic Design System Tokens, TypeScript, NextAuth.js, NestJS backend API, Node.js Test Runner (`node:test` + `tsx`), Playwright E2E.

**Spec:** `specs/017-chatbot-backend-infrastructure/spec.md`, `specs/017-chatbot-backend-infrastructure/contracts/api.md`, `specs/017-chatbot-backend-infrastructure/plan.md`.

## Global Constraints

- The handoff credential MUST be transported to the server ONLY in the POST body to `/checkout/handoff`.
- The bootstrap route MUST verify the `Origin` / `Referer` header against the application base URL to prevent CSRF.
- The cookie MUST have flags: `HttpOnly`, `Secure` (in production/HTTPS), `SameSite=Strict`, `Path=/` (or `/checkout`).
- The URL MUST remain clean (`/checkout/passengers`) with no query parameters (`?token=...` is strictly forbidden).
- The raw token MUST NEVER be written to `localStorage`, `sessionStorage`, or client-side telemetry logs.
- Never use hardcoded hex values or raw Tailwind color classes. Always use semantic design system tokens.
- Use subagents for implementation and code review to avoid context rot.

---

### Task 1: Handoff Bootstrap & Resolution Core Logic

**Files:**
- Modify: `apps/web/lib/handoffBootstrap.ts`
- Modify: `apps/web/lib/handoffCookie.ts`
- Modify: `apps/web/lib/checkout.ts`
- Test: `apps/web/tests/handoff-bootstrap.unit.ts`
- Test: `apps/web/tests/handoff-cookie.unit.mts`
- Test: `apps/web/tests/handoff-privacy.unit.ts`

**Interfaces:**
- Consumes: `@shared/types/chat.types.ts` (`HandoffEvent`, `actionHandoffSchema`).
- Produces: `resolveHandoffForBootstrap(apiUrl, handoffToken, accessToken, traceId?, correlationId?, fetcher?)`, `createHandoffRedirectResponse(requestUrl, handoffToken)`.

- [ ] **Step 1: Verify test-mode / mock fixture support in `resolveHandoffForBootstrap`**
Ensure `resolveHandoffForBootstrap` supports test fixtures when `NODE_ENV === 'test'` or `CI === 'true'` and mock scenario or dummy test token is provided, while strictly enforcing real HTTP fetch in production.

- [ ] **Step 2: Run unit test suite to verify GREEN**
Run: `& '.\node_modules\.bin\tsx.CMD' --test apps/web/tests/handoff-bootstrap-acceptance.unit.ts apps/web/tests/handoff-bootstrap.unit.ts apps/web/tests/handoff-form-submission.unit.ts apps/web/tests/handoff-checkout-proxy.unit.ts apps/web/tests/handoff-cookie.unit.mts apps/web/tests/handoff-privacy.unit.ts apps/web/tests/handoff-credential.unit.ts apps/web/tests/checkout-handoff-origin.unit.ts`
Expected: PASS (all 21 unit tests).

- [ ] **Step 3: Commit**
`git add apps/web/lib/ apps/web/tests/`
`git commit -m "feat(web): ensure robust handoff bootstrap and resolution core logic"`

---

### Task 2: Same-Origin Bootstrap Route & Server-Side Passenger Page Resolution

**Files:**
- Modify: `apps/web/app/checkout/handoff/route.ts`
- Modify: `apps/web/app/checkout/passengers/page.tsx`
- Modify: `apps/web/components/chat/CheckoutHandoffCard.tsx`
- Modify: `apps/web/components/chat/ChatWidget.tsx`
- Test: `apps/web/tests/chat-checkout-handoff.spec.ts`

**Interfaces:**
- Consumes: `createHandoffRedirectResponse`, `readHandoffCredential`, `hasValidSameOriginHeaders`, `resolveHandoffForBootstrap`.
- Produces: `POST /checkout/handoff` handler and `/checkout/passengers` Server Component rendering.

- [ ] **Step 1: Ensure `route.ts` handles cookie setting and clean redirect**
In `apps/web/app/checkout/handoff/route.ts`, verify origin validation, CSRF checking, authentication, reading `handoffToken` from form body, validating upstream resolve (with test mock fallback), setting `HttpOnly; Secure; SameSite=Strict` cookie, and returning `303 See Other` to `/checkout/passengers`.

- [ ] **Step 2: Ensure `passengers/page.tsx` resolves handoff cookie and renders flight context**
In `apps/web/app/checkout/passengers/page.tsx`, read `chat_handoff_token` cookie, call `resolveHandoffForBootstrap`, render prefilled passenger form with resolved offer context, and handle expired/missing token gracefully.

- [ ] **Step 3: Run Playwright E2E tests**
Run: `& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-checkout-handoff.spec.ts' --config='apps/web/tests/playwright.config.ts' --reporter=line`
Expected: PASS (9 passed).

- [ ] **Step 4: Commit**
`git add apps/web/app/checkout/ apps/web/components/chat/`
`git commit -m "feat(web): complete same-origin bootstrap route and passenger page resolution"`

---

### Task 3: Full Suite Verification, Code Review & Documentation

**Files:**
- Modify: `context/progress-checker.md`
- Modify: `specs/017-chatbot-backend-infrastructure/tasks.md`
- Modify: `context/architecture.md`

- [ ] **Step 1: Run all unit and E2E test suites**
Run: `& '.\node_modules\.bin\tsx.CMD' --test apps/web/tests/handoff-bootstrap-acceptance.unit.ts apps/web/tests/handoff-bootstrap.unit.ts apps/web/tests/handoff-form-submission.unit.ts apps/web/tests/handoff-checkout-proxy.unit.ts apps/web/tests/handoff-cookie.unit.mts apps/web/tests/handoff-privacy.unit.ts apps/web/tests/handoff-credential.unit.ts apps/web/tests/checkout-handoff-origin.unit.ts`
Run: `pnpm --filter @web/frontend build`
Run: `pnpm --filter @api/backend build`
Run: `& '.\apps\web\node_modules\.bin\playwright.CMD' test 'apps/web/tests/chat-checkout-handoff.spec.ts' --config='apps/web/tests/playwright.config.ts' --reporter=line`

- [ ] **Step 2: Run code review subagents for Standards and Spec compliance**
Launch subagents to verify code standards (no hardcoded colors, semantic tokens, strict types) and spec compliance (FR-029, FR-030, FR-032).

- [ ] **Step 3: Update documentation and task tracking**
Update `tasks.md` and `context/progress-checker.md`.

- [ ] **Step 4: Commit documentation and status updates**
`git add context/ specs/017-chatbot-backend-infrastructure/`
`git commit -m "docs(web): record phase 10d web handoff resolution verification"`
