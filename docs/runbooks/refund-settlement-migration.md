# Refund Settlement Contract Migration Runbook

This operational runbook governs Feature 019 Slice 1D: contracting the legacy direct `Refund.bookingId` / `Booking.cancellationRefund` relationship after the additive obligation migration, the backfill, and the provider-blind Refund Settlement cutover. It implements the required expand → backfill → validate → cut over → observe → contract sequence from the architecture specification and settlement contract.

The physical PostgreSQL table remains `refunds`. This change does not rename it.

---

## 1. Preflight Checks & Prerequisites

### 1.1 Safety Rules & Invariants
- Run every command first against a restored production snapshot or disposable staging database. Use zero live Stripe or Duffel credentials during verification.
- Do not run the contract migration while a backfill mismatch, quarantine, ledger invariant failure, reservation conflict spike, or unexplained settlement conflict is open.
- A successful `Refund` with a cancellation obligation must retain its exact two-entry reversal pair: `DEBIT PLATFORM_REVENUE` and `CREDIT CUSTOMER_RECEIVABLE`, both for the transaction amount and currency.
- Roll back code before rolling back schema whenever possible. The legacy one-refund-per-booking schema cannot faithfully represent an obligation that has more than one linked refund transaction.
- Treat database identifiers, Stripe/Duffel references, booking references, amounts, and audit metadata as restricted operational data. Do not paste query output into tickets, chat, dashboards, or logs.

### 1.2 Required Rollout Sequence
1. Deploy the additive migration `20260822000000_cancellation_refund_obligation_expand` and application code that can read both representations.
2. Run the restart-safe backfill and validation; resolve every quarantine before proceeding.
3. Deploy the four trigger cutovers. New cancellation refunds must reserve a transaction against an obligation and terminal outcomes must go exclusively through Refund Settlement.
4. Complete the 14-day observation window with the additive schema still present.
5. Re-run preflight immediately before deployment, take a verified database backup, deploy `20260823000000_refund_obligation_contract`, regenerate Prisma Client, and run Gate 1.
6. Keep legacy amount columns and the physical `refunds` table. Their removal or rename is a separate retention-approved cleanup.

### 1.3 Environment & Migration Status Check
Set `DATABASE_URL` through the approved deployment secret mechanism; never place a production URL in shell history, transcripts, or tickets.

```powershell
docker compose up -d

Push-Location apps/api
& '.\node_modules\.bin\prisma.CMD' migrate status
& '.\node_modules\.bin\prisma.CMD' generate
Pop-Location
```

The migration status must show the expand migration as applied and must not report divergence. Before the contract migration is deployed, it must not already report `20260823000000_refund_obligation_contract` as applied.

### 1.4 Backfill Execution (`CancellationRefundObligation`)
Run the backfill once in the approved maintenance/change window. It is restart-safe and can update/attach missing obligations and ledger links, but it does **not** exit nonzero merely because it quarantines a record.

```powershell
Push-Location apps/api
& '.\node_modules\.bin\tsx.CMD' prisma/scripts/backfill-cancellation-refund-obligations.ts
if ($LASTEXITCODE -ne 0) { throw 'Cancellation refund obligation backfill failed.' }
Pop-Location
```

Proceed only when the summary has `Errors: 0` **and** `Quarantined: 0`. A nonzero `Quarantined` count is a contract-migration abort even when the process exit code is zero.

### 1.5 Preflight Verification SQL Queries
Run each query through the approved production SQL console with `ON_ERROR_STOP` enabled. The expected result for every query is `0`. The queries return counts only.

```sql
-- 1. Legacy cancellation rows must have a canonical obligation before legacy FK is removed
SELECT count(*) AS legacy_refunds_missing_obligation
FROM "refunds"
WHERE "bookingId" IS NOT NULL
  AND "cancellationRefundObligationId" IS NULL;

-- 2. Exact contract predicate: other refund reasons remain eligible to have no obligation
SELECT count(*) AS cancellation_reason_missing_obligation
FROM "refunds"
WHERE reason LIKE 'cancellation:%'
  AND "cancellationRefundObligationId" IS NULL;

-- 3. The obligation must point at the same booking payment and use its payment currency
SELECT count(*) AS obligation_payment_or_currency_mismatch
FROM "cancellation_refund_obligations" o
JOIN "bookings" b ON b.id = o."bookingId"
JOIN "payments" p ON p.id = o."paymentId"
WHERE b."paymentId" IS DISTINCT FROM o."paymentId"
   OR upper(o.currency) <> upper(p.currency)
   OR o."totalAmount" < 0
   OR o."airlineRefundAmount" < 0;

-- 4. A refund linked to an obligation must agree with that obligation's payment and currency
SELECT count(*) AS linked_refund_mismatch
FROM "refunds" r
JOIN "cancellation_refund_obligations" o
  ON o.id = r."cancellationRefundObligationId"
WHERE r."paymentId" <> o."paymentId"
   OR upper(r.currency) <> upper(o.currency);

-- 5. Dual-Capacity Reservation Limits: Successful + active transaction capacity may never exceed either parent
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

-- 6. Duplicate Ledger Detection: Every successful transaction has exactly one balanced reversal pair
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

-- 7. Active or failed transactions must not own a reversal pair
SELECT count(*) AS non_successful_transactions_with_ledger
FROM "refunds" r
JOIN "ledger_entries" le ON le."refundTransactionId" = r.id
WHERE r.status <> 'SUCCEEDED';
```

### 1.6 Gate 1 Automated Test Verification
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

---

## 2. Mismatch Abort Conditions & Safeguards

### 2.1 Abort Triggers
Stop the rollout immediately if:
1. The backfill script reports `Errors > 0` or `Quarantined > 0`.
2. Any preflight SQL verification count is greater than `0`.
3. An over-capacity parent violation is detected on Payment or Obligation.
4. An unbalanced or duplicate ledger entry is detected.
5. A settlement conflict occurs where an incoming terminal refund state contradicts the persisted state.

### 2.2 Quarantine Procedure
1. Freeze the contract deployment immediately; leave additive schema and dual-compatible code in place.
2. Preserve a database snapshot and restricted backfill job logs. Record change ID, aggregate counts, trace/correlation IDs, and timestamps in incident ticket.
3. Strict Prohibition: Never manually attach a refund, fabricate ledger entries, alter money values, or replay provider mutations directly in the database.
4. Root Cause Classification:
   - `Booking <-> Payment` identity divergence
   - Currency or integer minor-unit conversion error
   - Dual-capacity reservation overrun
   - Ambiguous/missing ledger pair
   - Non-successful transaction with attached ledger records
5. Correct source data or migration logic in a reviewed and approved change; re-run full backfill and all 7 preflight SQL queries until all return `0`.

### 2.3 Replay Idempotency Safeguards
- All trigger paths (Inline, Webhook, Sweeper Cron, Admin) provide an idempotency key and external refund ID.
- If `settleVerifiedOutcome()` is invoked with an already-settled refund transaction ID:
  - If incoming amounts, currency, and status match the persisted record: return cached outcome immediately (`NOOP_REPLAY`).
  - If incoming data contradicts persisted facts (e.g. different amount or currency): fail closed with `SETTLEMENT_CONFLICT` and log an emergency security/audit alert.

---

## 3. Observability, Metrics & Alert Thresholds

### 3.1 Alert Threshold Table

| Signal | Alert Condition | Severity | Immediate Response |
|---|---|---|---|
| Settlement Conflict | Any unexplained conflict after deduplication, or sustained increase > 0 for 15m | P1 (Critical) | Freeze deployment; inspect normalized facts via trace ID. Do not retry automatically. |
| Reservation Rejection | Unexpected `payment_capacity` or `obligation_capacity` increase > 5 for 15m | P2 (High) | Check dual-capacity SQL query; halt automated sweeper retries if invariant violated. |
| Backfill Quarantine | Any nonzero quarantine count | P1 (Critical) | Abort contract rollout immediately; execute Section 2.2 quarantine playbook. |
| Ledger Invariant Failure | Any unbalanced reversal pair or orphan ledger entry | P1 (Critical) | Page on-call & finance engineering; halt settlement pipeline; do not manual-balance. |
| Settlement Replay Ratio Drift | `settlement_noop_replay_total` / `settlement_applied_total` > 2.0 for 30m | P3 (Medium) | Inspect webhook delivery and retry intervals for redundant trigger firing. |

### 3.2 Telemetry Invariants & Privacy
- All metrics and logs MUST use aggregate counts, status enums (`SUCCEEDED`, `FAILED`), provenance enums (`INLINE`, `WEBHOOK`, `CRON`, `ADMIN`), and opaque trace/correlation IDs.
- Strictly Prohibited in Telemetry: Card numbers, CVVs, customer names, email addresses, PNRs, raw Stripe API responses, or plain database IDs.

---

## 4. Observation Window Guidelines

### 4.1 Duration & Reset Rules
- Keep the additive schema in place for a minimum of **14 consecutive calendar days**.
- The window MUST cover at least one full scheduled refund-recovery interval where all 4 triggers have processed production traffic (or have been verified inactive).
- Window Reset Condition: Any material rollback, backfill rerun altering production rows, unresolved quarantine, or ledger alert resets the 14-day clock back to Day 0.

### 4.2 Daily Operator Review Checklist
1. Inspect `settlement_applied_total`, `settlement_noop_replay_total`, and `settlement_conflict_total` segmented by provenance.
2. Review reservation rejection logs segmented by `payment_capacity` vs `obligation_capacity`.
3. Execute SQL Preflight Query #5 (capacity limits) and Query #6 (duplicate ledger detection).
4. Verify 100% correlation between successful `Refund` rows and exactly two `LedgerEntry` rows.

### 4.3 Promotion Criteria to Contract
All of the following must be green before deploying `20260823000000_refund_obligation_contract`:
- 14 days completed with zero resets.
- Zero unexplained settlement conflicts, zero ledger invariant failures, zero quarantines.
- Gate 1 test suite passes with 0 failures.
- Restorable database backup taken within 1 hour prior to contract deployment.
- Reverse-mapping eligibility query (Section 5.3) returns `0`.

---

## 5. Rollback Procedures & Exact Commit Boundaries

### 5.1 Exact Commit Boundaries
- **Expand Migration & Backfill Baseline**: Commit `46a518f` (`feat(refund): contract migration and runbook for cancellation refund obligations (Slice 1D Batch 1)`).
- **Contract Migration & Gate 1 Sign-Off**: Commit `4f9cfb1` (`docs(refund): record Slice 1D completion and Gate 1 sign-off`).

### 5.2 Rollback Before Contract Migration
If issues occur while still on the additive schema:
1. Roll back the application container to the previous dual-compatible release (at commit `46a518f`).
2. Leave additive schema (`CancellationRefundObligation`, `refundTransactionId`) intact in PostgreSQL.
3. No database rollback is required. Re-run preflight verification and Gate 1 suite.

### 5.3 Rollback After Contract Migration: Preferred Rollback (Code First)
Roll back application code to a version that uses `CancellationRefundObligation` and `RefundSettlementService` without relying on legacy `Refund.bookingId`. Keep the contract schema in place. This is the only safe procedure once an obligation has multiple linked refund transactions.

### 5.4 Rollback After Contract Migration: Schema Reverse Mapping (Emergency Exception Only)
Schema restoration is permitted ONLY when the following query returns `0`:

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

If the count is `0`, execute the following transaction in the approved SQL console:

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

Deploy the matching dual-compatible application release, regenerate Prisma Client, and execute Gate 1 suite.

---

## 6. Post-Rollout Cleanup Eligibility

### 6.1 Retained Legacy Fields
The following fields and tables are intentionally preserved post-contract and are NOT eligible for immediate deletion:
- Physical table `refunds` (remains the permanent home for refund transactions).
- Legacy amount columns: `Refund.airlineRefundAmount`, `Refund.customerRefundAmount`.

### 6.2 Cleanup Eligibility Criteria
Approve future deletion of legacy amount fields only when:
1. The 14-day observation window and Gate 1 verification have completed with zero incidents.
2. Static audit verifies zero application code reads or writes `Refund.airlineRefundAmount` or `Refund.customerRefundAmount`.
3. Financial retention compliance officer formally approves deprecation of legacy amount columns.
4. Database restore drills confirm historic audit logs and ledger entries remain fully interpretable without legacy columns.
5. A dedicated contract cleanup migration is authored, reviewed, and approved with its own independent preflight and rollback plan.
