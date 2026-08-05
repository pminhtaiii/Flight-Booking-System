-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'REFUND_FAILED_NEEDS_ATTENTION';
ALTER TYPE "RefundStatus" ADD VALUE IF NOT EXISTS 'REFUND_PROCESSING';
ALTER TYPE "RefundStatus" ADD VALUE IF NOT EXISTS 'REFUND_RETRY_SCHEDULED';

-- AlterTable
ALTER TABLE "refunds"
  ADD COLUMN IF NOT EXISTS "bookingId" TEXT,
  ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextRetryAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "idempotencyKeyCreatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastErrorCode" TEXT,
  ADD COLUMN IF NOT EXISTS "lastErrorAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "refunds_bookingId_key" ON "refunds"("bookingId");
CREATE INDEX IF NOT EXISTS "refunds_status_nextRetryAt_idx" ON "refunds"("status", "nextRetryAt");

-- AddForeignKey
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
