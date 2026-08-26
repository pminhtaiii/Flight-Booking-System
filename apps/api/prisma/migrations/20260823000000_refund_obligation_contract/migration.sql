-- Contract the cancellation-refund model only after the expand/backfill observation window.
-- Any mismatch aborts the whole transaction before the legacy relation is removed.
BEGIN;

DO $$
DECLARE
  legacy_unlinked_count integer := 0;
  cancellation_unlinked_count integer := 0;
  obligation_fact_mismatch_count integer := 0;
  linked_refund_mismatch_count integer := 0;
  over_capacity_parent_count integer := 0;
  invalid_successful_ledger_pair_count integer := 0;
  non_successful_ledger_link_count integer := 0;
  has_booking_id boolean;
BEGIN
  SELECT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'refunds'
      AND column_name = 'bookingId'
  ) INTO has_booking_id;

  IF has_booking_id THEN
    EXECUTE '
      SELECT COUNT(*)
      FROM "refunds"
      WHERE "bookingId" IS NOT NULL
        AND "cancellationRefundObligationId" IS NULL
    ' INTO legacy_unlinked_count;

    IF legacy_unlinked_count > 0 THEN
      RAISE EXCEPTION
        'Refund obligation contract preflight failed: % legacy booking-linked refund(s) are not backfilled',
        legacy_unlinked_count
        USING ERRCODE = 'P0001',
              HINT = 'Run and resolve the cancellation-refund obligation backfill before retrying this migration.';
    END IF;
  END IF;

  SELECT COUNT(*)
  INTO cancellation_unlinked_count
  FROM "refunds"
  WHERE COALESCE("reason", '') LIKE 'cancellation:%'
    AND "cancellationRefundObligationId" IS NULL;

  IF cancellation_unlinked_count > 0 THEN
    RAISE EXCEPTION
      'Refund obligation contract preflight failed: % cancellation refund transaction(s) have no obligation',
      cancellation_unlinked_count
      USING ERRCODE = 'P0001',
            HINT = 'Quarantine or backfill every cancellation refund before retrying this migration.';
  END IF;

  -- The canonical obligation must agree with both of its financial parents.
  -- The Booking comparison is deliberately retained even though the legacy
  -- Refund.bookingId relation is about to be removed.
  SELECT COUNT(*)
  INTO obligation_fact_mismatch_count
  FROM "cancellation_refund_obligations" AS obligation
  LEFT JOIN "bookings" AS booking
    ON booking."id" = obligation."bookingId"
  LEFT JOIN "payments" AS payment
    ON payment."id" = obligation."paymentId"
  WHERE booking."id" IS NULL
    OR payment."id" IS NULL
    OR booking."paymentId" IS DISTINCT FROM obligation."paymentId"
    OR UPPER(obligation."currency") <> UPPER(payment."currency")
    OR obligation."totalAmount" < 0
    OR obligation."airlineRefundAmount" < 0;

  IF obligation_fact_mismatch_count > 0 THEN
    RAISE EXCEPTION
      'Refund obligation contract preflight failed: % obligation(s) have mismatched booking, payment, currency, or amount facts',
      obligation_fact_mismatch_count
      USING ERRCODE = 'P0001',
            HINT = 'Repair the canonical obligation facts before retrying this migration.';
  END IF;

  SELECT COUNT(*)
  INTO linked_refund_mismatch_count
  FROM "refunds" AS refund
  LEFT JOIN "cancellation_refund_obligations" AS obligation
    ON obligation."id" = refund."cancellationRefundObligationId"
  WHERE refund."cancellationRefundObligationId" IS NOT NULL
    AND (
      obligation."id" IS NULL
      OR obligation."paymentId" <> refund."paymentId"
      OR UPPER(obligation."currency") <> UPPER(refund."currency")
    );

  IF linked_refund_mismatch_count > 0 THEN
    RAISE EXCEPTION
      'Refund obligation contract preflight failed: % refund obligation link(s) have mismatched payment or currency facts',
      linked_refund_mismatch_count
      USING ERRCODE = 'P0001',
            HINT = 'Quarantine the mismatches and repair the backfill before retrying this migration.';
  END IF;

  WITH payment_totals AS (
    SELECT payment."id", payment."amount",
      COALESCE(SUM(refund."amount") FILTER (WHERE refund."status" = 'SUCCEEDED'), 0) AS succeeded,
      COALESCE(SUM(refund."amount") FILTER (
        WHERE refund."status" IN ('REFUND_PENDING', 'REFUND_PROCESSING', 'REFUND_RETRY_SCHEDULED')
      ), 0) AS active
    FROM "payments" AS payment
    LEFT JOIN "refunds" AS refund ON refund."paymentId" = payment."id"
    GROUP BY payment."id", payment."amount"
  ), obligation_totals AS (
    SELECT obligation."id", obligation."totalAmount",
      COALESCE(SUM(refund."amount") FILTER (WHERE refund."status" = 'SUCCEEDED'), 0) AS succeeded,
      COALESCE(SUM(refund."amount") FILTER (
        WHERE refund."status" IN ('REFUND_PENDING', 'REFUND_PROCESSING', 'REFUND_RETRY_SCHEDULED')
      ), 0) AS active
    FROM "cancellation_refund_obligations" AS obligation
    LEFT JOIN "refunds" AS refund
      ON refund."cancellationRefundObligationId" = obligation."id"
    GROUP BY obligation."id", obligation."totalAmount"
  )
  SELECT
    (SELECT COUNT(*) FROM payment_totals WHERE succeeded + active > "amount") +
    (SELECT COUNT(*) FROM obligation_totals WHERE succeeded + active > "totalAmount")
  INTO over_capacity_parent_count;

  IF over_capacity_parent_count > 0 THEN
    RAISE EXCEPTION
      'Refund obligation contract preflight failed: % payment or obligation parent(s) exceed refund capacity',
      over_capacity_parent_count
      USING ERRCODE = 'P0001',
            HINT = 'Resolve over-capacity refund transactions before retrying this migration.';
  END IF;

  WITH linked_ledger AS (
    SELECT refund."id",
      COUNT(entry."id") AS entry_count,
      COUNT(*) FILTER (
        WHERE entry."entryType" = 'DEBIT'
          AND entry."accountId" = 'PLATFORM_REVENUE'
          AND entry."amount" = refund."amount"
          AND UPPER(entry."currency") = UPPER(refund."currency")
      ) AS debit_count,
      COUNT(*) FILTER (
        WHERE entry."entryType" = 'CREDIT'
          AND entry."accountId" = 'CUSTOMER_RECEIVABLE'
          AND entry."amount" = refund."amount"
          AND UPPER(entry."currency") = UPPER(refund."currency")
      ) AS credit_count
    FROM "refunds" AS refund
    LEFT JOIN "ledger_entries" AS entry ON entry."refundTransactionId" = refund."id"
    WHERE refund."status" = 'SUCCEEDED'
    GROUP BY refund."id", refund."amount", refund."currency"
  )
  SELECT COUNT(*)
  INTO invalid_successful_ledger_pair_count
  FROM linked_ledger
  WHERE entry_count <> 2 OR debit_count <> 1 OR credit_count <> 1;

  IF invalid_successful_ledger_pair_count > 0 THEN
    RAISE EXCEPTION
      'Refund obligation contract preflight failed: % successful refund transaction(s) lack an exact reversal ledger pair',
      invalid_successful_ledger_pair_count
      USING ERRCODE = 'P0001',
            HINT = 'Repair the successful-refund ledger links before retrying this migration.';
  END IF;

  SELECT COUNT(*)
  INTO non_successful_ledger_link_count
  FROM "refunds" AS refund
  JOIN "ledger_entries" AS entry ON entry."refundTransactionId" = refund."id"
  WHERE refund."status" <> 'SUCCEEDED';

  IF non_successful_ledger_link_count > 0 THEN
    RAISE EXCEPTION
      'Refund obligation contract preflight failed: % non-successful refund transaction ledger link(s) exist',
      non_successful_ledger_link_count
      USING ERRCODE = 'P0001',
            HINT = 'Remove invalid active or failed refund ledger links before retrying this migration.';
  END IF;
END
$$;

ALTER TABLE "refunds"
  DROP CONSTRAINT IF EXISTS "refunds_cancellation_refund_obligation_required";

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_cancellation_refund_obligation_required"
  CHECK (
    -- Runtime cancellation transactions use the normalized `cancellation:`
    -- discriminator. Other/direct refund reasons intentionally remain nullable.
    COALESCE("reason", '') NOT LIKE 'cancellation:%'
    OR "cancellationRefundObligationId" IS NOT NULL
  );

ALTER TABLE "refunds"
  DROP CONSTRAINT IF EXISTS "refunds_bookingId_fkey";

DROP INDEX IF EXISTS "refunds_bookingId_key";

ALTER TABLE "refunds"
  DROP COLUMN IF EXISTS "bookingId";

COMMIT;
