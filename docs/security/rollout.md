# Rollout, Rollback & Fail-Closed Startup Runbook and Verification Report

**Feature**: 023-security-systems  
**Task**: T047 [US5]  
**Status**: Verified & Rehearsed  
**Date**: 2026-09-13  
**Authority**: `AGENTS.md`, `specs/023-security-systems/tasks.md`, `docs/security/guardrail-inventory.md`

---

## 1. Executive Summary

This document establishes the verified operational procedures and regression guarantees for fail-closed startup, zero fail-open invariant enforcement, feature flag rollout/rollback cycles, and operational health probes. All guarantees are codified as automated executable tests in [`apps/agent/tests/security/test_rollout.py`](file:///c:/Booking%20Systems/apps/agent/tests/security/test_rollout.py).

---

## 2. Fail-Closed Startup Invariants

The agent service enforces strict fail-closed startup semantics to prevent running in an unverified or vulnerable configuration.

### 2.1 Guardrail Registry Initialization Contract
- **GuardrailGateway Validation**: Instantiating `GuardrailGateway` requires a non-null, valid `GuardrailRegistry` instance. Passing `None` or invalid configurations immediately raises `RegistryContractError`.
- **Compulsory Production Layers**: Calling `create_production_registry()` enforces that all compulsory security layers are registered. Disabling any compulsory layer (`input.length`, `input.pii`, `input.injection`, `input.topic`, `output.pii`, `tool.size_structure`, `tool.schema`, `tool.pii`, `tool.untrusted_content_injection`) raises `RegistryContractError`.
- **Config Type Safety**: Passing invalid non-iterable types for `disabled_keys` fails fast with `RegistryContractError`.

### 2.2 Regex Pattern Safety & Fail-Closed Layer Initialization
- **Syntax Error Fail-Fast**: Corrupted or malformed regex patterns supplied at initialization (e.g. `TopicBoundary(patterns=[...])`) raise `re.error` or `ValueError` at layer initialization time rather than during live traffic.
- **ReDoS Resistance**: Catastrophic backtracking patterns (e.g. `(a+)+$`) are identified via AST inspection during initialization and rejected with `ValueError`.
- **Zero Fallback Bypass**: Under no circumstance does an invalid, catastrophic, or unparseable regex rule fall back to a permissive pass-through. Any matching error or classifier disruption fails closed (`status == 'BLOCK'`).

### 2.3 Secret & HMAC Key Integrity
- **Mandatory HMAC Secrets**: `JWT_SECRET` and `CLAIM_TOKEN_SECRET` are required fields in `Settings`. If either secret is empty or missing at startup, Pydantic raises `ValidationError`, terminating process boot.
- **Unauthenticated Ingress**: Unauthenticated requests to `/chat/stream` without an `Authorization` header receive HTTP 401 (`Missing authorization header`).
- **Forged Signatures**: Requests signed with invalid or forged secrets fail verification and receive HTTP 401 (`Invalid token`).
- **Origin Fencing**: Disallowed origins receive HTTP 403 (`ORIGIN_NOT_ALLOWED`). Unauthenticated or forged requests never reach the LangGraph runner or downstream tool execution.

### 2.4 Zero Fail-Open Bypass Invariant
Under all boundary failure modes, the system deterministically fails closed:
- **Input Gateway**: Invalid `AdmissionContext`, missing layers, or catastrophic exceptions inside a layer's `check()` method yield `status == 'BLOCK'` with `response_key == GUARDRAIL_INPUT_INJECTION` and reason `"Guardrail classifier failed closed"`.
- **Tool Execution Gateway**: Calls with invalid `TurnCapabilities`, unauthorized tools not present in sealed capabilities, or exceptions during tool execution return `status == 'BLOCK'` with `response_key == GUARDRAIL_TOOL_SCHEMA`. The underlying tool function is never executed.
- **Tool Batching**: If any tool call in a proposed batch lacks sealed authority, the entire batch returns `status == 'BLOCK'` with zero executions.

---

## 3. Rollout & Rollback Rehearsal Matrix

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

## 4. Operational Health Probes

### 4.1 Lightweight Liveness Probe (`/health/live`)
- **Purpose**: High-frequency Kubernetes / orchestrator liveness checks.
- **Guarantees**:
  - Response: HTTP 200 `{"status": "ok"}`
  - Zero LLM model inference calls.
  - Zero guardrail classification or pipeline overhead.
  - Zero network I/O to NestJS API or Duffel.
  - Zero Redis commands or connection pooling wait.

### 4.2 Dependency Health Probe (`/health`)
- **Purpose**: Deep transport and subsystem dependency readiness checks.
- **Reporting Matrix**:
  - `dependencies.guardrails`: Always reports `{"status": "deterministic"}`.
  - `dependencies.redis`: Accurately reflects Redis ping connectivity (`ok` vs. `down`).
  - `dependencies.nestjsApi`: Accurately reflects NestJS API `/health` response (`ok` vs. `down`) and latency in milliseconds.
  - `status`: Overall status evaluates to `ok` when all dependencies respond, or `degraded` if either Redis or NestJS API is unreachable.

---

## 5. Emergency Rollback & Operator Runbook

In the event of an operational anomaly, security alert, or service degradation, operators must follow this step-by-step procedure to execute an immediate, safe rollback or fallback.

> [!IMPORTANT]
> **Configuration Lifecycle Constraints**:
> 1. **Python Agent Tier**: Pydantic `Settings` is a cached in-memory singleton (`get_settings()` in `apps/agent/src/agent/config.py`). Modifying environment variables (`.env` or shell environment) has no effect on running processes; an explicit service process restart (`systemctl restart flight-agent`, `uvicorn` restart, or container restart) is required to reload settings.
> 2. **Next.js Web Tier**: `NEXT_PUBLIC_` variables (`NEXT_PUBLIC_FEATURE_FLAG_CHAT_HANDOFF`, `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS`) are statically inlined and baked into client JavaScript bundles at `next build` time. Toggling web flags requires rebuilding and redeploying the web tier (`pnpm --filter @web/frontend build`).
> 3. **Containerized Deployments**: Under active incidents, never rebuild container images from source. Roll back immediately to previously pinned image digests or stable tags (e.g. via `kubectl rollout undo` or pinning to a known good image digest).

### 5.1 Emergency Feature Flag Rollback (Agent & Backend Service)
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

### 5.2 Emergency Web Tier Mitigation & Rebuild
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

### 5.3 Operator Health Verification Commands
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

### 5.4 Container Deployment Rollback (Kubernetes / Docker)
If binary or container image rollback is required:

```bash
# Kubernetes rollout rollback
kubectl rollout undo deployment/agent-service -n production
kubectl rollout status deployment/agent-service -n production

# Docker Compose rollback
docker compose stop agent
docker compose up -d --no-deps --build agent
```

---

## 6. Automated Verification Evidence

### Test Suite Execution
- **File**: `apps/agent/tests/security/test_rollout.py`
- **Mark**: `pytestmark = pytest.mark.security`
- **Execution Command**:
  ```powershell
  $env:UV_CACHE_DIR = "c:\Booking Systems\.t093-uv-cache"
  $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
  uv run --package agent pytest apps/agent/tests/security/test_rollout.py -v
  ```
- **Result**: 12 passed in 10.63s (Exit Code: 0)

### Tests Summary
1. `test_startup_fails_closed_on_missing_or_corrupted_registry`: **PASSED**
2. `test_startup_fails_closed_on_disabled_compulsory_layers`: **PASSED**
3. `test_corrupted_or_invalid_regex_rules_fail_closed_at_startup`: **PASSED**
4. `test_missing_or_forged_hmac_keys_fail_closed`: **PASSED**
5. `test_zero_fail_open_bypass_invariant_input_validation`: **PASSED**
6. `test_zero_fail_open_bypass_invariant_tool_execution`: **PASSED**
7. `test_zero_fail_open_bypass_invariant_tool_batch_and_result`: **PASSED**
8. `test_rollout_rollback_rehearsal_multi_agent_cycle`: **PASSED**
9. `test_rollout_rollback_rehearsal_handoff_cycle`: **PASSED**
10. `test_rollout_rollback_rehearsal_booking_readiness_cycle`: **PASSED**
11. `test_health_live_probe_guarantees`: **PASSED**
12. `test_health_probe_dependency_reporting_matrix`: **PASSED**

### Static Linting & Formatting Check
- **Command**:
  ```powershell
  uv run --package agent ruff check apps/agent/tests/security/test_rollout.py
  uv run --package agent ruff format --check apps/agent/tests/security/test_rollout.py
  ```
- **Result**: All checks passed! 1 file already formatted (Exit Code: 0)

