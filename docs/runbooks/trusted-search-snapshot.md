# Trusted Search Snapshot Operational Runbook

This operational runbook governs the production lifecycle, atomic persistence, and privacy-safe projection of the `TrustedSearchSnapshot` protocol implemented under `apps/agent/src/agent/trusted_search_snapshot/`.

The snapshot architecture bridges conversational flight search with deterministic checkout handoff, enforcing strict version monotonicity, offer freshness bounding, and provider-identifier isolation.

---

## 1. Preflight Checks & Prerequisites

### 1.1 Redis 3-Key Snapshot Protocol

The repository uses a dedicated 3-key protocol per authenticated conversation session:

1. **Primary Snapshot Payload**: `chat:snapshot:{userId}:{chatSessionId}`
   - Stores the serialized JSON payload containing contiguous 1-indexed flight results, HMAC selection attestation, and UTC timestamps.
2. **Issued Version Reservation**: `chat:snapshot:{userId}:{chatSessionId}:version`
   - Stores the monotonically incremented integer version reserved for an in-flight search execution.
3. **Accepted Version Fence / Tombstone**: `chat:snapshot:{userId}:{chatSessionId}:accepted`
   - Stores the highest successfully committed or invalidated version boundary, rejecting delayed concurrent writes.

### 1.2 Redis Server Prerequisites

- Redis server version 7.0+ with Lua 5.1 engine enabled (`EVAL` / `EVALSHA` commands permitted).
- Redis memory configuration: Ensure `maxmemory-policy` is set to `volatile-ttl` or `noeviction` on the agent Redis instance to prevent premature eviction of version fencing tombstones.
- Time Synchronization: Host clocks between agent instances and Redis must be synchronized via NTP (< 100ms drift).

### 1.3 Preflight Test Suite Verification

Execute the snapshot unit and characterization test suites:

```powershell
Push-Location apps/agent
pytest tests/test_trusted_search_snapshot.py tests/characterization/test_snapshot_characterization.py -v
if ($LASTEXITCODE -ne 0) { throw 'Trusted search snapshot tests failed.' }
Pop-Location
```

All snapshot tests must pass before deploying changes to caller nodes or streaming endpoints.

---

## 2. Mismatch Abort Conditions & Safeguards

### 2.1 Atomic Lua CAS Version Checks

All mutations execute atomically inside Redis through three purpose-built Lua scripts:

1. **Version Allocation (`_NEXT_VERSION_LUA`)**:
   - Computes $next = \max(snapshot\_version, issued\_version, accepted\_version) + 1$.
   - Writes `issued_key` with initial safety TTL ($3600s$).
   - Abort Safeguard: Returns negative error codes if payload is malformed or existing versions are non-integers.

2. **Atomic Replacement (`_REPLACE_SNAPSHOT_LUA`)**:
   - Enforces $incoming\_version > \max(existing\_version, accepted\_version)$.
   - Enforces $incoming\_version == issued\_version$ if an uncommitted version was previously reserved.
   - Atomically updates payload key, issued key, and accepted fence key with exact offer freshness TTL.
   - Abort Safeguard: Returns `0` (rejection) if an out-of-order or stale version attempts to overwrite active state.

3. **Safe Deletion & Tombstone Retention (`_DELETE_SNAPSHOT_LUA`)**:
   - Deletes the primary payload key `chat:snapshot:{userId}:{chatSessionId}`.
   - Retains `accepted_key` as a tombstone retaining the latest version with remaining TTL.
   - Abort Safeguard: Prevents late-arriving async responses from reviving a cancelled search snapshot.

### 2.2 TTL Drift Alerts & Bounds

- Snapshot TTL is strictly calculated as:
  $$TTL = \min(\max(1, \lfloor expiresAt - now \rfloor), 900)$$
- **Abort Condition**: If computed TTL is $\le 0$ or exceeds $900s$ (15 minutes), the repository refuses to persist the snapshot and throws `ValueError("Cannot save snapshot with non-positive TTL")`.

### 2.3 Eviction and Failover Handling

- **Redis Failover**: During Sentinel / Cluster primary election, client requests will briefly fail. The agent handles Redis connection errors fail-closed: returns HTTP 503 `CHAT_CONTROL_PLANE_UNAVAILABLE` before LLM inference, preventing unbudgeted compute without snapshot tracking.
- **Eviction Recovery**: If the payload key is evicted while accepted tombstone remains, subsequent writes still respect the tombstone boundary. If all keys are evicted, the system safely falls back to requiring a fresh flight search (`SNAPSHOT_EXPIRED`).

### 2.4 Negative Privacy Protection

- `project_for_llm` MUST project only 1-indexed integers and display fields (airline name, times, duration, price).
- **Hard Abort Trigger**: If automated output scanning detects Duffel offer IDs (`off_...`), local UUIDs, or HMAC signature strings in LLM prompts, abort deployment immediately.

---

## 3. Observability, Metrics & Alert Thresholds

### 3.1 Prometheus & StatsD Metrics

| Metric                                              | Type      | Purpose                                        | Normal Range                     |
| --------------------------------------------------- | --------- | ---------------------------------------------- | -------------------------------- |
| `snapshot_create_total{status="success\|conflict"}` | Counter   | Tracks snapshot creation and version conflicts | Conflict rate < 1%               |
| `snapshot_load_total{result="hit\|miss\|expired"}`  | Counter   | Tracks conversational snapshot retrieval       | Hit rate > 80% in checkout turns |
| `snapshot_ttl_remaining_seconds`                    | Histogram | Distribution of TTL at read time               | 60s - 900s                       |
| `snapshot_llm_projection_bytes`                     | Histogram | Size of rendered LLM flight context            | 200B - 2KB                       |
| `redis_evicted_keys_total`                          | Counter   | Memory pressure indicator                      | 0 on dedicated agent DB          |

### 3.2 Alert Threshold Table

| Alert                         | Condition                                                | Severity      | Immediate Action                                                         |
| ----------------------------- | -------------------------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| SnapshotVersionCollisionSpike | `rate(snapshot_create_total{status="conflict"}[5m]) > 5` | P2 (High)     | Check for duplicate rapid search submissions from same user session.     |
| RedisEvictionAlert            | `increase(redis_evicted_keys_total[5m]) > 0`             | P1 (Critical) | Increase Redis maxmemory allocation; verify TTL expiration policies.     |
| TTLDriftAlert                 | `snapshot_ttl_remaining_seconds < 10` at creation        | P2 (High)     | Check Duffel search offer expiration duration and system clock sync.     |
| SnapshotTamperingViolation    | Pydantic `ValidationError` on `TrustedSearchSnapshot`    | P1 (Critical) | Investigate possible unauthorized direct Redis write or schema mismatch. |

---

## 4. Observation Window Guidelines

### 4.1 Duration & Traffic Coverage

- Maintain a **14-day continuous observation window** post-deployment.
- Ensure monitoring covers high-concurrency multi-turn conversations and peak weekend flight search traffic.

### 4.2 Daily Operator Verification Checklist

1. Review snapshot conflict rate: Ensure `snapshot_create_total{status="conflict"}` remains below 1% of total creations.
2. Inspect Redis memory footprint:
   ```powershell
   redis-cli info memory
   ```
3. Run automated privacy scanner on LangSmith agent traces: Confirm 0 occurrences of provider offer IDs or signature hashes in model inputs.
4. Verify handoff success rate: Ensure resolved selections via `lifecycle.select(snapshot, index)` correlate 1:1 with handoff token issuances.

---

## 5. Rollback Procedures & Exact Commit Boundaries

### 5.1 Exact Commit Boundaries

- **Canonical Lifecycle & Shim Decommissioning**: Commit `00961da` (`feat(agent): cut over callers to TrustedSearchSnapshotLifecycle and decommission legacy shims (Slice 3B)`).

### 5.2 Rollback Procedure

If snapshot persistence causes conversational deadlocks or Redis CAS errors:

1. Roll back the Python agent container deployment to the release prior to `00961da`.
2. **Targeted Session Cleanup with Version Fencing (Preventing In-Flight Payload Recreation)**:
   - **DO NOT** execute repository-wide pattern deletions (e.g., never run `redis-cli --scan --pattern "chat:snapshot:*" | xargs del`). Global deletion evicts active snapshots across all healthy user sessions and destroys version fencing tombstones.
   - **Invalidate Outstanding Reserved Version**: Simply deleting the payload key without advancing the accepted version allows an in-flight search that holds an already-reserved version (`issued_key`) to pass CAS in `_REPLACE_SNAPSHOT_LUA` and recreate the corrupted/deleted payload upon completion.
   - To prevent this, the rollback procedure MUST atomically advance `chat:snapshot:{userId}:{chatSessionId}:accepted` to at least the current `issued_version` (`chat:snapshot:{userId}:{chatSessionId}:version`) before or atomically with deleting the payload:
     ```bash
     # Execute atomic cleanup & tombstone invalidation using the production Lua script (_DELETE_SNAPSHOT_LUA):
     redis-cli EVAL "
       local snapshot_key = KEYS[1]
       local issued_key = KEYS[2]
       local accepted_key = KEYS[3]
       local s_json = redis.call('GET', snapshot_key)
       local s_v = 0
       local tombstone_ttl = 3600
       if s_json then
         local ok, s = pcall(cjson.decode, s_json)
         if ok and type(s) == 'table' and type(s.snapshotVersion) == 'number' then
           s_v = s.snapshotVersion
           local s_ttl = redis.call('TTL', snapshot_key)
           if s_ttl > 0 then tombstone_ttl = s_ttl end
         end
       end
       local i_v = tonumber(redis.call('GET', issued_key) or 0)
       local a_v = tonumber(redis.call('GET', accepted_key) or 0)
       local invalidated_version = math.max(s_v, i_v, a_v)
       if invalidated_version > 0 then
         redis.call('SET', accepted_key, invalidated_version, 'EX', tombstone_ttl)
       end
       redis.call('DEL', snapshot_key)
       return 1
     " 3 "chat:snapshot:{userId}:{chatSessionId}" "chat:snapshot:{userId}:{chatSessionId}:version" "chat:snapshot:{userId}:{chatSessionId}:accepted"
     ```
   - Alternatively, trigger the repository's native atomic deletion:
     ```powershell
     python -c "import asyncio, redis.asyncio as redis; from agent.trusted_search_snapshot.repository import TrustedSnapshotRepository; from agent.trusted_search_snapshot.models import SnapshotOwner; r = redis.from_url('redis://localhost:6379'); repo = TrustedSnapshotRepository(r); asyncio.run(repo.delete(SnapshotOwner(user_id='{userId}', chat_session_id='{chatSessionId}')))"
     ```
   - **Tombstone & Monotonic Fencing Guarantees**:
     - Advancing the accepted version tombstone guarantees that any in-flight search task that was already processing will fail CAS (`incoming_version <= effective_accepted_version`) upon return, strictly preventing it from recreating the deleted payload.
     - Subsequent fresh searches allocate `next_version = math.max(snapshot, issued, accepted) + 1`, ensuring new valid searches immediately receive a strictly higher monotonic version that can commit successfully.
     - All healthy, unrelated user sessions remain completely untouched and operational.
3. **Graceful User Impact for Affected Session**:
   Deleting the payload key and fencing the accepted version prompts the affected user on their next turn: _"Flight offer expired. Please search again."_ No financial, booking, or account data is lost.
4. Run agent test suite against target deployment to verify stability.

---

## 6. Post-Rollout Cleanup Eligibility

### 6.1 Decommissioned Legacy Shims

The following legacy modules were permanently deleted in Slice 3B and must NOT be recreated:

- `apps/agent/src/agent/models/snapshot.py`
- `apps/agent/src/agent/repositories/trusted_snapshot_repository.py`
- Legacy projection function `project_snapshot_results` in `search_flights.py`

### 6.2 Key Expiration & Memory Cleanup

- Primary snapshot keys expire automatically after offer validity ($TTL \le 900s$).
- Fencing tombstone keys (`:accepted`) expire automatically after $3600s$.
- Zero manual database pruning or garbage collection cron is required.
