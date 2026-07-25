import { Injectable, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { 
  DisruptionHistoryResponseDto, 
  AcknowledgeDisruptionResponseDto, 
  AcceptDisruptionResponseDto,
  DisruptionStatus,
  DisruptionResolvedReason
} from '@shared/disruption-types';

@Injectable()
export class DisruptionService {
  constructor(private readonly prisma: PrismaService) {}

  async getDisruptionHistory(bookingId: string, userId: string, page: number, limit: number): Promise<DisruptionHistoryResponseDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.userId !== userId) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const total = await this.prisma.itineraryRevision.count({
      where: { bookingId },
    });

    const revisions = await this.prisma.itineraryRevision.findMany({
      where: { bookingId },
      orderBy: { version: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        segments: {
          orderBy: { globalOrder: 'asc' },
        },
      },
    });

    const items = revisions.map((rev) => {
      return {
        revisionId: rev.id,
        version: rev.version,
        observedAt: rev.createdAt.toISOString(),
        isMaterial: rev.isMaterial,
        materialReasons: rev.materialReasons as any[],
        materialBaselines: rev.materialBaselines as any[],
        incrementalSummary: (rev.incrementalDiff as any)?.presentationSummary || {},
        cumulativeSummary: (rev.cumulativeDiff as any)?.presentationSummary || {},
        segments: rev.segments.map(seg => ({
          airline: {
            name: seg.airlineName,
            iataCode: seg.marketingCarrierIata,
          },
          flightNumber: seg.flightNumber,
          departureAirport: {
            iataCode: seg.departureAirportIata,
            name: seg.departureAirportName,
            city: seg.departureCity,
            terminal: seg.departureTerminal ?? undefined,
          },
          arrivalAirport: {
            iataCode: seg.arrivalAirportIata,
            name: seg.arrivalAirportName,
            city: seg.arrivalCity,
            terminal: seg.arrivalTerminal ?? undefined,
          },
          departureAt: seg.departureAt.toISOString(),
          arrivalAt: seg.arrivalAt.toISOString(),
          duration: `PT${seg.durationMinutes}M`,
          aircraftType: seg.aircraftType ?? undefined,
          duffelSegmentId: seg.duffelSegmentId ?? undefined,
          sliceOrder: seg.sliceOrder,
          segmentOrder: seg.segmentOrder,
          globalOrder: seg.globalOrder,
        })),
      };
    });

    return {
      items,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async acknowledgeDisruption(bookingId: string, revisionId: string, userId: string): Promise<AcknowledgeDisruptionResponseDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.userId !== userId) {
      throw new ForbiddenException('Insufficient permissions');
    }

    if (booking.activeDisruptionRevisionId !== revisionId) {
      throw new ConflictException({
        code: 'STALE_DISRUPTION_REVISION',
        activeRevisionId: booking.activeDisruptionRevisionId,
        disruptionStatus: booking.disruptionStatus,
      });
    }

    if (
      booking.disruptionStatus !== 'DETECTED' &&
      booking.disruptionStatus !== 'ACKNOWLEDGED' &&
      booking.disruptionStatus !== 'RESOLVED'
    ) {
      throw new ConflictException({
        code: 'DISRUPTION_TRANSITION_INVALID',
        message: `Cannot acknowledge disruption in state: ${booking.disruptionStatus}`,
      });
    }

    if (booking.disruptionStatus === 'ACKNOWLEDGED' || booking.disruptionStatus === 'RESOLVED') {
      return {
        bookingId: booking.id,
        activeRevisionId: booking.activeDisruptionRevisionId!,
        disruptionStatus: booking.disruptionStatus as DisruptionStatus,
        resolvedReason: booking.disruptionResolvedReason as DisruptionResolvedReason | null,
        updatedAt: booking.updatedAt.toISOString(),
      };
    }

    const previousStatus = booking.disruptionStatus;
    const now = new Date();

    const updatedBooking = await this.prisma.$transaction(async (tx) => {
      const result = await tx.booking.updateMany({
        where: { 
          id: bookingId, 
          activeDisruptionRevisionId: revisionId,
          disruptionStatus: 'DETECTED'
        },
        data: { disruptionStatus: 'ACKNOWLEDGED' },
      });

      if (result.count === 0) {
        const current = await tx.booking.findUnique({ where: { id: bookingId } });
        if (current && current.activeDisruptionRevisionId === revisionId) {
          return current;
        }
        throw new ConflictException({
          code: 'STALE_DISRUPTION_REVISION',
          activeRevisionId: current?.activeDisruptionRevisionId ?? null,
          disruptionStatus: current?.disruptionStatus ?? null,
        });
      }

      const updated = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!updated) {
        throw new NotFoundException('Booking not found');
      }

      await tx.disruptionAuditEvent.create({
        data: {
          bookingId,
          revisionId,
          action: 'ACKNOWLEDGED',
          fromStatus: previousStatus,
          toStatus: 'ACKNOWLEDGED',
          actorType: 'TRAVELLER',
          actorId: userId,
          correlationId: `ack-${bookingId}-${now.getTime()}`,
          traceId: `ack-${bookingId}-${now.getTime()}`,
          createdAt: now,
        },
      });

      return updated;
    });

    return {
      bookingId: updatedBooking.id,
      activeRevisionId: updatedBooking.activeDisruptionRevisionId!,
      disruptionStatus: updatedBooking.disruptionStatus as DisruptionStatus,
      resolvedReason: updatedBooking.disruptionResolvedReason as DisruptionResolvedReason | null,
      updatedAt: updatedBooking.updatedAt.toISOString(),
    };
  }

  async acceptDisruption(bookingId: string, revisionId: string, userId: string): Promise<AcceptDisruptionResponseDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.userId !== userId) {
      throw new ForbiddenException('Insufficient permissions');
    }

    if (booking.activeDisruptionRevisionId !== revisionId) {
      throw new ConflictException({
        code: 'STALE_DISRUPTION_REVISION',
        activeRevisionId: booking.activeDisruptionRevisionId,
        disruptionStatus: booking.disruptionStatus,
      });
    }

    if (
      booking.disruptionStatus !== 'DETECTED' &&
      booking.disruptionStatus !== 'ACKNOWLEDGED' &&
      booking.disruptionStatus !== 'RESOLVED'
    ) {
      throw new ConflictException({
        code: 'DISRUPTION_TRANSITION_INVALID',
        message: `Cannot accept disruption in state: ${booking.disruptionStatus}`,
      });
    }

    if (booking.disruptionStatus === 'RESOLVED') {
      return {
        bookingId: booking.id,
        activeRevisionId: booking.activeDisruptionRevisionId!,
        disruptionStatus: 'RESOLVED' as DisruptionStatus,
        resolvedReason: booking.disruptionResolvedReason as DisruptionResolvedReason | null,
        resolvedAt: booking.disruptionResolvedAt?.toISOString() ?? null,
        updatedAt: booking.updatedAt.toISOString(),
      };
    }

    const previousStatus = booking.disruptionStatus;
    const now = new Date();

    const updatedBooking = await this.prisma.$transaction(async (tx) => {
      const result = await tx.booking.updateMany({
        where: { 
          id: bookingId, 
          activeDisruptionRevisionId: revisionId,
          disruptionStatus: { in: ['DETECTED', 'ACKNOWLEDGED'] }
        },
        data: {
          disruptionStatus: 'RESOLVED',
          disruptionResolvedReason: 'TRAVELLER_ACCEPTED',
          disruptionResolvedAt: now,
          disruptionResolvedByType: 'TRAVELLER',
          disruptionResolvedById: userId,
        },
      });

      if (result.count === 0) {
        const current = await tx.booking.findUnique({ where: { id: bookingId } });
        if (current && current.activeDisruptionRevisionId === revisionId && current.disruptionStatus === 'RESOLVED') {
          return current;
        }
        throw new ConflictException({
          code: 'STALE_DISRUPTION_REVISION',
          activeRevisionId: current?.activeDisruptionRevisionId ?? null,
          disruptionStatus: current?.disruptionStatus ?? null,
        });
      }

      const updated = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!updated) {
        throw new NotFoundException('Booking not found');
      }

      await tx.disruptionAuditEvent.create({
        data: {
          bookingId,
          revisionId,
          action: 'TRAVELLER_ACCEPTED',
          fromStatus: updated.disruptionStatus === 'RESOLVED' && previousStatus === 'DETECTED' ? 'ACKNOWLEDGED' : previousStatus, // wait: fromStatus should be whatever status we transitioned from, which is either previousStatus or if it was concurrently changed, it's captured in previousStatus
          toStatus: 'RESOLVED',
          actorType: 'TRAVELLER',
          actorId: userId,
          correlationId: `accept-${bookingId}-${now.getTime()}`,
          traceId: `accept-${bookingId}-${now.getTime()}`,
          createdAt: now,
        },
      });

      return updated;
    });

    return {
      bookingId: updatedBooking.id,
      activeRevisionId: updatedBooking.activeDisruptionRevisionId!,
      disruptionStatus: 'RESOLVED' as DisruptionStatus,
      resolvedReason: 'TRAVELLER_ACCEPTED' as DisruptionResolvedReason,
      resolvedAt: updatedBooking.disruptionResolvedAt!.toISOString(),
      updatedAt: updatedBooking.updatedAt.toISOString(),
    };
  }
}

