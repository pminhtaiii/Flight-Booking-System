# Data model and state compatibility

## Existing relational entities

No new relational entity or relationship is required. The forward migration changes the physical names and Prisma fields below together; values, nullability, foreign keys, and ownership constraints remain unchanged. The actual migration must use the generated database table/column names and rename dependent indexes/constraints after inspecting the current SQL.

| Model | Current field | Target field | Rule |
|---|---|---|---|
| `Booking` | `duffelOrderId` | `supplierOrderId` | nullable; existing order identity/index |
| `Booking` | `duffelCancellationQuoteId` | `supplierCancellationQuoteId` | nullable; cancellation state |
| `Booking` | `lastDuffelSyncedAt` | `lastSupplierSyncedAt` | nullable sync clock; composite index updated |
| `Booking` | `nextDuffelSyncAt` | `nextSupplierSyncAt` | nullable sync clock |
| `BookingIntent` | `duffelOfferId` | `supplierOfferId` | required offer identity |
| `BookingIntentPassenger` | `duffelPassengerId` | `supplierPassengerId` | nullable; intent/passenger index updated |
| `SeatSelection` | `duffelPassengerId` | `supplierPassengerId` | required |
| `BaggageSelection` | `duffelPassengerId` | `supplierPassengerId` | required |
| `FlightOffer` | `duffelOfferId` | `supplierOfferId` | required; unique `(searchHash, supplierOfferId)` |
| `ItineraryRevisionSegment` | `duffelSegmentId` | `supplierSegmentId` | nullable; index updated |
| `ChatHandoff` | `duffelOfferIdHash` | `supplierOfferIdHash` | required hash, same computation/input identity |

`DuffelWebhookEvent`, `DuffelWebhookEventStatus`, `DuffelWebhookEvent.duffelOrderId`, raw webhook payload, and `duffel_webhook_events` remain Duffel-specific. Prior migration files retain historical names. No `@map` alias hides an old physical column.

## Domain values and transformations

- `FlightOffer` is the normalized supplier-independent offer consumed for ranking, detail, readiness, handoff, persistence, and selection. It has deterministic application and opaque supplier offer IDs; decimal total/numeric display price and currency; expiry; passenger supplier IDs/types; airline/flight/route/timing/duration/stops; segment terminal/aircraft/cabin data; baggage; refund/change conditions; match-scoring facts; and opaque raw supplier JSON solely for storage. Its exact contract is in [supplier-boundaries.md](./contracts/supplier-boundaries.md). `FlightSearchResult` wraps offers with existing `searchHash` and `cached` metadata. Persisted raw JSON is normalized through `FLIGHT_SEARCH_PORT.normalizeStoredOffer` before domain decisions.
- `FlightSnapshot` and `PassengerSnapshot` keep their current booking semantics. New segment snapshots use `supplierSegmentId`; readers of previously persisted `Booking.flightSnapshot` JSON accept the old `duffelSegmentId` as an input alias and normalize it in memory. Public HTTP JSON continues to expose current keys where already contractual.
- Order create, cancellation quote, retrieve, and recovery outcomes preserve existing status/error state transitions. `FULFILLMENT_GATEWAY_PORT` input/output and redacted `PersistedOrderEvidence` remain unchanged.
- Existing `IdempotencyKey.recoveryPoint` is a string state machine (`started` → `stripe_authorized` → `duffel_order_created` → `captured` → `completed`). If the internal state is renamed to `supplier_order_created`, read both values for old rows and write only the new value after the reader is deployed. `PaymentEvent.eventType='duffel_order_created'` and ledger account `DUFFEL_COST` are persisted business history; preserve historic reads and audit meaning rather than performing a blind text replace.
- When supplier cancellation after a created order is unconfirmed in either inline or background compensation, `Booking` remains `PROCESSING`, the Stripe hold remains authorized, the order-created `PaymentEvent` remains, and `IdempotencyKey.recoveryPoint` remains at order-created rather than `completed`. `BookingRecoveryService` uses a PII-free Redis key `booking:recovery:defer:{bookingId}` with TTL to the typed budget retry time or bounded backoff; missing cache state causes a safe recheck. Only after confirmed cancellation does it transition payment/booking to terminal failure. This applies to any unconfirmed cancellation, not solely a budget denial.

## Redis budget state

| Key concept | Lifetime | Rule |
|---|---|---|
| Total Duffel attempts | UTC calendar day | Maximum 1,500 across all supplier capability adapters |
| User search attempts | Same UTC day | Maximum 1,000; checked with total in one atomic reservation |
| Agent search attempts | Same UTC day | Maximum 500; checked with total in one atomic reservation |

Use new daily versioned keys rather than reinterpreting the current `budget:duffel:YYYY-MM` monthly key. Expire all three at the next UTC midnight. Cache hits reserve no attempt. Parallel SDK calls and retries reserve individually. A failed or timed-out attempted external request retains its reservation because the remote service may have received it. An exhausted or unavailable budget store rejects before the request.

## Search attestation and transient snapshots

`SelectionAttestationService` signs a `sel_v1_` payload whose offer objects contain `duffelOfferId`. Preserve its exact serialized keys and order for existing signatures. Current HTTP and agent-gateway DTOs retain legacy wire keys through explicit mapping. Python trusted-search snapshots are strict and ephemeral; a stale old-format snapshot after internal rename must be treated as invalid and require a fresh search, never trusted as a partially parsed selection.

## Migration validation

1. Apply all committed migrations plus the new forward rename to an empty PostgreSQL database; generate Prisma client and inspect physical columns/indexes.
2. Apply the new migration to a local database already at the preceding migration and verify preserved rows, order links, offer uniqueness, and sync indices.
3. Run booking/recovery/disruption tests using both legacy snapshot JSON and newly written neutral JSON.
4. Keep rollback at the deployment boundary by reverting the new migration with an explicit inverse rename if required; do not modify historical migration files.
