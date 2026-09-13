# Rollout, Rollback & Fail-Closed Startup Runbook and Verification Report

**Feature**: 023-security-systems  
**Task**: T047 [US5]  
**Status**: Verified & Rehearsed  
**Date**: 2026-09-13  
**Authority**: `AGENTS.md`, `specs/023-security-systems/tasks.md`, `docs/security/guardrail-inventory.md`

---

## 1. Executive Summary

This document establishes the verified operational procedures and regression guarantees for fail-closed startup, zero fail-open invariant enforcement, pre-flight verification checklists, canary rollout progression, secret key rotation rings, operational health probes, and emergency rollback procedures. All guarantees are codified as automated executable tests in [`apps/agent/tests/security/test_rollout.py`](file:///c:/Booking%20Systems/apps/agent/tests/security/test_rollout.py).

---

## 2. Pre-Flight Verification Checklist

Before promoting any build, container image, or configuration change across deployment environments (Staging -> Canary -> Production), release operators must verify that all four pre-flight quality gates pass unconditionally:

### 2.1 Corpus Evaluation Gates
- **Holdout Set Allocation**: $\ge 200$ malicious payloads and $\ge 500$ benign payloads strictly segregated from training/tuning sets (700 holdout records total: 100/250 input, 50/125 tool, 50/125 output).
- **Performance Targets**:
  - True Positive Rate (TPR) $\ge 95.0\%$ across all evaluation stages.
  - False Positive Rate (FPR) $\le 2.0\%$ across all evaluation stages.
- **Zero Critical False Negatives**: Critical injection signatures (jailbreaks, prompt hijacking, system prompt overrides) and sensitive PII disclosures (credit card numbers, passport numbers, API bearer tokens) must achieve zero false negatives ($FN = 0$).
- **Invariant Suite**: 100% pass rate ($25/25$, $0$ failures permitted) on `tests/security/corpus/invariant_manifest.jsonl` verifying cross-user isolation, quota limits, and payload bounds.

### 2.2 SAST Baseline & Exception Controls
- **Semgrep Security Scan**: Clean execution against `tests/security/sast/ruleset.yml` and `tests/security/sast/guardrails.yml` (version 1.88.0) with **zero** unbaselined `CRITICAL` or `HIGH` findings.
- **Fail-Closed Guardrail Rules**: Hard rules (`no-llm-in-guardrails`, `no-dynamic-imports-in-guardrails`, `no-unshielded-tool-execution`, `no-raw-payload-logging`, `safe-html-interpolation`) cannot be waived or baselined.
- **Exceptions Ledger**: All entries in `tests/security/exceptions.json` must be strictly bounded ($\le 30$ days lifetime, `expiresAt > CURRENT_DATE`). Any expired exception triggers an immediate fail-closed gate block.

### 2.3 Clean Software Supply Chain (SCA)
- **Python Dependencies (`pip-audit`)**: Zero known CVEs / vulnerabilities across all packages installed in the runtime environment, validated against PyPI Advisory Database with $< 24$h cache freshness.
- **Node Dependencies (`pnpm audit`)**: Zero uncataloged vulnerabilities across workspace root and all apps.
- **Cataloged Exceptions**: Cataloged GHSAs in `pnpm.auditConfig.ignoreGhas` must match active entries in `docs/security/dependency-advisories.md` with active compensating controls and unexpired review windows.
- **Secret Scanning (`gitleaks`)**: Gitleaks v8.18.4 baseline scan confirms zero leaked API keys, tokens, or private credentials in repository history.

### 2.4 Test Suite Green Status
- **Security Test Suites**: 100% pass rate across all security-related suites:
  - `apps/agent/tests/security/` (characterization, registry, input, tool, output, performance, rollout)
  - `tests/security/dast/` (ownership, adversarial replay, HTTP security)
  - `apps/web/tests/security-boundaries.spec.ts` (browser boundary tests)
- **Zero Permitted Failures**: No test skips, failures, or unhandled errors are permitted in gating pipelines.

---

## 3. Fail-Closed Startup Invariants

The agent service enforces strict fail-closed startup semantics to prevent running in an unverified or vulnerable configuration.

### 3.1 Guardrail Registry Initialization Contract
- **GuardrailGateway Validation**: Instantiating `GuardrailGateway` requires a non-null, valid `GuardrailRegistry` instance. Passing `None` or invalid configurations immediately raises `RegistryContractError`.
- **Compulsory Production Layers**: Calling `create_production_registry()` enforces that all compulsory security layers are registered. Disabling any compulsory layer (`input.length`, `input.pii`, `input.injection`, `input.topic`, `output.pii`, `tool.size_structure`, `tool.schema`, `tool.pii`, `tool.untrusted_content_injection`) raises `RegistryContractError`.
- **Config Type Safety**: Passing invalid non-iterable types for `disabled_keys` fails fast with `RegistryContractError`.

### 3.2 Regex Pattern Safety & Fail-Closed Layer Initialization
- **Syntax Error Fail-Fast**: Corrupted or malformed regex patterns supplied at initialization (e.g. `TopicBoundary(patterns=[...])`) raise `re.error` or `ValueError` at layer initialization time rather than during live traffic.
- **ReDoS Resistance**: Catastrophic backtracking patterns (e.g. `(a+)+$`) are identified via AST inspection during initialization and rejected with `ValueError`.
- **Zero Fallback Bypass**: Under no circumstance does an invalid, catastrophic, or unparseable regex rule fall back to a permissive pass-through. Any matching error or classifier disruption fails closed (`status == 'BLOCK'`).

### 3.3 Secret & HMAC Key Integrity
- **Mandatory HMAC Secrets**: `JWT_SECRET`, `CLAIM_TOKEN_SECRET`, and `AGENT_SERVICE_API_KEY` are required fields in `Settings`. If any secret is empty or missing at startup, Pydantic raises `ValidationError`, terminating process boot.
- **Unauthenticated Ingress**: Unauthenticated requests to `/chat/stream` without an `Authorization` header receive HTTP 401 (`Missing authorization header`).
- **Forged Signatures**: Requests signed with invalid or forged secrets fail verification and receive HTTP 401 (`Invalid token`).
- **Origin Fencing**: Disallowed origins receive HTTP 403 (`ORIGIN_NOT_ALLOWED`). Unauthenticated or forged requests never reach the LangGraph runner or downstream tool execution.

### 3.4 Zero Fail-Open Bypass Invariant
Under all boundary failure modes, the system deterministically fails closed:
- **Input Gateway**: Invalid `AdmissionContext`, missing layers, or catastrophic exceptions inside a layer's `check()` method yield `status == 'BLOCK'` with `response_key == GUARDRAIL_INPUT_INJECTION` and reason `"Guardrail classifier failed closed"`.
- **Tool Execution Gateway**: Calls with invalid `TurnCapabilities`, unauthorized tools not present in sealed capabilities, or exceptions during tool execution return `status == 'BLOCK'` with `response_key == GUARDRAIL_TOOL_SCHEMA`. The underlying tool function is never executed.
- **Tool Batching**: If any tool call in a proposed batch lacks sealed authority, the entire batch returns `status == 'BLOCK'` with zero executions.
- **Ingress Gateway Status**: If `guardrail_gateway` is uninitialized or degraded (`is_healthy() == False`), `/chat/stream` immediately rejects incoming requests with HTTP 503 (`GUARDRAIL_GATEWAY_UNAVAILABLE`).

---

## 4. Rollout & Rollback Rehearsal Matrix

The platform supports safe, hitless rollout and emergency rollback across key feature switches.

| Feature Flag | Role & Domain | Enabled Behavior | Rollback (Disabled) Behavior | Invariant Guarantees |
|---|---|---|---|---|
| `FEATURE_FLAG_CHAT_MULTI_AGENT` | Dynamic multi-agent routing & checkout intent gating | Classifies user intent (`SEARCH`, `BOOKING_INQUIRY`, `CHECKOUT`), routes between agents, and seals tool capabilities dynamically. | Pins routing to `travel` assistant with provenance `single_agent`. Capabilities are sealed to travel tools only. | `signal_checkout_intent` is excluded from sealed capabilities upon rollback. Zero checkout authority leaked. |
| `FEATURE_FLAG_CHAT_HANDOFF_ISSUE` (paired with `NEXT_PUBLIC_FEATURE_FLAG_CHAT_HANDOFF`) | Signed handoff token creation for checkout redirection | Generates signed handoff token from attested search snapshot via NestJS API. | `create_handoff_token` immediately returns clean error `{"action": {"error": "Chat handoff issuance is disabled."}}`. | Zero NestJS API calls on rollback. No sensitive search snapshot or passenger data leaked. |
| `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS` (paired with `FEATURE_FLAG_BOOKING_READINESS`) | Passenger document and passport validation before checkout | Validates passenger completeness, nationality, and passport expiry against Duffel itinerary rules. | Reverts to fallback flow without executing unauthorized mutations or leaking unmasked passenger PII. | Passenger details and PII remain masked; errors yield generic safe notices. |

### Rehearsal Cycle Verification
Each feature flag was verified through a complete 3-phase rehearsal cycle:
1. **Enabled (Rollout)**: Feature operational, authorized actions succeed, capabilities sealed correctly.
2. **Disabled (Rollback)**: Feature suppressed, safe fallback triggered, unauthorized tool execution denied, zero side-effects.
3. **Re-enabled (Re-rollout)**: Feature restored cleanly without memory leaks or stale state corruption.

---

## 5. Canary Rollout & Traffic Shifting Procedures

Production rollouts follow a staged canary progression with strict automated telemetry gates at each phase.

### 5.1 Progression Stages

| Stage | Traffic % | Soak Window | Target Audience | Primary Telemetry Gates |
|---|---|---|---|---|
| **Stage 0** | **1%** | 30 minutes | Internal staff, automated synthetic monitors | Zero startup crashes; `/health` returns `status: "ok"`; zero false positives on synthetic flows. |
| **Stage 1** | **5%** | 2 hours | Small subset of public sessions | Turn compute latency $p95 \le 10\text{ms}$; HTTP $5xx$ error rate $< 0.05\%$; Redis lease contention $< 1\%$. |
| **Stage 2** | **25%** | 4 hours | Broad production sample | Token holdback buffering latency $p95 \le 25\text{ms}$; memory drift $\Delta \le 1\text{MiB}$; zero unsealed tool attempts. |
| **Stage 3** | **100%** | Continuous | Full production load | All system metrics within SLA; zero security violations. |

### 5.2 Telemetry Gates & Automatic Rollback Thresholds
Promotion to the next stage requires meeting **all** of the following telemetry criteria throughout the entire soak window:
- **Error Budget**: HTTP $5xx$ responses $< 0.1\%$ of total chat requests.
- **Latency Ceiling**: Turn compute latency $p95 \le 10\text{ms}$ and $p99 \le 20\text{ms}$.
- **Guardrail Anomaly Detection**: Guardrail block rate must remain within $\pm 5\%$ of the historical baseline (sudden spike indicates regex/boundary regression; drop indicates potential evasion).
- **Lease Contention**: Redis distributed lock acquisition failure rate $< 0.01\%$.
- **Zero Security Crashes**: Zero unhandled exceptions in `GuardrailGateway` or `OutputGuardrailPipeline`.

If any telemetry gate is breached, operators must immediately pause traffic shifting and run the traffic drain commands below to return traffic to the previous stable revision.

### 5.3 Traffic Shift & Drain Commands
Traffic allocation is controlled at the ingress load balancer or reverse proxy:

```powershell
# Kubernetes / Ingress traffic shifting (example via ingress canary annotation):
kubectl set env deployment/flight-agent-canary CANARY_WEIGHT="5" -n flight-production

# Emergency traffic drain (divert 100% traffic immediately to stable pool):
kubectl annotate ingress/flight-agent-ingress nginx.ingress.kubernetes.io/canary-weight="0" --overwrite -n flight-production
kubectl rollout status deployment/flight-agent -n flight-production
```

---

## 6. Secret & HMAC Key Rotation Procedures

The platform utilizes multi-key secret rings for zero-downtime key rotation across authentication (`JWT_SECRET`) and agent-backend claim tokens (`CLAIM_TOKEN_SECRET`).

### 6.1 Multi-Key Secret Rings
- **`jwt_secret_ring`**: Composed of `[JWT_SECRET_CURRENT, JWT_SECRET, JWT_SECRET_PREVIOUS, JWT_SECRET_V2, JWT_SECRET_V1]`.
  - Ingress verifies incoming Bearer tokens by testing candidate secrets in order until a signature verifies or the ring is exhausted.
- **`claim_token_secret_ring`**: Composed of `[CLAIM_TOKEN_SECRET_CURRENT, CLAIM_TOKEN_SECRET, CLAIM_TOKEN_SECRET_PREVIOUS, CLAIM_TOKEN_SECRET_V2, CLAIM_TOKEN_SECRET_V1]`.
  - Backend verifies `X-User-Claim` HMAC signatures across all active ring secrets.
- **`primary_claim_token_secret`**: Signing operations always use `CLAIM_TOKEN_SECRET_CURRENT` (or `CLAIM_TOKEN_SECRET` fallback).

### 6.2 Phased Zero-Downtime Rotation Lifecycle

Key rotation follows a 3-step lifecycle:

```
[Phase 1: Introduce New Key]
  - Add new secret as JWT_SECRET_CURRENT / CLAIM_TOKEN_SECRET_CURRENT.
  - Retain current secret as JWT_SECRET / CLAIM_TOKEN_SECRET.
  - Deploy agent and backend.
  - Outbound tokens are signed with the new primary secret.
  - Inbound validation succeeds for both existing (active) and new (current) tokens.

[Phase 2: Drain Window (2x Token TTL)]
  - Wait 2x maximum token expiration time (CLAIM_TOKEN_TTL_SECONDS = 300s -> 600s wait).
  - All clients and in-flight sessions exchange old tokens for new tokens.
  - Monitor logs for any signature verification failures.

[Phase 3: Expire & Demote Old Key]
  - Promote new key to primary (JWT_SECRET = new_secret).
  - Demote old key to JWT_SECRET_PREVIOUS (retained for grace period) or remove it.
  - Deprecate old secret entirely once grace period expires.
```

### 6.3 Zero-Downtime Restart Commands
Because `Settings` is cached as an in-memory singleton, rotating secrets requires a graceful rolling restart of processes:

```powershell
# Kubernetes: Rolling restart ensures zero downtime (one pod at a time):
kubectl rollout restart deployment/flight-agent -n flight-production
kubectl rollout status deployment/flight-agent -n flight-production

# Systemd / Host: Zero-downtime reload via SIGHUP (or restart worker processes):
sudo systemctl reload flight-agent || sudo systemctl restart flight-agent
```

---

## 7. Operational Health Probes

The service implements multi-tier health probes providing distinct guarantees for orchestrators and dependency monitors.

### 7.1 Lightweight Liveness Probe (`/health/live`)
- **Purpose**: High-frequency Kubernetes / orchestrator liveness checks (every 5–10 seconds).
- **Endpoint**: `GET /health/live`
- **Guarantees**:
  - Response: HTTP 200 `{"status": "ok"}`
  - Latency: $< 10\text{ms}$ deterministic response time.
  - Zero LLM model inference calls.
  - Zero guardrail classification or pipeline overhead.
  - Zero network I/O to NestJS API or Duffel.
  - Zero Redis commands or connection pooling wait.

### 7.2 Deep Dependency Readiness Probe (`/health`)
- **Purpose**: Deep transport, subsystem readiness, and fail-closed state verification.
- **Endpoint**: `GET /health`
- **Reporting Matrix**:
  - `dependencies.guardrails`: Reports `{"status": "deterministic"}` when `guardrail_gateway` is initialized and healthy (`is_healthy() == True`) AND all mandatory secrets (`AGENT_SERVICE_API_KEY`, `JWT_SECRET`, `CLAIM_TOKEN_SECRET`) are populated.
  - `dependencies.redis`: Accurately reflects Redis ping connectivity (`ok` vs. `down`).
  - `dependencies.nestjsApi`: Accurately reflects NestJS API `/health` response (`ok` vs. `down`) and latency in milliseconds.
  - `status`: Evaluates to `ok` when all dependencies respond, or `degraded` if any dependency is down.
- **Fail-Closed Status Degradation**:
  - If `app.state.guardrail_gateway` is `None` or reports `is_healthy() == False`, `guardrails` reports `{"status": "down"}` and overall status is degraded.
  - If any mandatory secret (`AGENT_SERVICE_API_KEY`, `JWT_SECRET`, `CLAIM_TOKEN_SECRET`) is empty or missing, `guardrails` reports `{"status": "down"}` and overall status is degraded.

---

## 8. Emergency Rollback & Operator Runbook

In the event of an operational anomaly, security alert, or service degradation, operators must follow this step-by-step procedure to execute an immediate, safe rollback or fallback.

> [!IMPORTANT]
> **Configuration Lifecycle Constraints**:
> 1. **Python Agent Tier**: Pydantic `Settings` is a cached in-memory singleton (`get_settings()` in `apps/agent/src/agent/config.py`). Modifying environment variables (`.env` or shell environment) has no effect on running processes; an explicit service process restart (`systemctl restart flight-agent`, `uvicorn` restart, or container restart) is required to reload settings.
> 2. **Next.js Web Tier**: `NEXT_PUBLIC_` variables (`NEXT_PUBLIC_FEATURE_FLAG_CHAT_HANDOFF`, `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS`) are statically inlined and baked into client JavaScript bundles at `next build` time. Toggling web flags requires rebuilding and redeploying the web tier (`pnpm --filter @web/frontend build`).
> 3. **Containerized Deployments**: Under active incidents, never rebuild container images from source. Roll back immediately to previously pinned image digests or stable tags (e.g. via `kubectl rollout undo` or pinning to a known good image digest).

### 8.1 Emergency Feature Flag Rollback (Agent & Backend Service)
To suppress active agent capabilities (e.g., multi-agent delegation, handoff token issuance, or booking readiness inspection):

#### A. Host / Systemd Deployment
Update configuration in `/etc/flight-system/agent.env` or the deployment environment:
```bash
# Set flags to fail-closed defaults
FEATURE_FLAG_CHAT_HANDOFF_ISSUE=false
FEATURE_FLAG_CHAT_MULTI_AGENT=false
FEATURE_FLAG_BOOKING_READINESS=false
```
Apply changes by restarting the service process (mandatory due to singleton caching):
```bash
# Restart systemd agent service
sudo systemctl restart flight-agent

# Or restart local uvicorn process
pkill -f "uvicorn agent.main:app" && uv run uvicorn agent.main:app --port 3002 --app-dir apps/agent/src
```

#### B. Containerized Deployment (Kubernetes / Docker Compose)
Roll back to a known-stable image digest rather than rebuilding from source:
```bash
# Kubernetes: Roll back to previous pinned deployment revision
kubectl rollout undo deployment/flight-agent -n flight-production

# Docker Compose: Roll back to pinned image digest and recreate container
docker compose -f docker-compose.prod.yml down agent
docker compose -f docker-compose.prod.yml up -d agent
```

*Guarantees*: All in-flight or subsequent requests fail closed or route cleanly to the single travel agent. `signal_checkout_intent` is completely unsealed from tool capabilities; zero checkout authority is exposed.

### 8.2 Traffic Drain & Session Namespace Purge
During an emergency rollback or suspected credential compromise, operators must drain traffic and purge ephemeral session locks:

```powershell
# 1. Drain in-flight streaming turns cleanly
# Verified: ChatTurnRunner terminates active generators cleanly on aclose() without leaving orphan Redis locks.

# 2. Purge active Redis distributed session locks (PowerShell / Redis CLI):
redis-cli --scan --pattern "chat:session-lock:*" | ForEach-Object { redis-cli del $_ }

# 3. Purge session memory namespaces if state contamination is suspected:
redis-cli --scan --pattern "chat:session:*" | ForEach-Object { redis-cli del $_ }
redis-cli --scan --pattern "chat:budget:*" | ForEach-Object { redis-cli del $_ }
```

### 8.3 Emergency Web Tier Mitigation & Rebuild
When disabling client-facing features:

```powershell
# 1. Update web tier environment variables
$env:NEXT_PUBLIC_FEATURE_FLAG_CHAT_HANDOFF = "false"
$env:NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS = "false"

# 2. Rebuild and restart web tier (mandatory because NEXT_PUBLIC_* are inlined at build time)
pnpm --filter @web/frontend build
# Restart web service or container
pm2 restart flight-web # or docker compose restart web
```

If the Python agent service is unreachable or compromised, immediately isolate the frontend chat interface:
```http
HTTP/1.1 503 Service Unavailable
Retry-After: 300
Content-Type: application/json

{"error": "Assistant is temporarily undergoing scheduled maintenance. Please use direct booking search."}
```

*Guarantees*: Frontend stops polling and SSE streaming; users are guided to direct search with zero leaked context or credentials.

### 8.4 Operator Health Verification Commands
After applying rollback flags or restarting services, operators must execute the following verification steps:

```powershell
# 1. Verify lightweight orchestrator liveness (must return HTTP 200 within < 10 ms)
Invoke-RestMethod -Uri "http://127.0.0.1:3002/health/live" -Method Get

# 2. Verify deep dependency readiness and deterministic guardrails status
Invoke-RestMethod -Uri "http://127.0.0.1:3002/health" -Method Get
# Expected response:
# {
#   "status": "ok",
#   "dependencies": {
#     "guardrails": {"status": "deterministic"},
#     "redis": {"status": "ok"},
#     "nestjsApi": {"status": "ok", "latencyMs": ...}
#   }
# }

# 3. Run automated rollout verification suite locally or on staging
$env:UV_CACHE_DIR = "c:\Booking Systems\.t093-uv-cache"
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests/security/test_rollout.py -v
```

### 8.5 Post-Mortem Incident Triage
Following an emergency rollback, security and operations teams must conduct an immediate post-mortem:
1. **Audit Log Inspection**: Collect payload-free structured logs using search filters for `guardrail_input_blocked`, `guardrail_tool_blocked`, `output_guardrail_blocked`, and `GUARDRAIL_GATEWAY_UNAVAILABLE`.
2. **PII / Token Disclosure Verification**: Confirm zero raw prompts, customer names, passport numbers, credit card numbers, or HMAC secrets are present in application log traces or telemetry dumps.
3. **Trace Correlation**: Trace failing correlation and session IDs through NestJS API and Duffel partner logs to identify triggering input patterns or upstream failure causes.
4. **Exceptions Ledger Review**: If an emergency exception was granted during the incident, verify it is recorded in `tests/security/exceptions.json` with an expiration date $\le 30$ days.

---

## 9. Automated Verification Evidence

### Test Suite Execution
- **File**: `apps/agent/tests/security/test_rollout.py`
- **Mark**: `pytestmark = pytest.mark.security`
- **Execution Command**:
  ```powershell
  $env:UV_CACHE_DIR = "c:\Booking Systems\.t093-uv-cache"
  $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
  uv run --package agent pytest apps/agent/tests/security/test_rollout.py -v
  ```
- **Result**: 15 passed in 6.42s (Exit Code: 0)

### Tests Summary (15/15 Passed)
1. `test_startup_fails_closed_on_missing_or_corrupted_registry`: **PASSED**
2. `test_startup_fails_closed_on_disabled_compulsory_layers`: **PASSED**
3. `test_corrupted_or_invalid_regex_rules_fail_closed_at_startup`: **PASSED**
4. `test_missing_or_forged_hmac_keys_fail_closed`: **PASSED**
5. `test_chat_stream_rejected_when_guardrail_gateway_uninitialized_or_degraded`: **PASSED**
6. `test_zero_fail_open_bypass_invariant_input_validation`: **PASSED**
7. `test_zero_fail_open_bypass_invariant_tool_execution`: **PASSED**
8. `test_zero_fail_open_bypass_invariant_tool_batch_and_result`: **PASSED**
9. `test_rollout_rollback_rehearsal_multi_agent_cycle`: **PASSED**
10. `test_rollout_rollback_rehearsal_handoff_cycle`: **PASSED**
11. `test_rollout_rollback_rehearsal_booking_readiness_cycle`: **PASSED**
12. `test_emergency_rollback_mid_stream_terminates_cleanly_and_purges_locks`: **PASSED**
13. `test_health_live_probe_guarantees`: **PASSED**
14. `test_health_probe_dependency_reporting_matrix`: **PASSED**
15. `test_health_probe_reports_down_when_guardrails_or_keys_missing`: **PASSED**

### Static Linting & Formatting Check
- **Commands**:
  ```powershell
  uv run --package agent ruff check apps/agent/tests/security/test_rollout.py apps/agent/src/agent/main.py apps/agent/src/agent/guardrails/gateway.py apps/agent/src/agent/streaming/sse.py
  uv run --package agent ruff format --check apps/agent/tests/security/test_rollout.py apps/agent/src/agent/main.py apps/agent/src/agent/guardrails/gateway.py apps/agent/src/agent/streaming/sse.py
  ```
- **Result**: All checks passed! 4 files clean and formatted (Exit Code: 0)
