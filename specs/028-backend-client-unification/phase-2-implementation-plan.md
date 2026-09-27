# Phase 2 implementation plan: foundational backend client

Approved design: one server-only factory in `apps/web/lib/server/backend-client.ts` owns authenticated backend transport. Its public `request<T>(path, schema, opts)` returns only validated success data, HTTP status/body failure, or a safe transport cause. Domain loaders and routes remain untouched in this slice.

## File responsibilities

- `apps/web/lib/server/backend-client.spec.ts`: public-interface tests using fake `fetch`, an injected token provider, controlled time, and Zod schemas. Restore global fetch, timers, and environment after each test. Mock only external NextAuth for the default provider.
- `apps/web/lib/server/backend-client.ts`: inline `TokenProvider`, `TransportResult<T>`, and `RequestOpts`; `createBackendClient` and `backendClient` exports. The factory resolves a base URL, obtains a token, builds no-store bearer requests, enforces attempt and total deadlines, retries eligible GETs, parses errors without losing status, and validates successful JSON. It never assigns domain outcome reasons.
- `specs/028-backend-client-unification/verification.md`: exact commands, exit codes, RED/GREEN evidence, and Phase 2 parity results.
- `specs/028-backend-client-unification/tasks.md`, `context/architecture.md`, `context/progress-checker.md`: mark only T005–T007 complete after verification and document the new boundary.

## Vertical TDD sequence

Each line is one RED test, failing run, minimal GREEN implementation, then passing run. Previously written assertions stay fixed. Run `& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/backend-client.spec.ts` after each GREEN.

1. Factory and injected token: `createBackendClient({ tokenProvider, baseUrl }).request('/api/example', z.object({ value: z.string() }))` returns typed validated data, sends `Authorization: Bearer <token>`, `Cache-Control: no-store`, and `cache: 'no-store'` to the slash-trimmed URL.
2. Default provider and URL order: default `backendClient` gets the NextAuth access token; per-factory `baseUrl` wins over `API_URL`, which wins over `NEXT_PUBLIC_API_URL`, then `http://localhost:3001`. Missing, empty, or whitespace token returns `missing_token` without `fetch`.
3. Response boundaries: JSON syntax failure returns `invalid_json`; schema rejection returns `invalid_payload`; non-2xx malformed error JSON preserves `kind: 'http'` and status without body; `responseMode: 'none'` on 2xx never reads the body and returns `undefined`.
4. Attempt timing: a signal-aware stalled fetch is aborted at 10 seconds and yields `timeout`. Network rejection yields `network`; neither exposes exception text in result or diagnostics.
5. GET retry cases: network/timeout and 502/503/504 retry at most three attempts with 100 ms then 200 ms backoff. 500, listed 4xx, and 429 without a valid `Retry-After` stop after one attempt.
6. `Retry-After`: delta seconds and HTTP dates delay the next GET; a delay beyond the remaining 31-second deadline returns the current 429 immediately. All attempts and waits fit the 31-second cap.
7. Mutation safety: POST, PUT, PATCH, and DELETE each send once for network, timeout, and retryable HTTP responses.
8. Refactor only while GREEN; confirm strict typing, five cause codes, and PII-safe diagnostics.

## Verification and closeout

Run the new spec, the three Phase 1 server specs, both cancellation route specs directly with `node --import tsx` (literal `[bookingId]` is not discovered by `tsx --test` on Windows), web lint, and web typecheck. Confirm no dependency, Prisma, endpoint, or feature-flag diff. Converge against Phase 2 requirements only; later T008–T025 are intentionally open. Run one independent review per task, covering both standards and spec axes, and resolve blocking findings before checking T005–T007.
