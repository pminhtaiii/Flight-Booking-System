# Data Model: Disruption & Flight-Change Management

The schema is additive to the current Feature 12-era Prisma model. `BookingStatus` and cancellation/refund fields remain unchanged. `Booking.flightSnapshot` remains the original booking-time snapshot.

## Booking additions

| Field                        | Type                                | Rules / purpose                                                                          |
| ---------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `disruptionStatus`           | `DisruptionStatus`                  | Required, default `NONE`; orthogonal to `BookingStatus`                                  |
| `activeDisruptionRevisionId` | nullable UUID, unique FK            | Points only to the material revision currently requiring/recording action                |
| `syncLockedAt`               | nullable datetime                   | Five-minute lease start                                                                  |
| `syncLockToken`              | nullable string                     | Ownership token; claim/release always compare token                                      |
| `lastDuffelSyncedAt`         | nullable datetime                   | Last successful authoritative read, changed or unchanged                                 |
| `nextDuffelSyncAt`           | nullable datetime                   | Backoff/fairness control after cron-triggered failure                                    |
| `currentDepartureAt`         | nullable datetime                   | First departure in current itinerary; original `departureAt` remains backward compatible |
| `nextUnflownDepartureAt`     | nullable datetime                   | Indexed reconciliation eligibility for multi-slice/round-trip bookings                   |
| `currentFinalArrivalAt`      | nullable datetime                   | Current final segment arrival; completion boundary                                       |
| `disruptionResolvedReason`   | nullable `DisruptionResolvedReason` | Reason for current `RESOLVED` state                                                      |
| `disruptionResolvedAt`       | nullable datetime                   | Current resolution time                                                                  |
| `disruptionResolvedByType`   | nullable `DisruptionActorType`      | `TRAVELLER`, `SYSTEM`, or `ADMIN`                                                        |
| `disruptionResolvedById`     | nullable string                     | Authenticated user/admin ID where applicable                                             |
| `disruptionNeedsAttention`   | boolean default false               | Operational flag independent of traveller lifecycle                                      |
| `disruptionAttentionReason`  | nullable enum                       | Initial values `NOTIFICATION_THROTTLED`, `AGED_UNRESOLVED`, `DATA_QUALITY`               |
| `disruptionAttentionAt`      | nullable datetime                   | When attention was raised                                                                |

Relations:

- `Booking.itineraryRevisions` uses a named ownership relation to `ItineraryRevision.booking`.
- `Booking.activeDisruptionRevision` uses a different named one-to-one relation to `ItineraryRevision.activeForBooking`, `onDelete: SetNull`.
- `Booking.notificationOutbox` and `Booking.disruptionAuditEvents` are one-to-many.

Indexes:

- unique/indexed `duffelOrderId` for unambiguous supplier lookup; migration must report duplicates/nulls before making it unique.
- `(status, nextUnflownDepartureAt, lastDuffelSyncedAt)` for reconciliation.
- `(disruptionStatus, disruptionResolvedAt)` for aged-active monitoring.
- `(disruptionNeedsAttention, disruptionAttentionAt)` for admin queues.
- `(syncLockedAt)` for stale-lock operations.

## ItineraryRevision

An immutable supplier-authoritative itinerary state written only when the canonical itinerary changes.

| Field                | Type                         | Rules / purpose                                              |
| -------------------- | ---------------------------- | ------------------------------------------------------------ |
| `id`                 | UUID                         | Primary key                                                  |
| `bookingId`          | UUID FK                      | Owning booking, cascade delete with booking retention policy |
| `version`            | integer                      | Monotonic per booking, starts at 1                           |
| `source`             | `ItineraryRevisionSource`    | `WEBHOOK`, `RECONCILIATION`, or `BOOTSTRAP`                  |
| `sourceEventId`      | nullable string              | Duffel event/correlation ID, not a second authority          |
| `supplierObservedAt` | nullable datetime            | Supplier event/update time when reliable                     |
| `fingerprint`        | fixed string                 | Versioned canonical SHA-256 fingerprint                      |
| `isMaterial`         | boolean                      | True when either baseline triggers a material rule           |
| `materialReasons`    | `MaterialDisruptionReason[]` | Queryable deterministic reasons                              |
| `materialBaselines`  | `MaterialBaseline[]`         | `INCREMENTAL`, `CUMULATIVE`, or both                         |
| `incrementalDiff`    | JSON                         | Structured previous/current change set with match evidence   |
| `cumulativeDiff`     | JSON                         | Structured original/current change set with match evidence   |
| `rulesetVersion`     | string                       | Classifier contract version, initially `disruption-v1`       |
| `createdAt`          | datetime                     | Database observation/commit time                             |

Constraints and indexes:

- unique `(bookingId, version)` is the concurrency fallback.
- do **not** make `(bookingId, fingerprint)` unique; A→B→A is a legitimate new revision.
- index `(bookingId, createdAt DESC)` for history.
- index `(bookingId, isMaterial, createdAt DESC)` for material history.
- index `(sourceEventId)` for correlation.

Version collision handling:

1. Re-read latest revision in the final transaction.
2. If latest fingerprint equals the fetched fingerprint, converge as unchanged.
3. Otherwise allocate latest version + 1.
4. If unique collision occurs, re-read. Converge only if fingerprints match; otherwise retry the short transaction with the next version.

## ItineraryRevisionSegment

A normalized immutable segment belonging to one revision.

| Field                  | Type                                                   | Rules / purpose                                         |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `id`                   | UUID                                                   | Primary key                                             |
| `revisionId`           | UUID FK                                                | Owning revision, cascade delete                         |
| `sliceOrder`           | integer                                                | Duffel journey/slice order                              |
| `segmentOrder`         | integer                                                | Order within slice                                      |
| `globalOrder`          | integer                                                | Stable display order across slices                      |
| `duffelSegmentId`      | nullable string                                        | Stable primary matching key; absent in legacy originals |
| `marketingCarrierIata` | string                                                 | Matching/display                                        |
| `operatingCarrierIata` | nullable string                                        | Display/audit                                           |
| `airlineName`          | string                                                 | Display                                                 |
| `flightNumber`         | string                                                 | Matching/display                                        |
| `departureAirportIata` | string                                                 | Matching/materiality                                    |
| `departureAirportName` | string                                                 | Display                                                 |
| `departureCity`        | string                                                 | Display                                                 |
| `departureTerminal`    | nullable string                                        | Display/diff                                            |
| `departureAt`          | datetime with source offset retained in canonical diff | Shift comparison                                        |
| `departureLocalDate`   | date                                                   | Date-change/overnight comparison                        |
| `arrivalAirportIata`   | string                                                 | Matching/materiality                                    |
| `arrivalAirportName`   | string                                                 | Display                                                 |
| `arrivalCity`          | string                                                 | Display                                                 |
| `arrivalTerminal`      | nullable string                                        | Display/diff                                            |
| `arrivalAt`            | datetime with source offset retained in canonical diff | Shift/MCT comparison                                    |
| `arrivalLocalDate`     | date                                                   | Date/overnight comparison                               |
| `durationMinutes`      | integer                                                | Display/consistency                                     |
| `aircraftType`         | nullable string                                        | Display/diff                                            |
| `createdAt`            | datetime                                               | Audit                                                   |

Constraints/indexes:

- unique `(revisionId, globalOrder)`.
- index `(revisionId, sliceOrder, segmentOrder)`.
- index `(duffelSegmentId)`.

The shared `FlightSegmentSnapshot` gains optional `duffelSegmentId` and slice/order metadata for new bookings. Optional fields preserve compatibility with existing stored JSON.

## DuffelWebhookEvent

Durable inbox record for verified external events.

| Field                    | Type                       | Rules / purpose                                                 |
| ------------------------ | -------------------------- | --------------------------------------------------------------- |
| `id`                     | UUID                       | Internal primary key                                            |
| `supplierEventId`        | string unique              | Duffel `wev_*` deduplication identity                           |
| `idempotencyKey`         | nullable string            | Supplier correlation, not sole dedupe key                       |
| `duffelOrderId`          | nullable string            | Validated mapped order ID                                       |
| `eventType`              | string                     | Original type; allow safe recording of unsupported types        |
| `status`                 | `DuffelWebhookEventStatus` | Inbox lifecycle                                                 |
| `attempts`               | integer default 0          | Incremented when an execution begins/fails per service contract |
| `nextAttemptAt`          | nullable datetime          | Deterministic retry schedule                                    |
| `processingStartedAt`    | nullable datetime          | Lease start                                                     |
| `processingToken`        | nullable string            | Lease owner                                                     |
| `rawPayload`             | nullable JSON              | Restricted, never logged/exposed; redacted after 30 days        |
| `payloadRedactedAt`      | nullable datetime          | Retention audit                                                 |
| `lastErrorCode`          | nullable string            | Safe diagnostic code only                                       |
| `lastErrorAt`            | nullable datetime          | Latest failure time                                             |
| `processedAt`            | nullable datetime          | Terminal success/skip time                                      |
| `createdAt`, `updatedAt` | datetime                   | Audit                                                           |

Indexes:

- unique `supplierEventId`.
- `(status, nextAttemptAt, createdAt)` for claims.
- `(processingStartedAt)` for stale lease recovery.
- `(duffelOrderId, createdAt DESC)` for correlation.
- `(payloadRedactedAt, createdAt)` for retention cleanup.

Unsupported verified events enter `SKIPPED`; invalid signatures create no row.

## NotificationOutbox

Durable intent for a future delivery service. Feature 14 writes but does not deliver.

| Field                    | Type                       | Rules / purpose                                                                    |
| ------------------------ | -------------------------- | ---------------------------------------------------------------------------------- |
| `id`                     | UUID                       | Primary key                                                                        |
| `bookingId`              | UUID FK                    | Used later to resolve owner/contact under delivery policy                          |
| `revisionId`             | UUID unique FK             | At most one notification request per revision                                      |
| `type`                   | `NotificationOutboxType`   | Initially `MATERIAL_DISRUPTION`                                                    |
| `status`                 | `NotificationOutboxStatus` | Default `PENDING`; future consumer may use `PROCESSING`, `DELIVERED`, `FAILED`     |
| `payload`                | JSON                       | Safe revision/reason references and presentation facts; no recipient/passenger PII |
| `stabilizationWarning`   | boolean default false      | True only for third UTC-day row                                                    |
| `attempts`               | integer default 0          | Reserved for future consumer                                                       |
| `deliveredAt`            | nullable datetime          | Future consumer field                                                              |
| `createdAt`, `updatedAt` | datetime                   | Throttle/audit                                                                     |

Indexes:

- unique `revisionId`.
- `(bookingId, createdAt)` for UTC-day atomic throttle count.
- `(status, createdAt)` for future delivery.

Outbox suppression at count 3+ creates no placeholder row for the fourth revision; the revision itself records material truth and the booking attention fields record the operational case.

## DisruptionAuditEvent

Immutable audit log for lifecycle and operations actions.

| Field                      | Type                        | Purpose                                                                                                                                                                 |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | UUID                        | Primary key                                                                                                                                                             |
| `bookingId`                | UUID FK                     | Owning booking                                                                                                                                                          |
| `revisionId`               | nullable UUID FK            | Revision acted on                                                                                                                                                       |
| `action`                   | enum                        | `DETECTED`, `ACKNOWLEDGED`, `TRAVELLER_ACCEPTED`, `DEPARTURE_RESOLVED`, `BOOKING_CANCELLED`, `ADMIN_RESOLVED`, `EVENT_RETRIED`, `ATTENTION_RAISED`, `ATTENTION_CLEARED` |
| `fromStatus`, `toStatus`   | nullable `DisruptionStatus` | Lifecycle transition                                                                                                                                                    |
| `actorType`                | `DisruptionActorType`       | Traveller/system/admin                                                                                                                                                  |
| `actorId`                  | nullable string             | Authenticated identity where applicable                                                                                                                                 |
| `safeNote`                 | nullable string             | Required for admin resolution; sanitized and length-limited                                                                                                             |
| `correlationId`, `traceId` | string                      | Operational linkage                                                                                                                                                     |
| `createdAt`                | datetime                    | Immutable timestamp                                                                                                                                                     |

Indexes: `(bookingId, createdAt DESC)`, `(revisionId)`, `(action, createdAt)`.

## Enums

```text
DisruptionStatus:
  NONE | DETECTED | ACKNOWLEDGED | RESOLVED

DisruptionResolvedReason:
  TRAVELLER_ACCEPTED | DEPARTURE_PASSED | ADMIN_RESOLVED | BOOKING_CANCELLED

DisruptionActorType:
  TRAVELLER | SYSTEM | ADMIN

DisruptionAttentionReason:
  NOTIFICATION_THROTTLED | AGED_UNRESOLVED | DATA_QUALITY

ItineraryRevisionSource:
  WEBHOOK | RECONCILIATION | BOOTSTRAP

MaterialBaseline:
  INCREMENTAL | CUMULATIVE

MaterialDisruptionReason:
  SEGMENT_REMOVED
  SEGMENT_ADDED
  DEPARTURE_AIRPORT_CHANGED
  ARRIVAL_AIRPORT_CHANGED
  DEPARTURE_LOCAL_DATE_CHANGED
  ARRIVAL_LOCAL_DATE_CHANGED
  DEPARTURE_MOVED_EARLIER
  DEPARTURE_MOVED_LATER
  FINAL_ARRIVAL_MOVED_EARLIER
  FINAL_ARRIVAL_MOVED_LATER
  OVERNIGHT_CONNECTION_INTRODUCED
  CONNECTION_BELOW_MCT
  INVALID_CONNECTION_OVERLAP

DuffelWebhookEventStatus:
  PENDING | PROCESSING | RETRY_SCHEDULED | PROCESSED | SKIPPED | FAILED_NEEDS_ATTENTION

NotificationOutboxType:
  MATERIAL_DISRUPTION

NotificationOutboxStatus:
  PENDING | PROCESSING | DELIVERED | FAILED
```

## State transitions

### Disruption lifecycle

```text
NONE/RESOLVED/ACKNOWLEDGED/DETECTED
  --new material revision--> DETECTED(new active revision, clear resolution)

DETECTED --owner acknowledges active revision--> ACKNOWLEDGED
DETECTED/ACKNOWLEDGED --owner accepts active revision--> RESOLVED(TRAVELLER_ACCEPTED)
DETECTED/ACKNOWLEDGED --final arrival passes--> RESOLVED(DEPARTURE_PASSED)
DETECTED/ACKNOWLEDGED --supplier cancellation confirms--> RESOLVED(BOOKING_CANCELLED)
DETECTED/ACKNOWLEDGED --admin resolves--> RESOLVED(ADMIN_RESOLVED)

Any state --non-material revision--> lifecycle unchanged
```

### Inbox lifecycle

```text
verified supported event --> PENDING
verified unsupported event --> SKIPPED
PENDING/RETRY_SCHEDULED/stale PROCESSING --CAS lease--> PROCESSING
PROCESSING --sync/no-change succeeds--> PROCESSED
PROCESSING --transient failure, attempts < 5--> RETRY_SCHEDULED
PROCESSING --fifth/terminal failure--> FAILED_NEEDS_ATTENTION
FAILED_NEEDS_ATTENTION --ADMIN retry--> PENDING (audited)
```

## Atomic invariants

1. Revision, normalized segments, material classification, active disruption transition, eligible outbox row/attention flag, audit event, timing read model, sync coverage, and lock release commit together.
2. Supplier-confirmed cancellation and disruption `BOOKING_CANCELLED` resolution commit together.
3. No database transaction remains open during Duffel HTTP calls.
4. No sync finalization writes truth after the booking ceases to be confirmed.
5. No raw supplier payload or passenger/payment PII is copied into logs, outbox, history, or admin/traveller DTOs.

## Migration and backfill

1. Add enums/tables/nullable Booking fields and non-unique supporting indexes.
2. Report duplicate/non-null `duffelOrderId`, confirmed records missing order ID/snapshot, and invalid segment/timing data.
3. Resolve data conflicts before making `duffelOrderId` unique.
4. Backfill `currentDepartureAt`, `currentFinalArrivalAt`, and `nextUnflownDepartureAt` from valid original snapshots without fabricating segment IDs.
5. Deploy code with all Feature 14 flags off.
6. Bootstrap eligible bookings through the normal synchronization command with source `BOOTSTRAP` and outbox/customer surfacing disabled.
7. Do not down-migrate after revisions/inbox records exist; rollback disables execution and preserves additive data.
