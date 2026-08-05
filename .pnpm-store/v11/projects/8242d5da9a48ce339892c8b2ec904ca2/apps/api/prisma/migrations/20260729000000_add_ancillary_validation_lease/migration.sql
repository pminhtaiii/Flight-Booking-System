ALTER TABLE "ancillary_selections"
  ADD COLUMN "validationLeaseToken" TEXT,
  ADD COLUMN "validationLeaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "ancillary_selections"
  ADD CONSTRAINT "ancillary_selections_validation_lease_pair_check"
  CHECK (
    ("validationLeaseToken" IS NULL AND "validationLeaseExpiresAt" IS NULL)
    OR
    ("validationLeaseToken" IS NOT NULL AND "validationLeaseExpiresAt" IS NOT NULL)
  );

CREATE INDEX "ancillary_selections_validationLeaseExpiresAt_idx"
  ON "ancillary_selections"("validationLeaseExpiresAt");
