ALTER TABLE "traveler_profiles"
ADD COLUMN "preferredDepartureWindow" JSONB,
ADD COLUMN "preferredArrivalWindow" JSONB,
ADD COLUMN "maxStops" INTEGER,
ADD COLUMN "priceSensitivity" TEXT,
ADD COLUMN "requiresCheckedBaggage" BOOLEAN;
