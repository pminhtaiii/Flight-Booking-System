# Chat Turn Runner Operational Runbook

This operational runbook governs the execution lifecycle, concurrency control, causal failure cleanup, and graceful shutdown of `ChatTurnRunner` implemented under `apps/agent/src/agent/chat_turn/runner.py`.

The runner decouples agent execution from HTTP streaming transport, guaranteeing monotonic fencing tokens (`X-Fencing-Token`), deterministic cleanup order upon failure or client disconnect, and shielded turn persistence.

---

## 1. Preflight Checks & Prerequisites

### 1.1 Architecture & Role
- `ChatTurnRunner`: Pure async generator `run(command: ChatTurnCommand) -> AsyncIterator[ChatTurnEvent]`.
- Enforces strict Pydantic v2 `ConfigDict(extra="forbid")` on all 8 wire event payloads (`TokenPayload`, `ToolCallPayload`, `ToolResultPayload`, `FlightResultsPayload`, `ActionHandoffPayload`, `ActionRequiredPayload`, `DonePayload`, `ErrorPayload`).
- Integrates with `MessageQueueManager` for session lease acquisition and Redis-backed session locks.

### 1.2 Required Configuration & Timeouts

| Parameter | Configuration Key / Default | Operational Purpose |
|---|---|---|
| Session Lock Lease TTL | `SESSION_LOCK_TTL_MS = 30000` (30s) | Redis session lock duration |
| Session Lock Refresh | `SESSION_LOCK_REFRESH_INTERVAL_SECONDS = 10` | Heartbeat refresh interval for active turn |
| Lifespan Shutdown Limit | `SHUTDOWN_TIMEOUT_SECONDS = 5.0` | Maximum wait time during pod termination |
| Queue Maximum Depth | `QUEUE_MAX_DEPTH = 5` | Maximum queued messages per user session |
| Service Authentication | `AGENT_SERVICE_API_KEY` | Bearer token for NestJS Chat API persistence |

### 1.3 Preflight Test Suite Verification
Execute the runner, event contracts, and thin SSE transport test suites:

```powershell
Push-Location apps/agent
pytest tests/test_chat_turn_runner.py tests/test_chat_turn_events.py tests/test_sse.py -v
if ($LASTEXITCODE -ne 0) { throw 'Chat turn runner test suite failed.' }
Pop-Location
```

All tests must pass before deploying runner changes to production.

---

## 2. Mismatch Abort Conditions & Safeguards

### 2.1 Fenced Lease Validation (`X-Fencing-Token`)
To prevent split-brain execution and cross-turn database corruption:
- `queue_manager.acquire(session_id, req_id)` atomically acquires the Redis session lock and issues a monotonic integer fencing token.
- Before every mutative operation (partial turn persistence, handoff token emission, action-required event, completion batch), the runner re-validates the lease fence:
  ```python
  fence_valid = await queue_manager.validate_active_fence(session_id)
  ```
- **Abort Safeguard**: If `fence_valid` is `False`, the runner aborts persistence immediately with warning `stale_fence_partial_persistence_aborted`.
- Invariant: NestJS `AgentChatController` validates the `X-Fencing-Token` header and rejects any turn write where the fencing token is $\le$ the database's recorded fence.

### 2.2 Deterministic Causal Cleanup Execution Order
When an exception occurs, or when a client disconnects, `_finalize_cleanup` MUST execute its 4 cleanup steps in exact, unvarying sequence:

```text
+-----------------------------------------------------------------------------+
| Step 1: Persist Safe Partial Turn (Shielded)                                |
| - If tokens emitted and not yet persisted, persist via NestJS Chat API      |
| - Protected by asyncio.shield to prevent cancellation mid-write             |
| - Enforces 1.0s fence check timeout + 3.0s HTTP persistence timeout         |
+--------------------------------------v--------------------------------------+
| Step 2: Finalize Output Guardrails Pipeline                                 |
| - Calls pipeline.aclose() to flush and release NeMo/regex resources         |
| - Enforces 1.0s bounded timeout                                             |
+--------------------------------------v--------------------------------------+
| Step 3: Release Owned Session Lease                                         |
| - Calls queue_manager.release(session_id, req_id) to unlock Redis session    |
| - Enforces 2.0s bounded timeout                                             |
+--------------------------------------v--------------------------------------+
| Step 4: Construct Terminal ErrorEvent                                       |
| - Constructs ErrorEvent(code, message, partialMessageId) for attached client|
+-----------------------------------------------------------------------------+
```

### 2.3 Client Disconnect Handling
- `apps/agent/src/agent/streaming/sse.py` detects disconnection in the event loop:
  ```python
  if await request.is_disconnected():
      break
  ```
- Exiting the generator calls `generator.aclose()`, executing `_finalize_cleanup` under `asyncio.shield`. This guarantees partial user/agent turns are safely committed to PostgreSQL even if the user abruptly closes their browser.

### 2.4 Lifespan Shutdown & Redis Lock Draining
During container SIGTERM / shutdown (`agent.main:lifespan`):
1. Runner tracking: All active tasks are tracked in `active_runners: Set[asyncio.Task]`.
2. Tasks to cancel: Iterates through `active_runners` and calls `task.cancel()`.
3. Bounded wait: Awaits `asyncio.gather(*tasks_to_cancel, return_exceptions=True)` within `SHUTDOWN_TIMEOUT_SECONDS` (5.0s).
4. Stream notification: Emits terminal shutdown error event to all active SSE queues.
5. Redis closure: Drains connection pools via `await close_redis()`.

---

## 3. Observability, Metrics & Alert Thresholds

### 3.1 Prometheus & Tracing Metrics

| Metric Name | Type | Purpose |
|---|---|---|
| `chat_turn_active_runners` | Gauge | Active concurrent runner generator tasks |
| `chat_turn_events_total` | Counter | Events yielded segmented by `event` type |
| `chat_turn_cleanup_duration_seconds` | Histogram | Latency of the 4-step cleanup execution |
| `chat_turn_fence_reject_total` | Counter | Count of stale fencing token rejections |
| `chat_turn_disconnect_total` | Counter | Count of client disconnects mid-turn |

### 3.2 Alert Threshold Table

| Alert | Condition | Severity | Immediate Action |
|---|---|---|---|
| StaleFenceRejectionAlert | `increase(chat_turn_fence_reject_total[5m]) > 2` | P2 (High) | Check for duplicate requests or Redis lock timeout expirations. |
| CleanupTimeoutAlert | `chat_turn_cleanup_duration_seconds{quantile="0.99"} > 4.0` | P2 (High) | Inspect NestJS Chat API latency and Redis network RTT. |
| OrphanedLockSpike | Lock duration $> 60s$ while runner idle | P1 (Critical) | Release orphaned keys; inspect heartbeat task health. |
| ShutdownTimeoutExceeded | Task cancellation exceeds 5.0s during container stop | P2 (High) | Inspect stuck downstream HTTP calls to Mimo or NestJS. |

---

## 4. Observation Window Guidelines

### 4.1 Duration & Scope
- Maintain a **7-day continuous observation window** following deployment of runner modifications.
- Monitor behavior across multiple long-running conversations (> 10 turns) and sudden connection drop-offs.

### 4.2 Daily Operator Verification Checklist
1. Inspect `chat_turn_cleanup_duration_seconds`: Verify p95 is $< 1.5s$.
2. Review partial turn persistence: Verify that aborted conversations show partial responses saved with sender `AGENT` and valid UUIDs in `chat_messages`.
3. Inspect active session locks (read-only inspection):
   ```bash
   redis-cli --scan --pattern "chat:session-lock:*"
   ```
   Locks should only be present for currently active streaming requests and must expire naturally within the 30s TTL window. Never execute batch deletions.
4. Verify graceful container shutdown logs: Check that SIGTERM signals complete cleanup within 5.0s without unhandled exceptions.

---

## 5. Rollback Procedures & Exact Commit Boundaries

### 5.1 Exact Commit Boundaries
- **ChatTurnRunner & Causal Cleanup**: Commit `fb0e88b` (`feat(agent): implement authoritative ChatTurnEvent models, SSE streaming integration, and golden contract tests (Slice 4A)`).

### 5.2 Rollback Procedure
If the runner causes deadlocks, stream hangs, or session lock exhaustion:
1. **Stop & Invalidate Old Runner Processes First**:
   - A still-running runner must never lose its lease while it can continue executing, as that would enable split-brain concurrent execution.
   - Gracefully drain and terminate the running Python agent container instances (`SIGTERM` triggers `agent.main:lifespan`, giving active tasks up to `SHUTDOWN_TIMEOUT_SECONDS = 5.0s` to execute causal cleanup and release their leases).
   - If any runner process is unresponsive or hung on external I/O, force-kill the container process (`SIGKILL`) to guarantee that the old execution thread is completely stopped before any rollback proceeds.
2. **Revert Deployment**:
   - Revert the Python agent container deployment to the stable release preceding `fb0e88b`.
3. **Lease Natural Expiry & Fencing Preservation (No Manual DEL)**:
   - **DO NOT manually DEL active session leases** (`chat:session-lock:{userId}:{sessionId}`).
   - Because the old runner process is confirmed stopped, the background heartbeat refresh task has halted. Any outstanding session lease in Redis will drain and expire naturally within its bounded TTL window (`SESSION_LOCK_TTL_MS = 10000` to `30000`, maximum 30 seconds).
   - Wait 30 seconds for all pending lock TTLs to expire naturally before routing traffic to the rollback containers.
   - **Strictly Preserve Fencing Counters**: Never delete or reset monotonic fence keys (`chat:session-lock:fence:{userId}:{sessionId}`). Preserving the fence counter ensures that any restarted or delayed legacy runner with an older fencing token is strictly rejected by both `MessageQueueManager` and the NestJS persistence guard (`AgentChatController`).
4. **Restart & Validate**:
   - Start the rolled-back agent release.
   - Verify `/health` endpoint reports `status: "ok"` and Redis connectivity is healthy.
   - Verify new sessions acquire locks with incremented monotonic fences (`fence > prior_fence`).

---

## 6. Post-Rollout Cleanup Eligibility

### 6.1 Decommissioned Components
- Monolithic inline generator in `sse.py` (~880 lines) was reduced to a thin transport adapter (283 lines).
- Legacy event models (`BaseSSEEvent`) without `ConfigDict(extra="forbid")` are permanently removed.

### 6.2 Cleanup Verification
- Verify that `apps/agent/src/agent/streaming/sse.py` imports and delegates entirely to `ChatTurnRunner`.
- Confirm that no production code or tests bypass `ChatTurnRunner` to orchestrate LangGraph turns directly.
