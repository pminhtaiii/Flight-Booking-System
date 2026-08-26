# Web Server Seams Operational Runbook

This operational runbook governs the production runtime, network configuration, client credential isolation, and caching guarantees for the Web Server Seams implemented under `apps/web/lib/server/` and same-origin Route Handlers under `apps/web/app/api/booking-management/`.

The server seams establish a strict boundary between browser client bundles and backend microservices, enforcing the **Zero-Client-Credential Invariant** and **Decision 6 Exception**.

---

## 1. Preflight Checks & Prerequisites

### 1.1 Architecture & Boundaries
- **Server Domain Modules (`apps/web/lib/server/`)**:
  - `flight-search.ts`: Enforces `import 'server-only'`. Normalizes search requests and results into shared `FlightSearchOutcome`.
  - `booking-management.ts`: Enforces `import 'server-only'`. Normalizes queries and commands into shared `BookingManagementOutcome`.
- **Thin Same-Origin Route Handlers (`apps/web/app/api/booking-management/`)**:
  - Exposes 7 thin route handlers for client polling and transactional commands.
  - Strictly delegates to `lib/server/booking-management.ts`.

### 1.2 Private `API_URL` Network Topology & Configuration
- **Server-Side Resolution**: Server modules resolve backend base URL in priority order:
  ```typescript
  const configuredUrl = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  ```
- **Private Network Invariant**: In production environments, `API_URL` MUST point to the internal VPC/cluster service endpoint (e.g. `http://api.internal:3001` or Kubernetes service `http://api-service.default.svc.cluster.local:3001`). It must NOT route through the public internet.
- **Client Shielding**: `API_URL` is never prefixed with `NEXT_PUBLIC_`, ensuring it is excluded from browser bundles.

### 1.3 Preflight Characterization & Test Verification
Execute Playwright characterization and static baseline metric suites:

```powershell
Push-Location apps/web
pnpm exec playwright test tests/characterization/booking-seam.characterization.spec.ts tests/characterization/search-seam.characterization.spec.ts --reporter=line
if ($LASTEXITCODE -ne 0) { throw 'Web server seam characterization tests failed.' }
Pop-Location
```

---

## 2. Mismatch Abort Conditions & Safeguards

### 2.1 Same-Origin Route Handler Caching Headers
Every route handler in `apps/web/app/api/booking-management/` MUST include:
```typescript
export const dynamic = 'force-dynamic';

// Response headers:
headers: {
  'Cache-Control': 'private, no-store'
}
```

**Abort Trigger**: If any response from `/api/booking-management/*` returns public caching headers (`public`, `s-maxage`, `stale-while-revalidate`), immediately halt traffic. Public caching could leak sensitive traveler itinerary or refund details through shared CDN caches.

### 2.2 Server-Side Timeout & Retry Policies
Server domain modules enforce distinct policies for reads versus mutations:
- **Bounded Request Timeout**: All requests enforce `REQUEST_TIMEOUT_MS = 10_000` (10 seconds) using `AbortSignal.timeout()`.
- **Read Operations (GET)**:
  - `MAX_READ_ATTEMPTS = 3` with exponential backoff (`RETRY_BASE_DELAY_MS = 100ms`).
  - Only retryable network errors or HTTP 502/503/504 trigger retries.
- **Mutation Operations (POST)**:
  - `MAX_MUTATION_ATTEMPTS = 1` (Zero retries).
  - Mutations (cancel booking, request quote, acknowledge/accept disruption) fail fast immediately upon error to prevent unintended duplicate supplier mutations.

### 2.3 Client Token Static Audit Commands
The repository strictly prohibits passing JWTs or backend URLs to Client Components.
Run the static audit command before promoting any web release:

```powershell
Push-Location apps/web
# Scan all booking pages and components for prohibited tokens
$violations = Get-ChildItem -Path ./app/bookings, ./components/bookings -Recurse -Include *.ts, *.tsx | `
  Select-String -Pattern "useSession|accessToken|NEXT_PUBLIC_API_URL"

if ($violations.Count -gt 0) {
  $violations | ForEach-Object { Write-Error "Token leak in $($_.Path):$($_.LineNumber)" }
  throw "Zero-Client-Credential invariant violated! Aborting deployment."
}
Pop-Location
```

The count of violations MUST be exactly `0`.

---

## 3. Observability, Metrics & Alert Thresholds

### 3.1 Currently Deployed Observability Channels
`apps/web` does not currently instantiate a native Prometheus client or expose a `/metrics` scrape endpoint. Production observability relies on the following active operational channels:

1. **Edge Ingress & Reverse Proxy Access Logs (NGINX / Vercel / Cloudflare)**:
   - Tracks HTTP request volume and status codes (`200`, `401`, `403`, `404`, `409`, `500`, `503`) for all calls targeting `/api/booking-management/*`.
   - Inspects response headers to verify `Cache-Control: private, no-store` is consistently enforced.
2. **Server-Side Next.js Runtime Logs**:
   - Server domain modules (`apps/web/lib/server/`) emit structured console errors upon upstream network or HTTP errors, tagging failure reasons (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `STALE_REVISION`, `INVALID_COMMAND`, `UPSTREAM_UNAVAILABLE`).
3. **CI Static Contract & Audit Gates**:
   - Pre-merge static analysis (`tests/ci/ci-workflow.contract.test.mjs` and Section 2.3 PowerShell token audit) verifies zero occurrences of `useSession`, `accessToken`, or `NEXT_PUBLIC_API_URL` in client components.
4. **Upstream NestJS Backend Observability**:
   - Upstream API latency, database transactions, and error rates are monitored directly at the destination NestJS API (`apps/api`), where native metrics and health checks are deployed.

### 3.2 Proposed / Future Application Metrics (Unimplemented in apps/web)
The following Prometheus metrics represent planned future instrumentation for an OpenTelemetry / Prometheus collector sidecar and are **not currently emitted by `apps/web`**:

| Proposed Metric Name | Type | Proposed Purpose | Status |
|---|---|---|---|
| `web_route_handler_requests_total` | Counter | Requests to `/api/booking-management/*` by route and HTTP status | *Proposed (Future)* |
| `web_server_seam_upstream_duration_seconds` | Histogram | Latency of server-to-server calls to NestJS API | *Proposed (Future)* |
| `web_server_seam_upstream_errors_total` | Counter | Count of upstream HTTP 5xx errors from Next.js server runtime | *Proposed (Future)* |
| `web_client_audit_failures_total` | Counter | Static characterization assertion failures in CI | *Proposed (Future)* |

### 3.3 Active Alert Threshold Table

| Alert / Signal | Active Detection Mechanism | Severity | Immediate Response |
|---|---|---|---|
| UpstreamUnavailableSpike | Ingress 503/504 error rate $> 5\%$ for 5m on `/api/booking-management/*` | P1 (Critical) | Check NestJS API container health, pod resources, and internal DNS resolution. |
| CacheHeaderViolation | Edge log shows `/api/booking-management/*` response without `private, no-store` | P0 (Blocker) | Route handler misconfiguration; purge CDN cache and redeploy route handlers. |
| ClientTokenExposureAlert | Static audit fails during CI pre-merge gate (`accessToken` in client code) | P0 (Blocker) | CI failure blocks merge. Remove credentials from component props. |
| UpstreamLatencyDrift | Ingress upstream response time p95 $> 5.0s$ on `/api/booking-management/*` | P2 (High) | Check Duffel API latency and PostgreSQL query plans in NestJS backend. |

---

## 4. Observation Window Guidelines

### 4.1 Duration & Traffic Coverage
- Maintain a **14-day continuous observation window** post-rollout.
- Monitor across full user journeys: Search $\rightarrow$ Booking List $\rightarrow$ Booking Detail $\rightarrow$ Cancellation Quote $\rightarrow$ Cancellation Execution.

### 4.2 Daily Operator Verification Checklist
1. Review Route Handler status codes: Verify 401s occur only for genuinely unauthenticated sessions.
2. Confirm CDN cache hit ratio for `/api/booking-management/*` remains exactly `0%` (all requests must hit origin).
3. Inspect network payloads in browser DevTools during test runs: Confirm zero Bearer tokens in client-to-Next.js HTTP requests.
4. Verify graceful error displays: When backend API is unreachable, verify UI renders friendly alert: *"Booking service is temporarily unavailable. Please try again."*

---

## 5. Rollback Procedures & Exact Commit Boundaries

### 5.1 Exact Commit Boundaries
- **Flight Search Server Seam**: Commit `797c13b` (`feat(web): implement flight search server seam and actions`).
- **Booking Management Server Seam & Client Token Removal**: Commit `543bc6f` (`feat(web): implement booking management server seams and remove client tokens (Slice 5C)`).

### 5.2 Rollback Procedure
Because the server seams interact with standard, backwards-compatible NestJS endpoints:
1. Re-deploy the Next.js frontend container from the commit immediately prior to `543bc6f`.
2. No database migrations, Redis flushes, or NestJS API rollbacks are required.
3. Validate rollback deployment:
   ```powershell
   Push-Location apps/web
   pnpm exec playwright test tests/bookings.spec.ts
   Pop-Location
   ```

---

## 6. Post-Rollout Cleanup Eligibility

### 6.1 Decommissioned Patterns
The following legacy patterns are permanently decommissioned and forbidden:
- Calling `useSession()` inside Client Components to retrieve `session.accessToken`.
- Passing `token` or `accessToken` as React component props.
- Fetching NestJS API endpoints directly from the browser using `fetch(`${process.env.NEXT_PUBLIC_API_URL}/...`)`.

### 6.2 Cleanup Verification
- Verify that `apps/web/lib/server/flight-search.ts` and `apps/web/lib/server/booking-management.ts` retain `import 'server-only'` at Line 1.
- Confirm browser production bundles generated by `pnpm build` contain zero occurrences of the internal API URL.
