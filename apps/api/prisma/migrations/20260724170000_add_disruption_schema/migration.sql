-- CreateEnum
CREATE TYPE "DisruptionStatus" AS ENUM ('NONE', 'DETECTED', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DisruptionResolvedReason" AS ENUM ('TRAVELLER_ACCEPTED', 'DEPARTURE_PASSED', 'ADMIN_RESOLVED', 'BOOKING_CANCELLED');

-- CreateEnum
CREATE TYPE "DisruptionActorType" AS ENUM ('TRAVELLER', 'SYSTEM', 'ADMIN');

-- CreateEnum
CREATE TYPE "DisruptionAttentionReason" AS ENUM ('NOTIFICATION_THROTTLED', 'AGED_UNRESOLVED', 'DATA_QUALITY');

-- CreateEnum
CREATE TYPE "ItineraryRevisionSource" AS ENUM ('WEBHOOK', 'RECONCILIATION', 'BOOTSTRAP');

-- CreateEnum
CREATE TYPE "MaterialBaseline" AS ENUM ('INCREMENTAL', 'CUMULATIVE');

-- CreateEnum
CREATE TYPE "MaterialDisruptionReason" AS ENUM ('SEGMENT_REMOVED', 'SEGMENT_ADDED', 'DEPARTURE_AIRPORT_CHANGED', 'ARRIVAL_AIRPORT_CHANGED', 'DEPARTURE_LOCAL_DATE_CHANGED', 'ARRIVAL_LOCAL_DATE_CHANGED', 'DEPARTURE_MOVED_EARLIER', 'DEPARTURE_MOVED_LATER', 'FINAL_ARRIVAL_MOVED_EARLIER', 'FINAL_ARRIVAL_MOVED_LATER', 'OVERNIGHT_CONNECTION_INTRODUCED', 'CONNECTION_BELOW_MCT', 'INVALID_CONNECTION_OVERLAP');

-- CreateEnum
CREATE TYPE "DuffelWebhookEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY_SCHEDULED', 'PROCESSED', 'SKIPPED', 'FAILED_NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "NotificationOutboxType" AS ENUM ('MATERIAL_DISRUPTION');

-- CreateEnum
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "DisruptionAuditEventAction" AS ENUM ('DETECTED', 'ACKNOWLEDGED', 'TRAVELLER_ACCEPTED', 'DEPARTURE_RESOLVED', 'BOOKING_CANCELLED', 'ADMIN_RESOLVED', 'EVENT_RETRIED', 'ATTENTION_RAISED', 'ATTENTION_CLEARED');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "activeDisruptionRevisionId" TEXT,
ADD COLUMN     "currentDepartureAt" TIMESTAMP(3),
ADD COLUMN     "currentFinalArrivalAt" TIMESTAMP(3),
ADD COLUMN     "disruptionAttentionAt" TIMESTAMP(3),
ADD COLUMN     "disruptionAttentionReason" "DisruptionAttentionReason",
ADD COLUMN     "disruptionNeedsAttention" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "disruptionResolvedAt" TIMESTAMP(3),
ADD COLUMN     "disruptionResolvedById" TEXT,
ADD COLUMN     "disruptionResolvedByType" "DisruptionActorType",
ADD COLUMN     "disruptionResolvedReason" "DisruptionResolvedReason",
ADD COLUMN     "disruptionStatus" "DisruptionStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "lastDuffelSyncedAt" TIMESTAMP(3),
ADD COLUMN     "nextDuffelSyncAt" TIMESTAMP(3),
ADD COLUMN     "nextUnflownDepartureAt" TIMESTAMP(3),
ADD COLUMN     "syncLockToken" TEXT,
ADD COLUMN     "syncLockedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "itinerary_revisions" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" "ItineraryRevisionSource" NOT NULL,
    "sourceEventId" TEXT,
    "supplierObservedAt" TIMESTAMP(3),
    "fingerprint" TEXT NOT NULL,
    "isMaterial" BOOLEAN NOT NULL,
    "materialReasons" "MaterialDisruptionReason"[],
    "materialBaselines" "MaterialBaseline"[],
    "incrementalDiff" JSONB NOT NULL,
    "cumulativeDiff" JSONB NOT NULL,
    "rulesetVersion" TEXT NOT NULL DEFAULT 'disruption-v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "itinerary_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "itinerary_revision_segments" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "sliceOrder" INTEGER NOT NULL,
    "segmentOrder" INTEGER NOT NULL,
    "globalOrder" INTEGER NOT NULL,
    "duffelSegmentId" TEXT,
    "marketingCarrierIata" TEXT NOT NULL,
    "operatingCarrierIata" TEXT,
    "airlineName" TEXT NOT NULL,
    "flightNumber" TEXT NOT NULL,
    "departureAirportIata" TEXT NOT NULL,
    "departureAirportName" TEXT NOT NULL,
    "departureCity" TEXT NOT NULL,
    "departureTerminal" TEXT,
    "departureAt" TIMESTAMP(3) NOT NULL,
    "departureLocalDate" DATE NOT NULL,
    "arrivalAirportIata" TEXT NOT NULL,
    "arrivalAirportName" TEXT NOT NULL,
    "arrivalCity" TEXT NOT NULL,
    "arrivalTerminal" TEXT,
    "arrivalAt" TIMESTAMP(3) NOT NULL,
    "arrivalLocalDate" DATE NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "aircraftType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "itinerary_revision_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duffel_webhook_events" (
    "id" TEXT NOT NULL,
    "supplierEventId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "duffelOrderId" TEXT,
    "eventType" TEXT NOT NULL,
    "status" "DuffelWebhookEventStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "processingStartedAt" TIMESTAMP(3),
    "processingToken" TEXT,
    "rawPayload" JSONB,
    "payloadRedactedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "duffel_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "type" "NotificationOutboxType" NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "stabilizationWarning" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disruption_audit_events" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "revisionId" TEXT,
    "action" "DisruptionAuditEventAction" NOT NULL,
    "fromStatus" "DisruptionStatus",
    "toStatus" "DisruptionStatus",
    "actorType" "DisruptionActorType" NOT NULL,
    "actorId" TEXT,
    "safeNote" TEXT,
    "correlationId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disruption_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "itinerary_revisions_bookingId_createdAt_idx" ON "itinerary_revisions"("bookingId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "itinerary_revisions_bookingId_isMaterial_createdAt_idx" ON "itinerary_revisions"("bookingId", "isMaterial", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "itinerary_revisions_sourceEventId_idx" ON "itinerary_revisions"("sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "itinerary_revisions_bookingId_version_key" ON "itinerary_revisions"("bookingId", "version");

-- CreateIndex
CREATE INDEX "itinerary_revision_segments_revisionId_sliceOrder_segmentOr_idx" ON "itinerary_revision_segments"("revisionId", "sliceOrder", "segmentOrder");

-- CreateIndex
CREATE INDEX "itinerary_revision_segments_duffelSegmentId_idx" ON "itinerary_revision_segments"("duffelSegmentId");

-- CreateIndex
CREATE UNIQUE INDEX "itinerary_revision_segments_revisionId_globalOrder_key" ON "itinerary_revision_segments"("revisionId", "globalOrder");

-- CreateIndex
CREATE UNIQUE INDEX "duffel_webhook_events_supplierEventId_key" ON "duffel_webhook_events"("supplierEventId");

-- CreateIndex
CREATE INDEX "duffel_webhook_events_status_nextAttemptAt_createdAt_idx" ON "duffel_webhook_events"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "duffel_webhook_events_processingStartedAt_idx" ON "duffel_webhook_events"("processingStartedAt");

-- CreateIndex
CREATE INDEX "duffel_webhook_events_duffelOrderId_createdAt_idx" ON "duffel_webhook_events"("duffelOrderId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "duffel_webhook_events_payloadRedactedAt_createdAt_idx" ON "duffel_webhook_events"("payloadRedactedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_revisionId_key" ON "notification_outbox"("revisionId");

-- CreateIndex
CREATE INDEX "notification_outbox_bookingId_createdAt_idx" ON "notification_outbox"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_outbox_status_createdAt_idx" ON "notification_outbox"("status", "createdAt");

-- CreateIndex
CREATE INDEX "disruption_audit_events_bookingId_createdAt_idx" ON "disruption_audit_events"("bookingId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "disruption_audit_events_revisionId_idx" ON "disruption_audit_events"("revisionId");

-- CreateIndex
CREATE INDEX "disruption_audit_events_action_createdAt_idx" ON "disruption_audit_events"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_activeDisruptionRevisionId_key" ON "bookings"("activeDisruptionRevisionId");

-- CreateIndex
CREATE INDEX "bookings_duffelOrderId_idx" ON "bookings"("duffelOrderId");

-- CreateIndex
CREATE INDEX "bookings_status_nextUnflownDepartureAt_lastDuffelSyncedAt_idx" ON "bookings"("status", "nextUnflownDepartureAt", "lastDuffelSyncedAt");

-- CreateIndex
CREATE INDEX "bookings_disruptionStatus_disruptionResolvedAt_idx" ON "bookings"("disruptionStatus", "disruptionResolvedAt");

-- CreateIndex
CREATE INDEX "bookings_disruptionNeedsAttention_disruptionAttentionAt_idx" ON "bookings"("disruptionNeedsAttention", "disruptionAttentionAt");

-- CreateIndex
CREATE INDEX "bookings_syncLockedAt_idx" ON "bookings"("syncLockedAt");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_activeDisruptionRevisionId_fkey" FOREIGN KEY ("activeDisruptionRevisionId") REFERENCES "itinerary_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_revisions" ADD CONSTRAINT "itinerary_revisions_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_revision_segments" ADD CONSTRAINT "itinerary_revision_segments_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "itinerary_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "itinerary_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disruption_audit_events" ADD CONSTRAINT "disruption_audit_events_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disruption_audit_events" ADD CONSTRAINT "disruption_audit_events_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "itinerary_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

