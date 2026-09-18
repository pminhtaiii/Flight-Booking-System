# Booking Projection Reconciliation Runbook

This operational runbook governs the background self-healing reconciliation engine for `BookingAgentProjection` records in the NestJS API (`apps/api`). It documents operational topology, keyset traversal mechanics, poison pill isolation, multi-replica concurrency safety, Prometheus telemetry, diagnostic queries, manual backfill execution, emergency repair, and the safe rollback/reactivation protocol.

---

## 1. System Overview & Architecture

### 1.1 Architecture and Purpose

The booking projection subsystem maintains read-optimized, privacy-safe projections (`BookingAgentProjection`) consumed by the AI Agent Gateway and Safe Booking Read services. 

Under normal operations, projections are kept up to date asynchronously via in-process domain events:
```
[ Booking Mutation ] (Guarded Transaction)
         │
         ▼
[ DomainEventContext ] (Collects Domain Events)
         │
         ▼ (Post-Commit Dispatch)
[ BookingEventPublisherService ] ──► [ EventEmitter2 ]
                                            │
                                            ▼
                              [ BookingProjectionListener ]
                                            │
                                            ▼
                              [ BookingEventHydratorService ]
                                            │
                                            ▼
                             [ BookingProjectionRepository ]
                                 (Guarded Upsert: version fence)
```

However, because in-memory event dispatching is non-durable across process crashes, restarts, unhandled exceptions in listeners, or network interruptions, the system provides an out-of-band self-healing reconciler: `BookingProjectionReconciliationService`.

```text
+---------------------------------------------------------------------------------------------------+
|                            BOOKING PROJECTION SUBSYSTEM ARCHITECTURE                              |
|                                                                                                   |
|  [ Domain Mutations ] (BookingLifecycleService, Saga, Recovery, Cancellation, Disruption, Refund)  |
|          │                                                                                        |
|          ▼                                                                                        |
|  [ DomainEventsModule ] ──── (In-Process Events) ────► [ BookingProjectionListener ]             |
|                                                                   │                               |
|                                                                   ▼ (Event-Driven Write Path)     |
|  +─────────────────────────────────────────+          [ BookingProjectionRepository ]             |
|  | BookingProjectionReconciliationService |                    ▲          │                      |
|  |   - Every 1 minute                      |                    │          ▼                      |
|  |   - 100 batch keyset scan               | ── (Periodic Scan) ─┘   [ PostgreSQL Database ]      |
|  |   - 5 concurrent workers                |                         - bookings (version)         |
|  |   - ZERO third-party provider calls     |                         - booking_agent_projections  |
|  +─────────────────────────────────────────+                           (source_version)           |
+---------------------------------------------------------------------------------------------------+
```

### 1.2 Core Architectural Invariants

1. **Zero Third-Party Provider Calls**: The reconciliation engine is strictly database-internal. It hydrates coherent booking snapshots directly from PostgreSQL tables (`bookings`, `itinerary_revisions`, `flight_segments`). It never calls Duffel, Stripe, or any external supplier or financial gateway.
2. **Deterministic Version Fencing**: Updates to `booking_agent_projections` are gated by SQL version comparisons (`booking_agent_projections.source_version < EXCLUDED.source_version`). Out-of-order execution cannot regress projection freshness.
3. **Agent Reference Immutability**: The public UUID token `agentReference` generated upon initial insertion is never overwritten during upserts (`agentReference` is omitted from the `ON CONFLICT DO UPDATE` column list).
4. **Decoupled Financial Invariant**: Reconciliation never writes to or alters `payments`, `refunds`, or `ledger_entries`. Projections are read-only views for downstream agent tools.

---

## 2. Keyset Traversal Mechanics

### 2.1 Traversal Configuration & Scheduling

`BookingProjectionReconciliationService` runs on a scheduled 1-minute cadence via NestJS Schedule:
- **Cron Expression**: `@Cron(CronExpression.EVERY_MINUTE)`
- **Batch Size**: 100 candidate bookings per pass.
- **Concurrency Limit**: Up to 5 worker promises executing concurrently per pass.
- **Cursor State**: In-memory monotonic cursor `cursor?: string` representing the last processed `booking.id`.

### 2.2 SQL Keyset Pagination Query

The candidate scanner executes against PostgreSQL using keyset pagination with an indexed `LEFT JOIN`:

```sql
SELECT b."id"
FROM "bookings" b
LEFT JOIN "booking_agent_projections" p ON p."bookingId" = b."id"
WHERE (p."bookingId" IS NULL OR p."source_version" < b."version")
  AND ($cursor::text IS NULL OR b."id" > $cursor::text)
ORDER BY b."id" ASC
LIMIT $batchSize;
```

### 2.3 Monotonic Progression & Reset Rules

1. **Batch Progression**: When candidate bookings are returned, each candidate is processed and assigned one of four outcomes:
   - `repaired`: Missing projection created or stale projection upgraded to latest `Booking.version`.
   - `current`: Projection was already current or concurrently updated by another worker/event (`STALE_IGNORED`).
   - `skipped`: Booking snapshot or required flight data was missing (unusable source record).
   - `failed`: Hydration, extraction, or upsert encountered an error.
2. **Monotonic Cursor Advancement**: Regardless of whether a candidate succeeds, is skipped, or fails, the cursor monotonically advances to the highest `booking.id` in the batch (`nextCursor = bookingIds[bookingIds.length - 1]`). This guarantees that broken or malformed items do not trap the reconciler in an infinite retry loop.
3. **Cursor Reset**: When `reachedEnd === true` (i.e. `candidateIds.length < batchSize`), the full keyset space has been traversed. The service resets `this.cursor = undefined` for the subsequent pass without scanning an extra empty page.

---

## 3. Poison Pill Isolation & Error Triage

### 3.1 Malformed Source Data & Missing Itineraries

If a booking record contains corrupt JSON, an invalid schema, or references missing itinerary segments:
1. `BookingEventHydratorService.hydrate(bookingId)` or `BookingProjectionService.extractProjectionData(snapshot)` raises an error (e.g. `MalformedRevisionError`).
2. The reconciler catches the error locally within `reconcileCandidate(bookingId)`.
3. **State Preservation**: The projection's `source_version` is **NOT** advanced, ensuring the record remains marked as stale in diagnostic queries. The legacy `flightSnapshot` is never used as an unsafe fallback when an authoritative revision exists.
4. **Deadlock Prevention**: The candidate is marked as `failed`, and the batch cursor advances past the poison pill ID.
5. **Telemetry & Logging**:
   - A structured warning is logged containing `bookingId`, `message`, and sanitized error details (no PII).
   - The failure counter is incremented: `booking_projection_failure_total{error_type="HYDRATION_FAILED" | "EXTRACTION_FAILED"}`.

### 3.2 Error Classification Matrix

| Error Condition | Log Level | Metric Tag (`error_type`) | Cursor Behavior | Row Outcome |
|---|---|---|---|---|
| Hydration database error | WARN | `HYDRATION_FAILED` | Advances past candidate | `failed` |
| Itinerary revision malformed | WARN | `EXTRACTION_FAILED` | Advances past candidate | `failed` |
| Booking deleted mid-reconciliation | WARN | N/A | Advances past candidate | `skipped` |
| Incomplete flight snapshot (no segments) | WARN | N/A | Advances past candidate | `skipped` |
| Database lock / upsert failure | ERROR | `UNEXPECTED_ERROR` | Advances past candidate | `failed` |

---

## 4. Multi-Replica Considerations

### 4.1 Process-Local Concurrency Gate

Within a single NestJS application instance, the service uses an internal state variable `private isReconciling = false;`:
- If a cron trigger fires while a previous reconciliation pass is still active, the new pass is immediately skipped:
  ```json
  {"message": "[reconcileBatch] Reconciliation pass skipped: previous execution still in progress"}
  ```
- The lock is released in a `finally` block when all worker promises finish.

### 4.2 Multi-Pod / Multi-Replica Execution Safety

When running multiple API pods in Kubernetes or ECS:
1. **Independent Cursors**: Each node maintains its own independent in-memory cursor. Nodes may traverse different segments of the ID space simultaneously or overlap.
2. **Deterministic Database Upsert Fencing**:
   Concurrency conflicts across nodes are resolved at the PostgreSQL storage engine level via atomic conditional upsert:
   ```sql
   INSERT INTO "booking_agent_projections" (...)
   VALUES (...)
   ON CONFLICT ("bookingId") DO UPDATE
   SET "status" = EXCLUDED."status",
       "airline" = EXCLUDED."airline",
       ...
       "source_version" = EXCLUDED."source_version",
       "updatedAt" = NOW()
   WHERE "booking_agent_projections"."source_version" < EXCLUDED."source_version";
   ```
3. **Outcome Guarantee**:
   - The first pod to write updates the row and receives `outcome = 'SUCCESS'` (counted as `repaired`).
   - Any concurrent or lagging pod executing against the same booking discovers the version condition is false (`source_version < EXCLUDED.source_version` matches 0 rows), resulting in `outcome = 'STALE_IGNORED'` (counted as `current`).
   - Zero race conditions, data overwrites, or duplicate reference generations can occur across replicas.

---

## 5. Observability & Telemetry

### 5.1 Prometheus Metrics Catalog

All projection metrics follow strict prometheus conventions with bounded label cardinality. **NO PII, booking IDs, user IDs, or raw strings appear in metric labels.**

| Metric Name | Type | Labels | Description |
|---|---|---|---|
| `booking_projection_events_total` | Counter | `event_name`, `status` (`SUCCESS`, `ERROR`, `STALE_IGNORED`) | Event-driven projection attempts |
| `booking_projection_duration_ms` | Histogram / Summary | N/A | Event-driven processing latency (ms) |
| `booking_projection_reconciliation_pass_total` | Counter | `outcome` (`SUCCESS`, `ERROR`) | Total reconciliation cycles executed |
| `booking_projection_reconciliation_stale_found_total` | Counter | N/A | Number of candidate stale/missing bookings identified |
| `booking_projection_reconciliation_repaired_total` | Counter | N/A | Projections successfully created or updated |
| `booking_projection_reconciliation_failed_total` | Counter | N/A | Candidates failing hydration, extraction, or upsert |
| `booking_projection_reconciliation_skipped_total` | Counter | N/A | Candidates skipped due to missing/incomplete flight data |
| `booking_projection_reconciliation_current_total` | Counter | N/A | Candidates evaluated that were already current |
| `booking_projection_reconciliation_duration_ms` | Histogram / Summary | N/A | Total execution time per reconciliation pass (ms) |
| `booking_projection_failure_total` | Counter | `error_type` (`HYDRATION_FAILED`, `EXTRACTION_FAILED`, `UNEXPECTED_ERROR`, `INVALID_EVENT`, `DATABASE_ERROR`, `UNKNOWN`) | Granular failure triage counter |

### 5.2 Alerting Thresholds

- **Reconciliation Failure Spike**: `rate(booking_projection_reconciliation_failed_total[5m]) > 5` for > 15m. Indicates corrupted source data or schema migration drift.
- **Persistent Drift Backlog**: `booking_projection_reconciliation_stale_found_total` continuously elevated across passes without dropping toward zero after a complete keyset cycle.
- **Pass Execution Timeout**: `booking_projection_reconciliation_duration_ms > 45000` (pass duration exceeding 45 seconds).

---

## 6. Operational Procedures & Runbook Commands

### 6.1 Diagnostic SQL Queries

Run these queries against the read replica or primary database using the approved production SQL console.

#### Query 1: Stale & Missing Projections Summary
```sql
SELECT 
  COUNT(*) FILTER (WHERE p."bookingId" IS NULL) AS missing_projections,
  COUNT(*) FILTER (WHERE p."bookingId" IS NOT NULL AND p."source_version" < b."version") AS stale_projections,
  COUNT(*) FILTER (WHERE p."bookingId" IS NOT NULL AND p."source_version" >= b."version") AS current_projections,
  COUNT(*) AS total_bookings
FROM "bookings" b
LEFT JOIN "booking_agent_projections" p ON p."bookingId" = b."id";
```

#### Query 2: Inspect Stale Records Backlog
```sql
SELECT 
  b."id" AS booking_id,
  b."status" AS booking_status,
  b."version" AS booking_version,
  p."source_version" AS projection_version,
  b."updatedAt" AS booking_updated_at,
  p."updatedAt" AS projection_updated_at
FROM "bookings" b
LEFT JOIN "booking_agent_projections" p ON p."bookingId" = b."id"
WHERE p."bookingId" IS NULL OR p."source_version" < b."version"
ORDER BY b."updatedAt" DESC
LIMIT 50;
```

#### Query 3: Inspect Corrupted / Unrepairable Bookings (Missing Flight Data)
```sql
SELECT 
  b."id" AS booking_id,
  b."status",
  b."version",
  COUNT(r."id") AS revision_count,
  COUNT(s."id") AS segment_count
FROM "bookings" b
LEFT JOIN "itinerary_revisions" r ON r."bookingId" = b."id"
LEFT JOIN "itinerary_revision_segments" s ON s."revisionId" = r."id"
LEFT JOIN "booking_agent_projections" p ON p."bookingId" = b."id"
WHERE (p."bookingId" IS NULL OR p."source_version" < b."version")
GROUP BY b."id", b."status", b."version"
HAVING COUNT(s."id") = 0 AND b."flightSnapshot" IS NULL;
```

---

### 6.2 Manual Trigger & Backfill Execution

When a full database resynchronization or bulk catch-up is required without waiting for the 100-rows-per-minute background cron, execute the backfill CLI script.

```powershell
Push-Location apps/api
& '.\node_modules\.bin\tsx.CMD' prisma/scripts/backfill-booking-agent-projections.ts
Pop-Location
```

**Expected Output**:
```text
Starting restart-safe backfill of BookingAgentProjections...
Processed: 1250 | Success: 1248 | StaleIgnored: 2 | Skipped: 0 | Failed: 0
Backfill completed successfully.
```

The script:
- Traverses all bookings in chunks of 50.
- Uses `BookingProjectionRepository.upsertGuarded` to preserve existing `agentReference` values.
- Respects version fencing (`source_version < EXCLUDED.source_version`).
- Is safe to re-run multiple times concurrently or restart after interruption.

---

### 6.3 Emergency Single-Booking Repair Procedure

If a specific customer booking projection is stale or missing and must be repaired immediately:

#### Option A: Trigger Reconciliation via Node REPL
```powershell
Push-Location apps/api
node -e "
const { PrismaClient } = require('@prisma/client');
const { BookingProjectionRepository } = require('./dist/booking-projection/booking-projection.repository');
const { BookingProjectionService } = require('./dist/booking-projection/booking-projection.service');
const { BookingEventHydratorService } = require('./dist/domain-events/booking-event-hydrator.service');
const { BookingProjectionReconciliationService } = require('./dist/booking-projection/booking-projection-reconciliation.service');

async function repair(bookingId) {
  const prisma = new PrismaClient();
  try {
    const hydrator = new BookingEventHydratorService(prisma);
    const service = new BookingProjectionService();
    const repo = new BookingProjectionRepository(prisma);
    const snapshot = await hydrator.hydrate(bookingId);
    if (!snapshot) { console.error('Booking not found'); return; }
    const data = service.extractProjectionData(snapshot);
    const res = await repo.upsertGuarded({
      bookingId,
      status: snapshot.status,
      sourceVersion: snapshot.version,
      data,
    });
    console.log('Repair result:', res);
  } finally {
    await prisma.\$disconnect();
  }
}
repair(process.argv[1]);
" "<TARGET_BOOKING_ID>"
Pop-Location
```

#### Option B: Direct SQL Diagnostic Read Verification
Verify that the projection is consistent after repair:
```sql
SELECT 
  p."bookingId",
  p."agentReference",
  p."status",
  p."airline",
  p."origin",
  p."destination",
  p."source_version",
  b."version" AS authoritative_version
FROM "booking_agent_projections" p
JOIN "bookings" b ON b."id" = p."bookingId"
WHERE p."bookingId" = '<TARGET_BOOKING_ID>';
```

---

### 6.4 Temporary Deactivation

In case of severe database load or scheduled database migrations, reconciliation can be paused:

1. **Kubernetes / Pod Configuration**:
   Scale down dedicated background worker pods or stop the API deployment if maintenance is in progress.
2. **Alternative Configuration Guard**:
   If dynamic cron suspension is required, remove or conditionalize `BookingProjectionReconciliationService` in `BookingProjectionModule`, or pause the job via NestJS `SchedulerRegistry`. The job is explicitly registered under `BookingProjectionReconciliationService` (via `RECONCILIATION_CRON_JOB_NAME` exported from `booking-projection-reconciliation.service.ts`). Always check existence before stopping:
   ```typescript
   // Verify and pause the cron job at runtime via NestJS SchedulerRegistry:
   if (schedulerRegistry.doesExist('cron', 'BookingProjectionReconciliationService')) {
     schedulerRegistry.getCronJob('BookingProjectionReconciliationService').stop();
   }
   ```
   To resume the reconciliation cron job later:
   ```typescript
   if (schedulerRegistry.doesExist('cron', 'BookingProjectionReconciliationService')) {
     schedulerRegistry.getCronJob('BookingProjectionReconciliationService').start();
   }
   ```

---

### 6.5 Rollback & Reactivation Procedure

This procedure governs reverting the deployment to a legacy API version and subsequently reactivating the event-driven system.

#### Safety Invariants During Rollback
- **NEVER DROP COLUMNS**: Do NOT drop `Booking.version` or `BookingAgentProjection.source_version`. Legacy applications safely ignore extra columns.
- **NEVER ALTER FINANCIAL TABLES**: Do NOT run rollback scripts or migrations against `payments`, `refunds`, or `ledger_entries`. Financial ledgers remain strictly immutable.

#### Step 1: Application Rollback
Deploy the previous stable API release image.
- Legacy application code writes to `bookings` without specifying `version`.
- PostgreSQL defaults `version = 1` for new bookings.
- Existing bookings updated by legacy writers will have their business columns updated while `Booking.version` remains unchanged.

#### Step 2: Reactivation & Safe Freshness Reset
Before re-enabling the new API with event-driven projections and reconciliation:
1. **Stop Legacy Writers**: Quiesce traffic or initiate the deployment maintenance window.
2. **Deploy Upgraded Application**: Deploy the new release containing `BookingProjectionModule` and reconciliation.
3. **Execute Freshness Reset SQL**:
   Execute the following SQL command against PostgreSQL. This resets `source_version = 0` on all existing projections:
   ```sql
   UPDATE "booking_agent_projections"
   SET "source_version" = 0,
       "updatedAt" = NOW();
   ```
   *Why this works*: All bookings have `version >= 1`. By setting `source_version = 0`, every projection becomes eligible for reconciliation (`source_version < b.version`), forcing the reconciler or backfill script to refresh each projection from the latest authoritative data. Existing `agentReference` values remain untouched.
4. **Trigger Backfill or Run Traversal**:
   ```powershell
   Push-Location apps/api
   & '.\node_modules\.bin\tsx.CMD' prisma/scripts/backfill-booking-agent-projections.ts
   Pop-Location
   ```
5. **Verify Zero Drift**:
   Run Query 1 from Section 6.1. Ensure `missing_projections = 0` and `stale_projections = 0`.
6. **Resume Traffic**: Unquiesce API gateway and enable live traffic.
