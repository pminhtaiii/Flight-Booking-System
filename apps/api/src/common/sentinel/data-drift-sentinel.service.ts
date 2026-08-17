import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { BookingStatus } from '@prisma/client';

export interface DanglingClaimHealingResult {
  healedCount: number;
  healedIds: string[];
}

export interface ConsumedHandoffIntegrityResult {
  valid: boolean;
  unlinkedConsumedCount: number;
  totalConsumedCount: number;
}

export interface BookingProjectionSyncResult {
  valid: boolean;
  missingProjectionCount: number;
  totalEligibleBookingsCount: number;
}

export interface FullDriftSentinelAuditSummary {
  timestamp: string;
  danglingClaims: DanglingClaimHealingResult;
  consumedHandoffIntegrity: ConsumedHandoffIntegrityResult;
  bookingProjectionSync: BookingProjectionSyncResult;
  healthy: boolean;
}

const ELIGIBLE_PROJECTION_STATUSES: BookingStatus[] = [
  BookingStatus.CONFIRMED,
  BookingStatus.COMPLETED,
  BookingStatus.CANCELLATION_PENDING,
  BookingStatus.CANCELLED_PENDING_REFUND,
  BookingStatus.CANCELLED_AND_REFUNDED,
  BookingStatus.CANCELLED_NO_REFUND,
];

@Injectable()
export class DataDriftSentinelService {
  private readonly logger = new Logger(DataDriftSentinelService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finds all ChatHandoff records where:
   *   claimTokenHash != null
   *   consumedAt == null
   *   consumedByBookingIntentId == null
   *   (claimExpiresAt < referenceTime OR claimRecoverAfter < referenceTime)
   *
   * Atomically updates them back to clean unreserved state.
   */
  async detectAndHealDanglingClaims(
    referenceTime: Date = new Date(),
  ): Promise<DanglingClaimHealingResult> {
    const danglingHandoffs = await this.prisma.chatHandoff.findMany({
      where: {
        claimTokenHash: { not: null },
        consumedAt: null,
        consumedByBookingIntentId: null,
        OR: [
          { claimExpiresAt: { lt: referenceTime } },
          { claimRecoverAfter: { lt: referenceTime } },
        ],
      },
      select: {
        id: true,
      },
    });

    if (danglingHandoffs.length === 0) {
      return {
        healedCount: 0,
        healedIds: [],
      };
    }

    const danglingIds = danglingHandoffs.map((h) => h.id);

    // Atomically reset all dangling claims
    const updateResult = await this.prisma.chatHandoff.updateMany({
      where: {
        id: { in: danglingIds },
        consumedAt: null,
        consumedByBookingIntentId: null,
      },
      data: {
        claimedAt: null,
        claimTokenHash: null,
        claimExpiresAt: null,
        claimRecoverAfter: null,
      },
    });

    this.logger.log(
      `DataDriftSentinel: Healed ${updateResult.count} dangling claims back to clean unreserved state.`,
    );

    return {
      healedCount: updateResult.count,
      healedIds: danglingIds,
    };
  }

  /**
   * Asserts 100% of ChatHandoff records with consumedAt != null have an authoritative,
   * non-null consumedByBookingIntentId that exists in the BookingIntent table.
   */
  async verifyConsumedHandoffIntegrity(): Promise<ConsumedHandoffIntegrityResult> {
    const consumedHandoffs = await this.prisma.chatHandoff.findMany({
      where: {
        consumedAt: { not: null },
      },
      select: {
        id: true,
        consumedByBookingIntentId: true,
      },
    });

    const totalConsumedCount = consumedHandoffs.length;
    if (totalConsumedCount === 0) {
      return {
        valid: true,
        unlinkedConsumedCount: 0,
        totalConsumedCount: 0,
      };
    }

    const intentIds = consumedHandoffs
      .map((h) => h.consumedByBookingIntentId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const existingIntentsCount = await this.prisma.bookingIntent.count({
      where: {
        id: { in: intentIds },
      },
    });

    // Unlinked if consumedByBookingIntentId is null or intent doesn't exist in BookingIntent table
    const unlinkedConsumedCount = totalConsumedCount - existingIntentsCount;
    const valid = unlinkedConsumedCount === 0;

    if (!valid) {
      this.logger.warn(
        `DataDriftSentinel: Consumed handoff integrity check failed. Unlinked count: ${unlinkedConsumedCount}/${totalConsumedCount}`,
      );
    }

    return {
      valid,
      unlinkedConsumedCount,
      totalConsumedCount,
    };
  }

  /**
   * Asserts 100% of Booking records with confirmed/cancelled statuses have an exact
   * 1:1 BookingAgentProjection record (booking_agent_projections.bookingId = booking.id).
   */
  async verifyBookingProjectionSync(): Promise<BookingProjectionSyncResult> {
    const eligibleBookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ELIGIBLE_PROJECTION_STATUSES },
      },
      select: {
        id: true,
      },
    });

    const totalEligibleBookingsCount = eligibleBookings.length;
    if (totalEligibleBookingsCount === 0) {
      return {
        valid: true,
        missingProjectionCount: 0,
        totalEligibleBookingsCount: 0,
      };
    }

    const bookingIds = eligibleBookings.map((b) => b.id);
    const existingProjections = await this.prisma.bookingAgentProjection.findMany({
      where: {
        bookingId: { in: bookingIds },
      },
      select: {
        bookingId: true,
      },
    });

    const projectionBookingIds = new Set(existingProjections.map((p) => p.bookingId));
    const missingProjectionCount = eligibleBookings.filter((b) => !projectionBookingIds.has(b.id)).length;
    const valid = missingProjectionCount === 0;

    if (!valid) {
      this.logger.warn(
        `DataDriftSentinel: Booking projection sync check failed. Missing projections: ${missingProjectionCount}/${totalEligibleBookingsCount}`,
      );
    }

    return {
      valid,
      missingProjectionCount,
      totalEligibleBookingsCount,
    };
  }

  /**
   * Executes all above checks, performs healing, and returns aggregate telemetry/health summary.
   */
  async runFullDriftSentinelAudit(referenceTime: Date = new Date()): Promise<FullDriftSentinelAuditSummary> {
    const danglingClaims = await this.detectAndHealDanglingClaims(referenceTime);
    const consumedHandoffIntegrity = await this.verifyConsumedHandoffIntegrity();
    const bookingProjectionSync = await this.verifyBookingProjectionSync();

    const healthy = consumedHandoffIntegrity.valid && bookingProjectionSync.valid;

    return {
      timestamp: referenceTime.toISOString(),
      danglingClaims,
      consumedHandoffIntegrity,
      bookingProjectionSync,
      healthy,
    };
  }
}
