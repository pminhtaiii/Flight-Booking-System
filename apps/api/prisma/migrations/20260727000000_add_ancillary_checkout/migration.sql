CREATE TYPE "AncillaryStatus" AS ENUM ('EMPTY', 'DRAFT_COMMITTED', 'VALIDATED', 'STALE');
CREATE TYPE "AncillarySelectionStatus" AS ENUM ('DRAFT_COMMITTED', 'VALIDATED', 'STALE', 'PAYMENT_BOUND');
CREATE TYPE "BaggageType" AS ENUM ('CHECKED', 'CARRY_ON');
CREATE TYPE "WeightUnit" AS ENUM ('KG', 'LB');

ALTER TABLE "booking_intents"
  ADD COLUMN "ancillaryVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "currentAncillarySelectionId" TEXT,
  ADD COLUMN "ancillaryStatus" "AncillaryStatus" NOT NULL DEFAULT 'EMPTY',
  ADD COLUMN "ancillaryCurrency" VARCHAR(3),
  ADD COLUMN "seatTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "baggageTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "ancillaryTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "validatedTotal" DECIMAL(10,2),
  ADD COLUMN "ancillariesValidatedAt" TIMESTAMP(3);

ALTER TABLE "booking_intent_passengers" ADD COLUMN "duffelPassengerId" TEXT;

CREATE TABLE "ancillary_selections" (
  "id" TEXT NOT NULL,
  "bookingIntentId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "AncillarySelectionStatus" NOT NULL DEFAULT 'DRAFT_COMMITTED',
  "currency" VARCHAR(3) NOT NULL,
  "seatTotal" DECIMAL(10,2) NOT NULL,
  "baggageTotal" DECIMAL(10,2) NOT NULL,
  "total" DECIMAL(10,2) NOT NULL,
  "catalogFingerprint" TEXT NOT NULL,
  "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validatedBaseAmount" DECIMAL(10,2),
  "validatedGrandTotal" DECIMAL(10,2),
  "validatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ancillary_selections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "seat_selections" (
  "id" TEXT NOT NULL,
  "ancillarySelectionId" TEXT NOT NULL,
  "intentPassengerId" TEXT NOT NULL,
  "duffelPassengerId" TEXT NOT NULL,
  "segmentId" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "seatDesignator" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "seat_selections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "baggage_selections" (
  "id" TEXT NOT NULL,
  "ancillarySelectionId" TEXT NOT NULL,
  "intentPassengerId" TEXT NOT NULL,
  "duffelPassengerId" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "type" "BaggageType" NOT NULL,
  "weightValue" INTEGER,
  "weightUnit" "WeightUnit",
  "quantity" INTEGER NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "baggage_selections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "baggage_selection_segments" (
  "baggageSelectionId" TEXT NOT NULL,
  "segmentId" TEXT NOT NULL,
  CONSTRAINT "baggage_selection_segments_pkey" PRIMARY KEY ("baggageSelectionId", "segmentId")
);

ALTER TABLE "payments"
  ADD COLUMN "ancillarySelectionId" TEXT,
  ADD COLUMN "ancillarySelectionVersion" INTEGER;

CREATE UNIQUE INDEX "ancillary_selections_bookingIntentId_version_key" ON "ancillary_selections"("bookingIntentId", "version");
CREATE UNIQUE INDEX "ancillary_selections_id_bookingIntentId_version_key" ON "ancillary_selections"("id", "bookingIntentId", "version");
CREATE INDEX "ancillary_selections_bookingIntentId_idx" ON "ancillary_selections"("bookingIntentId");
CREATE UNIQUE INDEX "booking_intents_currentAncillarySelectionId_key" ON "booking_intents"("currentAncillarySelectionId");
CREATE INDEX "booking_intent_passengers_intentId_duffelPassengerId_idx" ON "booking_intent_passengers"("intentId", "duffelPassengerId");
CREATE UNIQUE INDEX "seat_selections_ancillarySelectionId_intentPassengerId_segmentId_key" ON "seat_selections"("ancillarySelectionId", "intentPassengerId", "segmentId");
CREATE UNIQUE INDEX "seat_selections_ancillarySelectionId_segmentId_serviceId_key" ON "seat_selections"("ancillarySelectionId", "segmentId", "serviceId");
CREATE UNIQUE INDEX "baggage_selections_ancillarySelectionId_intentPassengerId_serviceId_key" ON "baggage_selections"("ancillarySelectionId", "intentPassengerId", "serviceId");
CREATE INDEX "payments_ancillarySelectionId_idx" ON "payments"("ancillarySelectionId");

ALTER TABLE "booking_intents" ADD CONSTRAINT "booking_intents_currentAncillarySelectionId_fkey" FOREIGN KEY ("currentAncillarySelectionId") REFERENCES "ancillary_selections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ancillary_selections" ADD CONSTRAINT "ancillary_selections_bookingIntentId_fkey" FOREIGN KEY ("bookingIntentId") REFERENCES "booking_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seat_selections" ADD CONSTRAINT "seat_selections_ancillarySelectionId_fkey" FOREIGN KEY ("ancillarySelectionId") REFERENCES "ancillary_selections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "baggage_selections" ADD CONSTRAINT "baggage_selections_ancillarySelectionId_fkey" FOREIGN KEY ("ancillarySelectionId") REFERENCES "ancillary_selections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "baggage_selection_segments" ADD CONSTRAINT "baggage_selection_segments_baggageSelectionId_fkey" FOREIGN KEY ("baggageSelectionId") REFERENCES "baggage_selections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_ancillary_selection_binding_fkey" FOREIGN KEY ("ancillarySelectionId", "bookingIntentId", "ancillarySelectionVersion") REFERENCES "ancillary_selections"("id", "bookingIntentId", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "booking_intents" ADD CONSTRAINT "booking_intents_ancillaryVersion_check" CHECK ("ancillaryVersion" >= 0);
ALTER TABLE "booking_intents" ADD CONSTRAINT "booking_intents_ancillaryCurrency_check" CHECK ("ancillaryCurrency" IS NULL OR "ancillaryCurrency" ~ '^[A-Z]{3}$');
ALTER TABLE "ancillary_selections" ADD CONSTRAINT "ancillary_selections_version_check" CHECK ("version" > 0);
ALTER TABLE "ancillary_selections" ADD CONSTRAINT "ancillary_selections_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "seat_selections" ADD CONSTRAINT "seat_selections_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "baggage_selections" ADD CONSTRAINT "baggage_selections_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "baggage_selections" ADD CONSTRAINT "baggage_selections_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payments" ADD CONSTRAINT "payments_ancillary_selection_pair_check" CHECK (("ancillarySelectionId" IS NULL AND "ancillarySelectionVersion" IS NULL) OR ("ancillarySelectionId" IS NOT NULL AND "ancillarySelectionVersion" IS NOT NULL));
