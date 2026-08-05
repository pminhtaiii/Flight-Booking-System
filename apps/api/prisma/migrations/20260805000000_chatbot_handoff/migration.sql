-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN     "contentAuthTag" TEXT,
ADD COLUMN     "contentCiphertext" TEXT,
ADD COLUMN     "contentKeyVersion" INTEGER,
ADD COLUMN     "contentNonce" TEXT,
ALTER COLUMN "content" DROP NOT NULL;

-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "titleAuthTag" TEXT,
ADD COLUMN     "titleCiphertext" TEXT,
ADD COLUMN     "titleKeyVersion" INTEGER,
ADD COLUMN     "titleNonce" TEXT;

-- CreateTable
CREATE TABLE "booking_agent_projections" (
    "bookingId" TEXT NOT NULL,
    "agentReference" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "airline" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "departureAt" TIMESTAMP(3) NOT NULL,
    "arrivalAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "stopCount" INTEGER NOT NULL,
    "flightNumber" TEXT,
    "baggageSummary" TEXT,
    "refundable" BOOLEAN,
    "changeable" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_agent_projections_pkey" PRIMARY KEY ("bookingId")
);

-- CreateTable
CREATE TABLE "chat_handoffs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatSessionId" TEXT NOT NULL,
    "flightOfferId" TEXT NOT NULL,
    "duffelOfferIdHash" TEXT NOT NULL,
    "snapshotVersion" INTEGER NOT NULL,
    "snapshotFingerprint" TEXT NOT NULL,
    "selectionAttestationHash" TEXT NOT NULL,
    "selectedOfferIndex" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenKeyVersion" INTEGER NOT NULL,
    "idempotencyKeyHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "claimTokenHash" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "claimRecoverAfter" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "consumedByBookingIntentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_agent_projections_agentReference_key" ON "booking_agent_projections"("agentReference");

-- CreateIndex
CREATE UNIQUE INDEX "chat_handoffs_tokenHash_key" ON "chat_handoffs"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "chat_handoffs_idempotencyKeyHash_key" ON "chat_handoffs"("idempotencyKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "chat_handoffs_consumedByBookingIntentId_key" ON "chat_handoffs"("consumedByBookingIntentId");

-- CreateIndex
CREATE INDEX "chat_handoffs_userId_chatSessionId_expiresAt_idx" ON "chat_handoffs"("userId", "chatSessionId", "expiresAt");

-- CreateIndex
CREATE INDEX "chat_handoffs_flightOfferId_expiresAt_idx" ON "chat_handoffs"("flightOfferId", "expiresAt");

-- CreateIndex
CREATE INDEX "chat_handoffs_expiresAt_consumedAt_idx" ON "chat_handoffs"("expiresAt", "consumedAt");

-- CreateIndex
CREATE INDEX "chat_handoffs_claimExpiresAt_consumedAt_idx" ON "chat_handoffs"("claimExpiresAt", "consumedAt");

-- AddForeignKey
ALTER TABLE "booking_agent_projections" ADD CONSTRAINT "booking_agent_projections_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_handoffs" ADD CONSTRAINT "chat_handoffs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_handoffs" ADD CONSTRAINT "chat_handoffs_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_handoffs" ADD CONSTRAINT "chat_handoffs_flightOfferId_fkey" FOREIGN KEY ("flightOfferId") REFERENCES "flight_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_handoffs" ADD CONSTRAINT "chat_handoffs_consumedByBookingIntentId_fkey" FOREIGN KEY ("consumedByBookingIntentId") REFERENCES "booking_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddCheckConstraints
ALTER TABLE "chat_handoffs" ADD CONSTRAINT "chat_handoffs_selectedOfferIndex_check" CHECK ("selectedOfferIndex" > 0);
ALTER TABLE "chat_handoffs" ADD CONSTRAINT "chat_handoffs_snapshotVersion_check" CHECK ("snapshotVersion" > 0);
ALTER TABLE "chat_handoffs" ADD CONSTRAINT "chat_handoffs_tokenKeyVersion_check" CHECK ("tokenKeyVersion" > 0);

