-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "booking_agent_projections" ADD COLUMN "source_version" INTEGER NOT NULL DEFAULT 0;
