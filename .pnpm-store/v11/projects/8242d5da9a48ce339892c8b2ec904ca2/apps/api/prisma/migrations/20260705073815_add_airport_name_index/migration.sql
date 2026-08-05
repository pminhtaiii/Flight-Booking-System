-- CreateEnum
CREATE TYPE "AirportType" AS ENUM ('LARGE_AIRPORT', 'MEDIUM_AIRPORT');

-- CreateTable
CREATE TABLE "airports" (
    "id" TEXT NOT NULL,
    "iataCode" VARCHAR(3) NOT NULL,
    "icaoCode" VARCHAR(4),
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "region" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "elevation" INTEGER,
    "type" "AirportType" NOT NULL,
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "airports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "airports_iataCode_key" ON "airports"("iataCode");

-- CreateIndex
CREATE INDEX "airports_country_idx" ON "airports"("country");

-- CreateIndex
CREATE INDEX "airports_icaoCode_idx" ON "airports"("icaoCode");

-- CreateIndex
CREATE INDEX "airports_latitude_longitude_idx" ON "airports"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "airports_name_idx" ON "airports"("name");
