# Agent Gateway Capabilities Operational Runbook

This operational runbook governs the capability-local modular architecture, negative-privacy tool audit telemetry, HMAC selection attestation, and deprecation lifecycle for the Agent Gateway submodules implemented under `apps/api/src/agent-gateway/`.

The gateway provides privacy-minimized interfaces for the AI Python Agent (`apps/agent`), enforcing tenant isolation, cryptographically verifiable offer attestations, and zero PII persistence in audit telemetry.

---

## 1. Preflight Checks & Prerequisites

### 1.1 Capability Module Architecture
The monolithic `AgentGatewayService` and `AgentGatewayController` have been decommissioned and replaced by 4 isolated capability submodules composed by the umbrella `AgentGatewayModule`:
1. **`AttestedFlightSearchModule` (`AttestedFlightSearchController`)**:
   - `GET /api/agent-gateway/flights/search`: Legacy search projection.
   - `POST /api/agent-gateway/v2/flights/search`: V2 search with HMAC-SHA256 selection attestation.
2. **`AgentBookingReadinessModule` (`AgentBookingReadinessController`)**:
   - `POST /api/agent-gateway/bookings/readiness`: Pure advisory readiness projection with zero DB writes.
3. **`SafeBookingReadModule` (`SafeBookingReadController`)**:
   - `GET /api/agent-gateway/users/bookings/summaries`: Tier-1 high-level logistics with opaque `bkref_...` IDs.
   - `GET /api/agent-gateway/users/bookings/:bookingReference`: Tier-2 detailed flight rules and baggage.
   - `GET /api/agent-gateway/users/bookings`: Deprecated legacy route.
4. **`TravelerPreferencesModule` (`TravelerPreferencesController`)**:
   - `GET /api/agent-gateway/users/preferences`: Allowlisted user preferences without passport PII.

### 1.2 Supporting Modules & Chat Ownership
- **`AgentAuthModule` (`apps/api/src/agent-gateway/auth/`)**:
  - Standalone module exporting `AgentApiKeyGuard`, `ClaimTokenGuard`, and `ClaimTokenService`.
- **`AgentToolAuditModule` (`apps/api/src/agent-gateway/audit/`)**:
  - Exports `AgentToolAuditService` for negative-privacy telemetry.
- **Chat Persistence in `ChatModule` (`apps/api/src/chat/`)**:
  - `AgentChatController` and `AgentChatAccessService` own `/agent-gateway/chat/*` endpoints with direct `ChatService` injection and zero `AgentGatewayModule` dependency.

### 1.3 Preflight Test Suite Verification
Execute the capability unit and characterization test suites:

```powershell
Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --runInBand `
  src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts `
  src/agent-gateway/booking-readiness/agent-booking-readiness.service.spec.ts `
  src/agent-gateway/safe-booking-read/safe-booking-read.service.spec.ts `
  src/agent-gateway/traveler-preferences/traveler-preferences.service.spec.ts `
  src/agent-gateway/audit/agent-tool-audit.service.spec.ts

& '.\node_modules\.bin\jest.CMD' --config ./test/jest-e2e.json --runInBand `
  test/characterization/agent-gateway.characterization.spec.ts
Pop-Location
```

All capability suites must pass with 0 failures before deployment.

---

## 2. Mismatch Abort Conditions & Safeguards

### 2.1 HMAC Selection Attestation Verification
- `SelectionAttestationService` generates HMAC-SHA256 signatures binding `userId`, `chatSessionId`, `snapshotVersion`, `issuedAt`, `expiresAt`, and ordered offers.
- NestJS validates incoming attestations using constant-time equality check (`crypto.timingSafeEqual`).
- **Abort Trigger**: Any signature failure, expired attestation timestamp ($expiresAt < NOW()$), or mismatch in bound user/session IDs returns HTTP 401 `INVALID_ATTESTATION` and blocks handoff token creation.

### 2.2 Negative-Privacy Audit Telemetry Validation
- `AgentToolAuditService.logToolCall()` enforces negative privacy protection:
  - Allowed fields: `toolName`, `outcome` (`SUCCESS` | `FAILURE`), `durationMs`, `responseSizeBytes`, `occurredAt`, `errorCode`, `traceId`, `correlationId`.
  - Disallowed fields: Customer messages, passenger names, dates of birth, passport numbers, card details, PNRs, or supplier offer UUIDs.
- **Hard Abort Trigger**: If automated log monitors detect any customer PII or raw provider payloads in `audit_logs` entries where `action = 'AGENT_TOOL_CALL'`, halt gateway traffic immediately.

### 2.3 Safe Booking Reference Validation & Tenant Isolation
- Booking references MUST match regex `^bkref_[a-zA-Z0-9_-]+$`.
- Tenant Isolation: If a reference exists but belongs to a different user, the controller returns HTTP 404 (NOT 403) to eliminate enumeration vulnerabilities.

### 2.4 Tracking Deprecation of Legacy `/users/bookings`
- Legacy endpoint `GET /api/agent-gateway/users/bookings` is marked `@deprecated`.
- All Python agent tools have been cut over to Tier-1 (`/users/bookings/summaries`) and Tier-2 (`/users/bookings/:bookingReference`).
- The legacy endpoint emits metric `agent_gateway_legacy_requests_total`.
- **Abort Condition**: If `agent_gateway_legacy_requests_total` increases after agent container cutover, an unmigrated agent node is running; investigate caller versions.

---

## 3. Observability, Metrics & Alert Thresholds

### 3.1 Prometheus & Audit Metrics

| Metric Name | Type | Purpose |
|---|---|---|
| `agent_tool_calls_total` | Counter | Tool executions by `tool_name` and `outcome` |
| `agent_tool_duration_seconds` | Histogram | Execution latency of capability tools |
| `agent_attestation_verifications_total` | Counter | Attestation checks by outcome (`valid`, `expired`, `tampered`) |
| `agent_gateway_legacy_requests_total` | Counter | Invocations of deprecated `/users/bookings` |

### 3.2 Alert Threshold Table

| Alert | Condition | Severity | Immediate Action |
|---|---|---|---|
| AttestationTamperingAlert | `rate(agent_attestation_verifications_total{outcome="tampered"}[5m]) > 0` | P1 (Critical) | Investigate possible unauthorized token tampering or key desynchronization. |
| ToolAuditFailureAlert | `AgentToolAuditService` throws unhandled exception | P2 (High) | Audit failure must fail-open to not block tools, but must be alerted immediately. |
| LegacyRouteCallDetected | `rate(agent_gateway_legacy_requests_total[1h]) > 0` post-migration | P3 (Medium) | Identify caller IP/user-agent; verify all agent pods have been upgraded. |
| ToolLatencySpike | `agent_tool_duration_seconds{p95} > 1.0s` | P2 (High) | Check database connection pool and airport cache hit ratios. |

---

## 4. Observation Window Guidelines

### 4.1 Duration & Scope
- Maintain a **14-day continuous observation window** post-rollout.
- Monitor capability routing, attestation verification rate, and legacy route traffic drainage.

### 4.2 Daily Operator Verification Checklist
1. Verify `agent_gateway_legacy_requests_total`: Confirm daily request count remains at exactly 0.
2. Review tool execution latencies: Confirm `attested-flight-search` p95 $< 800ms$ and `safe-booking-read` p95 $< 100ms$.
3. Inspect `audit_logs`: Query recent `AGENT_TOOL_CALL` actions and confirm `metadata` contains only allowlisted performance telemetry.
4. Verify chat persistence decoupling: Confirm `apps/api/src/chat/agent-chat.controller.ts` processes turn persistence without accessing `AgentGatewayModule`.

---

## 5. Rollback Procedures & Exact Commit Boundaries

### 5.1 Exact Commit Boundaries
- **Shared Auth & Safe Audit Module (Slice 6A)**: Commit `f14a441` (`feat(agent-gateway): extract shared auth module and implement safe tool audit service (Slice 6A)`).
- **Capability Modules Extraction (Slice 6B)**: Commit `0752814` / `ae2d492` (`feat(agent-gateway): extract attested-flight-search and traveler-preferences capability modules`).
- **Chat Ownership Extraction to ChatModule (Slice 6C)**: Commit `3c82b22` / `aa92d60` (`refactor(agent-gateway): remove chat endpoints and ChatModule dependency from AgentGatewayModule`).
- **Decommission Monolithic Gateway & Pure Umbrella Composition (Slice 6D)**: Commit `8d6ee34` (`refactor(agent-gateway): delete broad AgentGatewayService and finalize module composition (Slice 6D)`).

### 5.2 Rollback Procedure
Because the capability decomposition preserves exact wire endpoints, status codes, and DTO contracts:
1. Revert application code to commit prior to `8d6ee34` if unexpected routing regressions occur.
2. Zero database migrations are involved in the gateway decomposition; rollback is 100% application container re-deployment.
3. Validate rollback deployment:
   ```powershell
   Push-Location apps/api
   & '.\node_modules\.bin\jest.CMD' --config ./test/jest-e2e.json --runInBand test/characterization/agent-gateway.characterization.spec.ts
   Pop-Location
   ```

---

## 6. Post-Rollout Cleanup Eligibility

### 6.1 Decommissioned Monolithic Components
The following files were permanently deleted in Slice 6D and must NOT be restored:
- `apps/api/src/agent-gateway/agent-gateway.service.ts`
- `apps/api/src/agent-gateway/agent-gateway.controller.ts`
- `apps/api/src/agent-gateway/agent-gateway.service.spec.ts`

### 6.2 Legacy Route Deletion Eligibility
The deprecated endpoint `GET /api/agent-gateway/users/bookings` in `SafeBookingReadController` is eligible for final deletion when:
1. The 14-day observation window demonstrates exactly 0 requests logged to `agent_gateway_legacy_requests_total`.
2. Python agent test suites confirm complete isolation to Tier-1 and Tier-2 booking tools.
3. Remove `@Get('users/bookings')` method from `SafeBookingReadController` and remove `UserBookingsDto` from exports.
