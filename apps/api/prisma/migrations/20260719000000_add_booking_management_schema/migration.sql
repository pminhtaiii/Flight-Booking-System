-- AlterEnum: Add USER variant to RefundTriggerType to support non-admin self-service refunds
ALTER TYPE "RefundTriggerType" ADD VALUE IF NOT EXISTS 'USER';


-- AlterEnum: replace old BookingStatus values with lifecycle states.
-- The previous migration (20260701101204_agent_tools) creates BookingStatus and a
-- bookings table typed against it. We must drop that table first so PostgreSQL
-- will allow DROP TYPE on BookingStatus_old. DROP ... CASCADE removes the dependent
-- indexes and FK constraints along with the table.
DROP TABLE IF EXISTS "bookings" CASCADE;

-- PostgreSQL cannot DROP VALUE from an enum, so rename → recreate → drop old.
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
CREATE INDEX "bookings_userId_status_idx" ON "bookings"("userId", "status");

-- CreateIndex
CREATE INDEX "bookings_departureAt_idx" ON "bookings"("departureAt");

-- CreateIndex
CREATE INDEX "bookings_status_createdAt_idx" ON "bookings"("status", "createdAt");

-- CreateIndex
CREATE INDEX "bookings_status_departureAt_idx" ON "bookings"("status", "departureAt");

-- AddForeignKey (ON DELETE CASCADE matches schema.prisma onDelete: Cascade)
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (ON DELETE CASCADE matches schema.prisma onDelete: Cascade)
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_bookingIntentId_fkey" FOREIGN KEY ("bookingIntentId") REFERENCES "booking_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (ON DELETE SET NULL matches schema.prisma onDelete: SetNull)
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

