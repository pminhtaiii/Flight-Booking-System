/*
  Warnings:

  - You are about to drop the column `passengers` on the `flight_offers` table. All the data in the column will be lost.
  - You are about to drop the column `passengers` on the `search_history` table. All the data in the column will be lost.
  - Added the required column `adults` to the `flight_offers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `adults` to the `search_history` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "flight_offers" DROP COLUMN "passengers",
ADD COLUMN     "adults" INTEGER NOT NULL,
ADD COLUMN     "cabin_class" TEXT NOT NULL DEFAULT 'economy',
ADD COLUMN     "children" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "infants" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "search_history" DROP COLUMN "passengers",
ADD COLUMN     "adults" INTEGER NOT NULL,
ADD COLUMN     "cabin_class" TEXT NOT NULL DEFAULT 'economy',
ADD COLUMN     "children" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "infants" INTEGER NOT NULL DEFAULT 0;
