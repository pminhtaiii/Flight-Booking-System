-- CreateEnum
CREATE TYPE "BookingIntentStatus" AS ENUM ('PENDING', 'EXPIRED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "PassengerType" AS ENUM ('ADULT', 'CHILD', 'INFANT');

-- CreateTable
CREATE TABLE "booking_intents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "flightOfferId" TEXT,
    "duffelOfferId" TEXT NOT NULL,
    "status" "BookingIntentStatus" NOT NULL DEFAULT 'PENDING',
    "originalPrice" DECIMAL(10,2) NOT NULL,
    "confirmedPrice" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "priceChanged" BOOLEAN NOT NULL DEFAULT false,
    "pricedAt" TIMESTAMP(3) NOT NULL,
    "origin" VARCHAR(3) NOT NULL,
    "destination" VARCHAR(3) NOT NULL,
    "departureDate" DATE NOT NULL,
    "returnDate" DATE,
    "cabinClass" TEXT NOT NULL DEFAULT 'economy',
    "adults" INTEGER NOT NULL,
    "children" INTEGER NOT NULL DEFAULT 0,
    "infants" INTEGER NOT NULL DEFAULT 0,
    "rawOfferSnapshot" JSONB NOT NULL,
    "intentExpiresAt" TIMESTAMP(3) NOT NULL,
    "offerExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_intent_passengers" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "PassengerType" NOT NULL,
    "givenName" TEXT NOT NULL,
    "familyName" TEXT NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "gender" TEXT NOT NULL,
    "nationality" VARCHAR(2),
    "passportNumber" TEXT,
    "passportExpiry" TEXT,
    "travelerProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_intent_passengers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "booking_intents_userId_idx" ON "booking_intents"("userId");

-- CreateIndex
CREATE INDEX "booking_intents_userId_status_idx" ON "booking_intents"("userId", "status");

-- CreateIndex
CREATE INDEX "booking_intents_status_intentExpiresAt_idx" ON "booking_intents"("status", "intentExpiresAt");

-- CreateIndex
CREATE INDEX "booking_intents_status_updatedAt_idx" ON "booking_intents"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "booking_intent_passengers_intentId_idx" ON "booking_intent_passengers"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "booking_intent_passengers_intentId_position_key" ON "booking_intent_passengers"("intentId", "position");

-- CreateIndex
CREATE INDEX "booking_intent_passengers_travelerProfileId_idx" ON "booking_intent_passengers"("travelerProfileId");

-- AddForeignKey
ALTER TABLE "booking_intents" ADD CONSTRAINT "booking_intents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_intents" ADD CONSTRAINT "booking_intents_flightOfferId_fkey" FOREIGN KEY ("flightOfferId") REFERENCES "flight_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_intent_passengers" ADD CONSTRAINT "booking_intent_passengers_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "booking_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_intent_passengers" ADD CONSTRAINT "booking_intent_passengers_travelerProfileId_fkey" FOREIGN KEY ("travelerProfileId") REFERENCES "traveler_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;