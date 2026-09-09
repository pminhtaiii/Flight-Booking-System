# Phase 4 API Empty-Content Persistence Fix

## Scope

The T093 second-turn blocker was an API persistence/crypto compatibility defect. A handoff turn can deliberately persist an AGENT message with empty content; AES-256-GCM represents that plaintext with an empty ciphertext and non-empty nonce, authentication tag, and key version. The API previously treated the empty ciphertext as a missing envelope.

No Python, frontend redirect, schema, migration, plaintext fallback, or full T093 changes were made here. No commit was created.

## Changes

- `apps/api/src/chat/chat-message-crypto.service.ts:173-203`
  - `decryptMessageContent` now accepts a complete envelope when `contentCiphertext === ''` by checking every envelope field explicitly for `null`/`undefined`.
  - Incomplete envelopes still throw `ChatMessage is missing ciphertext envelope or is corrupted`; authenticated decryption failures still throw the generic crypto error.
- `apps/api/src/chat/chat.service.ts:372` and `:590`
  - Single-message and batch persistence now encrypt any defined content, including `''`.
- `apps/api/src/chat/chat-message-crypto.service.spec.ts:121-186`
  - Added empty-content authenticated round-trip coverage.
  - Added coverage for each missing envelope field; no existing assertion was changed.
- `apps/api/test/agent-chat-gateway.e2e-spec.ts:309-336`
  - Added an authenticated real Prisma-backed batch regression for an empty AGENT message, asserting the response round trip and complete stored envelope.

## RED/GREEN evidence

1. Crypto RED before the crypto-service fix:

   ```powershell
   $env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
   pnpm --filter @api/backend test -- --runInBand src/chat/chat-message-crypto.service.spec.ts
   ```

   Exit `1`: 10 tests, 9 passed and the empty-content round trip failed with `ChatMessage is missing ciphertext envelope or is corrupted`. The incomplete-envelope test was already green.

2. Crypto GREEN after the explicit envelope check:

   Same command, exit `0`: 1 suite, 10 tests passed.

3. Database readiness before the gateway regression:

   ```powershell
   $env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
   Push-Location apps/api
   & '.\node_modules\.bin\prisma.CMD' migrate status
   Pop-Location
   ```

   Exit `0`: 23 migrations found and the test database was up to date.

4. Gateway RED before the ChatService persistence fix:

   ```powershell
   $env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
   Push-Location apps/api
   & '.\node_modules\.bin\jest.CMD' --config '.\test\jest-e2e.json' --runInBand 'agent-chat-gateway.e2e-spec.ts' --testNamePattern 'should persist an empty agent turn with a complete encrypted envelope'
   Pop-Location
   ```

   Exit `1`: the targeted request returned HTTP 500 from the missing-envelope error; 1 test failed and 11 were skipped.

5. Gateway GREEN after both ChatService guards:

   Same command, exit `0`: 1 targeted test passed and 11 were skipped. The request returned 201, response content was `''`, and the row contained empty ciphertext plus nonce, auth tag, and key version `1`.

6. Focused API unit coverage:

   ```powershell
   $env:NODE_OPTIONS = '--require="C:/Booking Systems/tests/ci/node-network-guard.cjs"'
   pnpm --filter @api/backend test -- --runInBand src/chat/chat-message-crypto.service.spec.ts src/chat/agent-chat.controller.spec.ts
   ```

   Exit `0`: 2 suites, 30 tests passed.

7. API quality gates:

   - `pnpm --filter @api/backend lint` — exit `0`.
   - Prescribed `pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit` — exit `1` because this Windows pnpm wrapper could not resolve `tsc` (`'tsc' is not recognized`), before type checking.
   - Direct installed workspace check, `apps/api/.\node_modules\.bin\tsc.CMD -p tsconfig.json --noEmit` from `apps/api` — exit `0`.
   - `git diff --check` on the four scoped files — exit `0`.

Full T093 was intentionally not rerun; the verification worker will perform that after the API change is available.
