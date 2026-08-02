-- AlterTable
ALTER TABLE "booking_intent_passengers" ADD COLUMN     "documentType" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "issuingCountry" VARCHAR(2),
ADD COLUMN     "middleName" TEXT,
ADD COLUMN     "phoneCountryCode" TEXT,
ADD COLUMN     "phoneNumber" TEXT,
ADD COLUMN     "snapshotVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "traveler_profiles" ADD COLUMN     "dateOfBirth" DATE,
ADD COLUMN     "documentType" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "familyName" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "givenName" TEXT,
ADD COLUMN     "issuingCountry" VARCHAR(2),
ADD COLUMN     "middleName" TEXT,
ADD COLUMN     "passportExpiryCiphertext" TEXT,
ADD COLUMN     "phoneCountryCode" TEXT,
ADD COLUMN     "phoneNumber" TEXT,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "title" TEXT;

-- RenameForeignKey
ALTER TABLE "payments" RENAME CONSTRAINT "payments_ancillary_selection_binding_fkey" TO "payments_ancillarySelectionId_bookingIntentId_ancillarySel_fkey";

-- RenameIndex
ALTER INDEX "baggage_selections_ancillarySelectionId_intentPassengerId_servi" RENAME TO "baggage_selections_ancillarySelectionId_intentPassengerId_s_key";

-- RenameIndex
ALTER INDEX "seat_selections_ancillarySelectionId_intentPassengerId_segmentI" RENAME TO "seat_selections_ancillarySelectionId_intentPassengerId_segm_key";
