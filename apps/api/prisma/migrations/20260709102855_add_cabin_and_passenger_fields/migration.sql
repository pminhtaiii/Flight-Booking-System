/*
  Warnings:

  - You are about to drop the column `passengers` on the `flight_offers` table. All the data in the column will be lost.
  - You are about to drop the column `passengers` on the `search_history` table. All the data in the column will be lost.
  - Added the required column `adults` to the `flight_offers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `adults` to the `search_history` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable: flight_offers
ALTER TABLE "flight_offers"
ADD COLUMN     "adults" INTEGER,
ADD COLUMN     "cabin_class" TEXT NOT NULL DEFAULT 'economy',
ADD COLUMN     "children" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "infants" INTEGER NOT NULL DEFAULT 0;

-- Backfill: flight_offers
UPDATE "flight_offers" SET "adults" = "passengers";

-- Set NOT NULL and Drop passengers: flight_offers
ALTER TABLE "flight_offers"
ALTER COLUMN "adults" SET NOT NULL,
DROP COLUMN "passengers";

-- AlterTable: search_history
ALTER TABLE "search_history"
ADD COLUMN     "adults" INTEGER,
ADD COLUMN     "cabin_class" TEXT NOT NULL DEFAULT 'economy',
ADD COLUMN     "children" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "infants" INTEGER NOT NULL DEFAULT 0;

-- Backfill: search_history
UPDATE "search_history" SET "adults" = "passengers";

-- Set NOT NULL and Drop passengers: search_history
ALTER TABLE "search_history"
ALTER COLUMN "adults" SET NOT NULL,
DROP COLUMN "passengers";

