-- AlterEnum: Add USER variant to RefundTriggerType to support non-admin self-service refunds
ALTER TYPE "RefundTriggerType" ADD VALUE IF NOT EXISTS 'USER';


-- We replace existing BookingStatus values with the new lifecycle-based values.
-- The old enum did not power any active data (booking records were cleared by db reset).
BEGIN;
DO $$ BEGIN
  -- Remove old BookingStatus type if it exists, then recreate
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BookingStatus') THEN
    -- BookingStatus enum was previously defined; alter to new values
    -- Safe because DB was reset before this migration runs
    NULL;
  END IF;
END $$;

-- Drop old BookingStatus enum values and recreate with new lifecycle values
-- Note: PostgreSQL does not support DROP VALUE from enum, so we use a workaround:
--   1. Rename old type
--   2. Create new type
--   3. Update any columns using it
--   4. Drop old type
-- Since this enum is freshly used only in the new bookings table (created below),
-- we can safely drop and recreate.
ALTER TYPE "BookingStatus" RENAME TO "BookingStatus_old";
CREATE TYPE "BookingStatus" AS ENUM ('PROCESSING', 'CONFIRMED', 'FAILED', 'COMPLETED');
DROP TYPE "BookingStatus_old";

-- CreateEnum
CREATE TYPE "BookingFailureReason" AS ENUM ('OFFER_EXPIRED', 'PRICE_CHANGED', 'BOOKING_TIMEOUT', 'CAPTURE_FAILED', 'SYSTEM_ERROR');

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookingIntentId" TEXT NOT NULL,
    "paymentId" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'PROCESSING',
    "failureReason" "BookingFailureReason",
    "pnrReference" TEXT,
    "duffelOrderId" TEXT,
    "flightSnapshot" JSONB,
    "passengerSnapshot" JSONB,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "departureAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_bookingIntentId_key" ON "bookings"("bookingIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_paymentId_key" ON "bookings"("paymentId");

-- CreateIndex
CREATE INDEX "bookings_userId_idx" ON "bookings"("userId");

-- CreateIndex
CREATE INDEX "bookings_status_idx" ON "bookings"("status");

-- CreateIndex
CREATE INDEX "bookings_userId_status_idx" ON "bookings"("userId", "status");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_bookingIntentId_fkey" FOREIGN KEY ("bookingIntentId") REFERENCES "booking_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
