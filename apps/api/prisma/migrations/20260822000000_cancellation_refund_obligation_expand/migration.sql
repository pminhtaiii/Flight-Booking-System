-- CreateTable
CREATE TABLE "cancellation_refund_obligations" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "airlineRefundAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cancellation_refund_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cancellation_refund_obligations_bookingId_key" ON "cancellation_refund_obligations"("bookingId");

-- CreateIndex
CREATE INDEX "cancellation_refund_obligations_paymentId_idx" ON "cancellation_refund_obligations"("paymentId");

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN "cancellationRefundObligationId" TEXT;

-- CreateIndex
CREATE INDEX "refunds_cancellationRefundObligationId_idx" ON "refunds"("cancellationRefundObligationId");

-- AlterTable
ALTER TABLE "ledger_entries" ADD COLUMN "refundTransactionId" TEXT;

-- CreateIndex
CREATE INDEX "ledger_entries_refundTransactionId_idx" ON "ledger_entries"("refundTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_refundTransactionId_accountId_entryType_key" ON "ledger_entries"("refundTransactionId", "accountId", "entryType");

-- AddForeignKey
ALTER TABLE "cancellation_refund_obligations" ADD CONSTRAINT "cancellation_refund_obligations_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_refund_obligations" ADD CONSTRAINT "cancellation_refund_obligations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_cancellationRefundObligationId_fkey" FOREIGN KEY ("cancellationRefundObligationId") REFERENCES "cancellation_refund_obligations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_refundTransactionId_fkey" FOREIGN KEY ("refundTransactionId") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
