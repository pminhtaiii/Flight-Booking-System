-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'CHARGEBACK_LOST');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REFUND_PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundTriggerType" AS ENUM ('ADMIN', 'SYSTEM_AUTOMATED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "PaymentEventSource" AS ENUM ('WEBHOOK', 'API', 'CRON', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PaymentMethodStatus" AS ENUM ('ACTIVE', 'DETACHED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BookingIntentStatus" ADD VALUE 'AWAITING_PAYMENT';
ALTER TYPE "BookingIntentStatus" ADD VALUE 'PAYMENT_EXHAUSTED';
ALTER TYPE "BookingIntentStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "BookingIntentStatus" ADD VALUE 'CONFIRMED';

-- AlterTable
ALTER TABLE "booking_intents" ADD COLUMN     "paymentAttemptCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "stripeCustomerId" TEXT;

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "bookingIntentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "idempotencyKeyId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paymentMethodType" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "preDisputeStatus" "PaymentStatus",
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "requestPath" TEXT NOT NULL,
    "requestParams" JSONB,
    "responseCode" INTEGER,
    "responseBody" JSONB,
    "recoveryPoint" TEXT NOT NULL DEFAULT 'started',
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" BIGSERIAL NOT NULL,
    "paymentId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "previousStatus" "PaymentStatus" NOT NULL,
    "newStatus" "PaymentStatus" NOT NULL,
    "amount" INTEGER,
    "source" "PaymentEventSource" NOT NULL,
    "stripeEventId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "idempotencyKeyId" TEXT NOT NULL,
    "stripeRefundId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "triggerType" "RefundTriggerType" NOT NULL,
    "triggeredByUserId" TEXT,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "status" "RefundStatus" NOT NULL DEFAULT 'REFUND_PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "stripePaymentMethodId" TEXT NOT NULL,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "userId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "savedWithConsent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "PaymentMethodStatus" NOT NULL DEFAULT 'ACTIVE',
    "expMonth" INTEGER,
    "expYear" INTEGER,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_stripePaymentIntentId_key" ON "payments"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "payments_stripeCustomerId_idx" ON "payments"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_bookingIntentId_attemptNumber_key" ON "payments"("bookingIntentId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_key" ON "idempotency_keys"("key");

-- CreateIndex
CREATE INDEX "idempotency_keys_customerId_idx" ON "idempotency_keys"("customerId");

-- CreateIndex
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_stripeEventId_key" ON "payment_events"("stripeEventId");

-- CreateIndex
CREATE INDEX "payment_events_paymentId_createdAt_idx" ON "payment_events"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_events_eventType_idx" ON "payment_events"("eventType");

-- CreateIndex
CREATE INDEX "ledger_entries_paymentId_idx" ON "ledger_entries"("paymentId");

-- CreateIndex
CREATE INDEX "ledger_entries_transactionId_idx" ON "ledger_entries"("transactionId");

-- CreateIndex
CREATE INDEX "ledger_entries_accountId_idx" ON "ledger_entries"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_stripeRefundId_key" ON "refunds"("stripeRefundId");

-- CreateIndex
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

-- CreateIndex
CREATE INDEX "refunds_status_idx" ON "refunds"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_stripePaymentMethodId_key" ON "payment_methods"("stripePaymentMethodId");

-- CreateIndex
CREATE INDEX "payment_methods_stripeCustomerId_idx" ON "payment_methods"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "payment_methods_userId_idx" ON "payment_methods"("userId");

-- CreateIndex
CREATE INDEX "payments_idempotencyKeyId_idx" ON "payments"("idempotencyKeyId");

-- CreateIndex
CREATE INDEX "refunds_idempotencyKeyId_idx" ON "refunds"("idempotencyKeyId");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bookingIntentId_fkey" FOREIGN KEY ("bookingIntentId") REFERENCES "booking_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_idempotencyKeyId_fkey" FOREIGN KEY ("idempotencyKeyId") REFERENCES "idempotency_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_idempotencyKeyId_fkey" FOREIGN KEY ("idempotencyKeyId") REFERENCES "idempotency_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Custom Constraints
ALTER TABLE "payments" ADD CONSTRAINT "chk_payment_attempt_number" CHECK ("attemptNumber" IN (1, 2));
ALTER TABLE "payments" ADD CONSTRAINT "chk_payment_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "ledger_entries" ADD CONSTRAINT "chk_ledger_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "refunds" ADD CONSTRAINT "chk_refund_amount_positive" CHECK ("amount" > 0);
CREATE UNIQUE INDEX idx_one_default_per_user ON "payment_methods" ("userId") WHERE "isDefault" = true;
