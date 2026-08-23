# Refund Settlement Contract Migration Runbook

This runbook governs Feature 019 Slice 1D: contracting the legacy direct `Refund.bookingId` / `Booking.cancellationRefund` relationship after the additive obligation migration, the backfill, and the provider-blind Refund Settlement cutover. It implements the required expand → backfill → validate → cut over → observe → contract sequence from [the Feature 019 plan](../../specs/019-improve-architecture/plan.md), [data model](../../specs/019-improve-architecture/data-model.md), and [settlement contract](../../specs/019-improve-architecture/contracts/refund-settlement.md).

The physical PostgreSQL table remains `refunds`. This change does not rename it.

## Safety rules

- Run every command first against a restored production snapshot or other disposable database. Use no live Stripe or Duffel credentials during verification.
- Do not run the contract migration while a backfill mismatch, quarantine, ledger invariant failure, reservation conflict spike, or unexplained settlement conflict is open.
- A successful `Refund` with a cancellation obligation must retain its exact two-entry reversal pair: `DEBIT PLATFORM_REVENUE` and `CREDIT CUSTOMER_RECEIVABLE`, both for the transaction amount and currency.
- Roll back code before rolling back schema whenever possible. The legacy one-refund-per-booking schema cannot faithfully represent an obligation that has more than one linked refund transaction.
- Treat database identifiers, Stripe/Duffel references, booking references, amounts, and audit metadata as restricted operational data. Do not paste query output into tickets, chat, dashboards, or logs.

## Required rollout order

1. Deploy the additive migration `20260822000000_cancellation_refund_obligation_expand` and application code that can read both representations.
2. Run the restart-safe backfill and validation; resolve every quarantine before proceeding.
3. Deploy the four trigger cutovers. New cancellation refunds must reserve a transaction against an obligation and terminal outcomes must go exclusively through Refund Settlement.
4. Complete the observation window below with the additive schema still present.
5. Re-run preflight immediately before deployment, take a verified database backup, deploy `20260823000000_refund_obligation_contract`, regenerate Prisma Client, and run Gate 1.
6. Keep legacy amount columns and the physical `refunds` table. Their removal or rename is a separate retention-approved cleanup.

No step may be skipped because a lower environment happened to have no legacy rows.

## Preflight and validation

Set `DATABASE_URL` through the deployment secret mechanism; never place a production URL in shell history, a runbook transcript, or a ticket. The following commands are shown from the repository root and use the environment already injected into the approved operator shell.

```powershell
docker compose up -d

Push-Location apps/api
& '.\node_modules\.bin\prisma.CMD' migrate status
& '.\node_modules\.bin\prisma.CMD' generate
Pop-Location
```

The migration status must show the expand migration as applied and must not report divergence. Before the contract migration is deployed, it must not already report `20260823000000_refund_obligation_contract` as applied.

Run the backfill once in the approved maintenance/change window. It is restart-safe and can update/attach missing obligations and ledger links, but it does **not** exit nonzero merely because it quarantines a record. Save its count-only summary in the restricted change record; do not retain its per-row log output.

```powershell
Push-Location apps/api
& '.\node_modules\.bin\tsx.CMD' prisma/scripts/backfill-cancellation-refund-obligations.ts
if ($LASTEXITCODE -ne 0) { throw 'Cancellation refund obligation backfill failed.' }
Pop-Location
```

Proceed only when the summary has `Errors: 0` **and** `Quarantined: 0`. A nonzero `Quarantined` count is a contract-migration abort even when the process exit code is zero.

Run each query through the approved production SQL console with `ON_ERROR_STOP` enabled. The expected result for every query is `0`. The queries intentionally return counts only.

```sql
-- Legacy cancellation rows must have a canonical obligation before the legacy FK is removed.
SELECT count(*) AS legacy_refunds_missing_obligation
FROM "refunds"
WHERE "bookingId" IS NOT NULL
  AND "cancellationRefundObligationId" IS NULL;

-- This is the exact contract predicate. Other refund reasons remain eligible to have no obligation.
SELECT count(*) AS cancellation_reason_missing_obligation
FROM "refunds"
WHERE reason LIKE 'cancellation:%'
  AND "cancellationRefundObligationId" IS NULL;

-- The obligation must point at the same booking payment and use its payment currency.
SELECT count(*) AS obligation_payment_or_currency_mismatch
FROM "cancellation_refund_obligations" o
JOIN "bookings" b ON b.id = o."bookingId"
JOIN "payments" p ON p.id = o."paymentId"
WHERE b."paymentId" IS DISTINCT FROM o."paymentId"
   OR upper(o.currency) <> upper(p.currency)
   OR o."totalAmount" < 0
   OR o."airlineRefundAmount" < 0;

-- A refund linked to an obligation must agree with that obligation's payment and currency.
SELECT count(*) AS linked_refund_mismatch
FROM "refunds" r
JOIN "cancellation_refund_obligations" o
  ON o.id = r."cancellationRefundObligationId"
WHERE r."paymentId" <> o."paymentId"
   OR upper(r.currency) <> upper(o.currency);

-- Successful and active transaction capacity may never exceed either financial parent.
WITH payment_totals AS (
  SELECT p.id, p.amount,
    coalesce(sum(r.amount) FILTER (WHERE r.status = 'SUCCEEDED'), 0) AS succeeded,
    coalesce(sum(r.amount) FILTER (
      WHERE r.status IN ('REFUND_PENDING', 'REFUND_PROCESSING', 'REFUND_RETRY_SCHEDULED')
    ), 0) AS active
  FROM "payments" p
  LEFT JOIN "refunds" r ON r."paymentId" = p.id
  GROUP BY p.id, p.amount
), obligation_totals AS (
  SELECT o.id, o."totalAmount",
    coalesce(sum(r.amount) FILTER (WHERE r.status = 'SUCCEEDED'), 0) AS succeeded,
    coalesce(sum(r.amount) FILTER (
      WHERE r.status IN ('REFUND_PENDING', 'REFUND_PROCESSING', 'REFUND_RETRY_SCHEDULED')
    ), 0) AS active
  FROM "cancellation_refund_obligations" o
  LEFT JOIN "refunds" r ON r."cancellationRefundObligationId" = o.id
  GROUP BY o.id, o."totalAmount"
)
SELECT
  (SELECT count(*) FROM payment_totals WHERE succeeded + active > amount) +
  (SELECT count(*) FROM obligation_totals WHERE succeeded + active > "totalAmount")
  AS over_capacity_parents;

-- Every successful transaction has exactly one balanced, correctly typed reversal pair.
WITH linked_ledger AS (
  SELECT r.id,
    count(le.id) AS entry_count,
    count(*) FILTER (
      WHERE le."entryType" = 'DEBIT'
        AND le."accountId" = 'PLATFORM_REVENUE'
        AND le.amount = r.amount
        AND upper(le.currency) = upper(r.currency)
    ) AS debit_count,
    count(*) FILTER (
      WHERE le."entryType" = 'CREDIT'
        AND le."accountId" = 'CUSTOMER_RECEIVABLE'
        AND le.amount = r.amount
        AND upper(le.currency) = upper(r.currency)
    ) AS credit_count
  FROM "refunds" r
  LEFT JOIN "ledger_entries" le ON le."refundTransactionId" = r.id
  WHERE r.status = 'SUCCEEDED'
  GROUP BY r.id, r.amount, r.currency
)
SELECT count(*) AS invalid_successful_ledger_pairs
FROM linked_ledger
WHERE entry_count <> 2 OR debit_count <> 1 OR credit_count <> 1;

-- Active or failed transactions must not own a reversal pair.
SELECT count(*) AS non_successful_transactions_with_ledger
FROM "refunds" r
JOIN "ledger_entries" le ON le."refundTransactionId" = r.id
WHERE r.status <> 'SUCCEEDED';
```

Run the focused Gate 1 suites against the migrated disposable database before production contract rollout, then again after it:

```powershell
Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --runInBand `
  src/refund-settlement/refund-settlement.service.spec.ts `
  src/refund/refund-transaction.service.spec.ts `
  src/payment/payment-refund.service.spec.ts `
  src/payment/payment-webhook.service.spec.ts `
  src/payment/payment-cron.service.spec.ts

& '.\node_modules\.bin\jest.CMD' --config ./test/jest-e2e.json --runInBand `
  test/payment-refund.e2e-spec.ts `
  test/cancellation.e2e-spec.ts
Pop-Location
```

## Mismatch and quarantine procedure

Stop the rollout immediately if the backfill reports an error or quarantine, any preflight count is nonzero, or a ledger/capacity query returns a violation.

1. Freeze the contract deployment and leave the additive schema and dual-compatible application code in place.
2. Preserve a database snapshot and the restricted job output. Record only the change ID, aggregate counts, trace/correlation IDs, and timestamps in the incident record.
3. Do not manually attach a refund, alter money amounts, fabricate ledger entries, or replay a provider operation to clear the mismatch.
4. Classify the record with an authorized finance/operator review: Booking↔Payment identity, currency/minor-unit conversion, obligation capacity, ambiguous/missing ledger pair, or invalid non-success ledger link.
5. Correct the source data or approved migration logic in a separately reviewed change, then re-run the full backfill and all preflight queries. The result must be zero quarantines and zero violations before the contract is reconsidered.

The current backfill uses quarantine as a safe skip; it does not persist a dedicated quarantine table. The restricted change record is therefore the authoritative queue until a future feature introduces explicit case storage.

## Observation window and promotion criteria

Keep the additive schema for a minimum of **14 consecutive calendar days** and at least one full scheduled refund-recovery interval after all four triggers (inline, webhook, cron, and admin) use the settlement boundary. Reset the window after any material refund rollback, backfill rerun that changes production rows, unresolved mismatch, or settlement/ledger invariant alert.

During the window, review daily:

- `settlement applied`, `settlement no-op/replay`, and `settlement conflict` counters segmented only by `INLINE`, `WEBHOOK`, `CRON`, or `ADMIN` provenance;
- reservation rejections segmented by `payment_capacity` versus `obligation_capacity`;
- backfill mismatch/quarantine count and ledger invariant failures;
- successful transaction count versus valid ledger-pair count; and
- payment/obligation capacity violations from the preflight queries.

Promotion to contract requires all of the following:

- all four trigger paths exercised or otherwise explicitly evidenced as inactive during the window;
- zero unexplained settlement conflicts, zero ledger invariant failures, zero quarantines, and zero over-capacity parents;
- Gate 1 green on the target migration; and
- an approved database backup/restore test plus the reverse-mapping eligibility check below.

## Contract deployment

Schedule a maintenance window that prevents overlapping manual remediation and deploys one application version at a time. Drain or pause new cancellation-refund initiation if the deployment platform cannot guarantee that every API instance is on the cutover version before schema contract. Do not interrupt provider verification already in progress; its terminal outcome must be delivered to the compatible settlement code first.

Immediately before deployment, re-run the preflight section and take a restorable backup. Then deploy the contract migration using the normal Prisma deployment path:

```powershell
Push-Location apps/api
& '.\node_modules\.bin\prisma.CMD' migrate deploy
if ($LASTEXITCODE -ne 0) { throw 'Refund obligation contract migration failed.' }
& '.\node_modules\.bin\prisma.CMD' generate
Pop-Location
```

The contract migration drops `refunds_bookingId_fkey`, the legacy unique `refunds_bookingId_key` index, and `refunds.bookingId`; it also adds a check that requires `cancellationRefundObligationId` when `reason LIKE 'cancellation:%'`. Confirm `20260823000000_refund_obligation_contract` is applied, the deployed application no longer reads/writes `Refund.bookingId` or `Booking.cancellationRefund`, and rerun the post-contract Gate 1 suite. A migration failure must stop promotion; restore service code compatibility first and use the rollback decision tree below rather than editing Prisma migration history.

## Rollback decision tree

### Before the contract migration

Roll back the caller deployment to the last dual-compatible build. The additive obligation, refund FK, and ledger FK columns remain intact. Re-run backfill validation and Gate 1 before resuming. No database rollback is required unless a separately approved data repair is necessary.

### After the contract migration: preferred rollback

Roll back to a compatible application release that continues to use obligations and Refund Settlement. This is the only safe rollback once an obligation has more than one linked refund transaction. Keep the contract schema and repair/forward-fix the application or migration issue.

### After the contract migration: schema reverse mapping (exception only)

Schema restoration is permitted only when the following query returns `0`. It proves that restoring the legacy unique `refunds.bookingId` cannot discard the one-obligation-to-many-transactions model:

```sql
SELECT count(*) AS obligations_not_representable_by_legacy_schema
FROM (
  SELECT "cancellationRefundObligationId"
  FROM "refunds"
  WHERE "cancellationRefundObligationId" IS NOT NULL
  GROUP BY "cancellationRefundObligationId"
  HAVING count(*) > 1
) AS multi_transaction_obligations;
```

Also re-run all applicable post-contract preflight queries (without the dropped legacy-column query), verify a current restorable backup, and obtain explicit finance/on-call approval. If any condition fails, **do not perform a schema rollback**; use the preferred forward-compatible rollback.

When eligible, execute the following in one approved transaction through the production SQL console. First test it on a restored production snapshot. The statements restore only the legacy compatibility FK/index; they never remove obligation or ledger data.

```sql
BEGIN;

ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "bookingId" TEXT;

UPDATE "refunds" r
SET "bookingId" = o."bookingId"
FROM "cancellation_refund_obligations" o
WHERE r."cancellationRefundObligationId" = o.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "refunds"
    WHERE "bookingId" IS NOT NULL
    GROUP BY "bookingId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Reverse mapping would violate legacy Refund.bookingId uniqueness';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "refunds_bookingId_key" ON "refunds"("bookingId");
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "bookings"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
```

If the constraint already exists, stop and inspect the schema rather than retrying a partial transaction. After a successful reverse mapping, deploy the matching dual-compatible application release, regenerate Prisma Client, rerun migration status, and execute Gate 1. Do not remove the contract migration directory or alter `_prisma_migrations`; record the controlled schema restoration in the change record.

## Monitoring and alerts

The Slice 1D telemetry in application code must stay PII-safe. Configure the following alerts using aggregate counts and opaque trace/correlation IDs only:

| Signal | Alert condition | Immediate response |
|---|---|---|
| Settlement conflict | Any unexplained conflict after deduplication, or a sustained increase above the established baseline for 15 minutes | Freeze promotion; compare normalized persisted facts without provider payloads. |
| Reservation rejection | Unexpected `payment_capacity` or `obligation_capacity` increase for 15 minutes | Check capacity query; pause new automated retries if an over-capacity invariant is found. |
| Backfill quarantine/mismatch | Any nonzero count | Abort contract work and follow the quarantine procedure. |
| Ledger invariant failure | Any occurrence | Page finance/on-call; stop contract rollout and do not replay or manually balance entries. |
| Settlement applied/no-op ratio | A material unexplained shift from the observation baseline for 30 minutes | Validate webhook/retry delivery behavior and idempotency correlation. |

Logs, metrics, traces, and audit metadata may include operation name, outcome class, provenance enum, duration, aggregate count, and trace/correlation ID. They must not include raw provider payloads or references, idempotency keys, payment or booking IDs, customer data, card data, PNRs, email addresses, or full error payloads.

## Cleanup eligibility

The following are explicitly **not** part of this contract migration: removing legacy amount fields (`Refund.airlineRefundAmount`, `Refund.customerRefundAmount`), renaming the physical `refunds` table, or deleting the obligation/ledger compatibility history.

Approve a later cleanup only when all conditions are met:

- the 14-day observation window and Gate 1 evidence are retained in the restricted change record;
- no supported release or rollback target reads the candidate legacy field/relation;
- the retention owner approves removal of any remaining legacy amount facts;
- restore drills prove the necessary audit, transaction, and ledger records remain interpretable; and
- a new migration has its own preflight, rollback, and financial-review approval.

Until then, preserve the physical `refunds` table and the retained legacy amount fields even though `Refund.bookingId` and `Booking.cancellationRefund` have been contracted away.
