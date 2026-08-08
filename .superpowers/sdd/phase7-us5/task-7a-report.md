# Work Package 7A Report — T085, T087, T091

## Status

Complete. The ISSUE/ACCEPT rollback contract, direct authenticated browser transport, session continuity, and proxy fallback are covered. Only T085, T087, and T091 were marked complete in `tasks.md`.

## Changes

- Added an agent-side `FEATURE_FLAG_CHAT_HANDOFF_ISSUE` guard before the deterministic node can obtain or invoke the NestJS client.
- Corrected the NestJS gates so create is controlled by ISSUE and resolve/credential acceptance is controlled by ACCEPT at both controller and service boundaries.
- Added stable issuance-disabled and acceptance-disabled errors and proved ISSUE-off creates do not mint a token or write a handoff.
- Kept invalid production configuration (`ISSUE=true`, `ACCEPT=false`) rejected by both Pydantic and Zod startup validation.
- Added an explicit proxy rollback browser scenario for `NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM=false`; the existing Next.js proxy route was not deleted or deactivated.
- Added direct-stream Playwright coverage for FastAPI URL selection, bearer authentication, browser Origin, proxy bypass, and `done.sessionId` reuse on the next turn.
- Wired `ChatWidget` to the canonical NextAuth session token and retained the strict `done` session-id parser/state path.
- Moved `ChatWidget` under the existing `SessionProvider`, making `useSession()` valid in the actual root provider tree.
- Added a direct-stream Playwright profile that runs the Next.js development server with the direct flag/public agent URL and omits the unrelated API readiness server for this fully intercepted browser boundary test.

## Intentional Files

- `apps/agent/src/agent/graph/nodes.py`
- `apps/agent/tests/test_config.py`
- `apps/agent/tests/test_handoff_nodes.py`
- `apps/api/src/chat-handoff/chat-handoff.config.spec.ts`
- `apps/api/src/chat-handoff/chat-handoff.controller.ts`
- `apps/api/src/chat-handoff/chat-handoff.service.spec.ts`
- `apps/api/src/chat-handoff/chat-handoff.service.ts`
- `apps/web/app/layout.tsx`
- `apps/web/components/chat/ChatWidget.tsx`
- `apps/web/tests/chat-checkout-handoff.spec.ts`
- `apps/web/tests/chat-direct-stream.spec.ts`
- `apps/web/tests/playwright.config.ts`
- `specs/017-chatbot-backend-infrastructure/tasks.md`
- `.superpowers/sdd/phase7-us5/task-7a-report.md`

Generated `apps/web/playwright-report/index.html`, `apps/web/tsconfig.tsbuildinfo`, and `.pnpm-store` artifacts were intentionally not staged.

## RED Evidence

### Agent issuance gate

Command, from `apps/agent` (workspace UV cache used because the global cache was not writable):

```powershell
$env:UV_CACHE_DIR='C:\Booking Systems\.uv-cache'; uv run pytest tests/test_config.py -q
```

Expected RED:

```text
FAILED test_agent_does_not_invoke_handoff_create_when_issue_is_disabled
AssertionError: Expected create_handoff to not have been awaited. Awaited 1 times.
1 failed, 2 passed
```

### NestJS rollback gates

Command:

```powershell
pnpm --filter @api/backend test -- --runInBand src/chat-handoff/chat-handoff.config.spec.ts
```

Expected RED:

```text
create resolved instead of rejecting when ISSUE=false
resolve rejected instead of honoring an existing credential when ACCEPT=true
ACCEPT=false returned the old non-specific error
3 failed, 2 passed
```

The aligned service test then exposed the same swapped service gates before implementation. Its existing claim tests also exposed a missing `updateMany` test double; that test harness was completed without weakening behavior.

### Direct browser transport

`apps/web/tests/chat-direct-stream.spec.ts` was written before the ChatWidget auth/provider change. Local RED attempts did not reach browser assertions because the initial environment had a missing Playwright binary and then an unrelated API health-readiness failure. After dependencies were restored, the user supplied successful Playwright execution and explicitly authorized continuing without rerunning Playwright. This is recorded honestly rather than claiming an unobserved browser RED output.

## GREEN Evidence

### Agent focused regression

```powershell
$env:UV_CACHE_DIR='C:\Booking Systems\.uv-cache'; uv run pytest tests/test_config.py tests/test_handoff_nodes.py -q
```

```text
8 passed, 1 PytestCacheWarning
```

The warning is limited to pytest's optional `.pytest_cache` write; tests executed and passed.

### API focused regression

Prisma client generation was refreshed after dependency restoration, then the installed Jest binary was used directly:

```powershell
.\node_modules\.bin\prisma.CMD generate --schema=prisma\schema.prisma
.\node_modules\.bin\jest.CMD --runInBand --runTestsByPath `
  'C:\Booking Systems\apps\api\src\chat-handoff\chat-handoff.config.spec.ts' `
  'C:\Booking Systems\apps\api\src\chat-handoff\chat-handoff.service.spec.ts'
```

```text
PASS chat-handoff.service.spec.ts
PASS chat-handoff.config.spec.ts
Test Suites: 2 passed, 2 total
Tests: 17 passed, 17 total
```

### Browser focused regression

User-provided verification: the Work Package 7A Playwright tests passed after the environment and dependencies were restored. Per the user's explicit direction, Playwright was not rerun by this agent afterward. The verified coverage includes the direct FastAPI request, bearer auth/Origin, proxy bypass, second-turn session reuse, and the direct-off proxy rollback scenario.

## Additional Checks

- `git diff --check`: no whitespace errors.
- Direct TypeScript check reached project sources and reported only the pre-existing missing Jest globals in `apps/web/lib/chatStream.spec.ts` and `apps/web/lib/featureFlags.spec.ts`; it reported no `ChatWidget`, layout, Playwright spec, or Playwright config type error.
- A targeted ESLint process produced no diagnostics but did not terminate promptly; it was stopped and treated as non-gating as directed.
- The installed Next.js version is 14.2.3 and does not ship the instructed `node_modules/next/dist/docs/` tree. The bundled package/type surface was inspected before changing Next.js files.

## Self-Review

- ISSUE-off is enforced before the agent client call and independently at NestJS controller/service boundaries.
- ACCEPT remains independent: already-issued credentials are honored with ACCEPT on after ISSUE rollback, while ACCEPT off yields a stable disabled error without partial work.
- Invalid ISSUE-on/ACCEPT-off startup remains rejected.
- No token, offer, user, or session value was added to logs or error text.
- `ACTION_REQUIRED` parsing/rendering was untouched.
- The proxy route remains present and operational under the direct-off flag.
- `useSession()` is valid because `ChatWidget` is now rendered within `Providers`/`SessionProvider`.
- Session continuity continues to accept only bounded safe session IDs from the `done` event.

## Concerns / Follow-up

- Cross-service trace/correlation header sanitization is owned by T090/Work Package 7C. This package does not add logs or headers; T090 must retain the brief's prohibition against deriving correlation headers from session/user/offer/token values.
- Repository-level web typecheck remains affected by the existing Jest-global configuration issue described above.
