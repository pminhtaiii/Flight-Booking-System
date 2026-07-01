-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDED');

-- CreateTable
CREATE TABLE "traveler_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seatPreference" TEXT,
    "classPreference" TEXT,
    "preferredAirlines" TEXT[],
    "blacklistedAirlines" TEXT[],
    "dietaryNeeds" TEXT,
    "nationality" TEXT,
    "passportNumber" TEXT,
    "passportExpiry" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "traveler_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pnrCode" TEXT,
    "eTicketNumber" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "airline" TEXT NOT NULL,
    "flightNumber" TEXT NOT NULL,
    "origin" VARCHAR(3) NOT NULL,
    "destination" VARCHAR(3) NOT NULL,
    "departureTime" TIMESTAMP(3) NOT NULL,
    "arrivalTime" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL,
    "stops" INTEGER NOT NULL DEFAULT 0,
    "fareClass" TEXT,
    "price" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "passengers" INTEGER NOT NULL DEFAULT 1,
    "baggageAllowance" TEXT,
    "paymentReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "traveler_profiles_userId_key" ON "traveler_profiles"("userId");

-- CreateIndex
CREATE INDEX "bookings_userId_idx" ON "bookings"("userId");

-- CreateIndex
CREATE INDEX "bookings_userId_status_idx" ON "bookings"("userId", "status");

-- AddForeignKey
ALTER TABLE "traveler_profiles" ADD CONSTRAINT "traveler_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
