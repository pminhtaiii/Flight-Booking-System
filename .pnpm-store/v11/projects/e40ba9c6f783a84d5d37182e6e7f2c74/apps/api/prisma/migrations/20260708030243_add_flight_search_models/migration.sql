-- CreateTable
CREATE TABLE "flight_offers" (
    "id" TEXT NOT NULL,
    "searchHash" TEXT NOT NULL,
    "duffelOfferId" TEXT NOT NULL,
    "rawOffer" JSONB NOT NULL,
    "origin" VARCHAR(3) NOT NULL,
    "destination" VARCHAR(3) NOT NULL,
    "departureDate" DATE NOT NULL,
    "returnDate" DATE,
    "passengers" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flight_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_history" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "origin" VARCHAR(3) NOT NULL,
    "destination" VARCHAR(3) NOT NULL,
    "departureDate" DATE NOT NULL,
    "returnDate" DATE,
    "passengers" INTEGER NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "minPrice" DECIMAL(10,2),
    "maxPrice" DECIMAL(10,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "searchHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_recoveries" (
    "id" TEXT NOT NULL,
    "searchHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "flight_offers_searchHash_idx" ON "flight_offers"("searchHash");

-- CreateIndex
CREATE INDEX "flight_offers_createdAt_idx" ON "flight_offers"("createdAt");

-- CreateIndex
CREATE INDEX "search_history_userId_idx" ON "search_history"("userId");

-- CreateIndex
CREATE INDEX "search_history_createdAt_idx" ON "search_history"("createdAt");

-- CreateIndex
CREATE INDEX "search_history_userId_createdAt_idx" ON "search_history"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "offer_recoveries_createdAt_idx" ON "offer_recoveries"("createdAt");

-- AddForeignKey
ALTER TABLE "search_history" ADD CONSTRAINT "search_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
