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
    const now = new Date();

    const updatedBooking = await this.prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({
        where: { id: bookingId },
      });

      if (!current) {
        throw new NotFoundException('Booking not found');
      }

      if (current.userId !== userId) {
        throw new ForbiddenException('Insufficient permissions');
      }

      if (current.activeDisruptionRevisionId !== revisionId) {
        throw new ConflictException({
          code: 'STALE_DISRUPTION_REVISION',
          activeRevisionId: current.activeDisruptionRevisionId ?? null,
          disruptionStatus: current.disruptionStatus ?? null,
        });
      }

      if (current.disruptionStatus === 'ACKNOWLEDGED' || current.disruptionStatus === 'RESOLVED') {
        return current;
      }

      if (current.disruptionStatus !== 'DETECTED') {
        throw new ConflictException({
          code: 'DISRUPTION_TRANSITION_INVALID',
          message: `Cannot acknowledge disruption in state: ${current.disruptionStatus}`,
        });
      }

      const result = await tx.booking.updateMany({
        where: {
          id: bookingId,
          activeDisruptionRevisionId: revisionId,
          disruptionStatus: current.disruptionStatus,
        },
        data: { disruptionStatus: 'ACKNOWLEDGED' },
      });

      if (result.count === 0) {
        const reloaded = await tx.booking.findUnique({ where: { id: bookingId } });
        if (reloaded && reloaded.activeDisruptionRevisionId === revisionId) {
          return reloaded;
        }
        throw new ConflictException({
          code: 'STALE_DISRUPTION_REVISION',
          activeRevisionId: reloaded?.activeDisruptionRevisionId ?? null,
          disruptionStatus: reloaded?.disruptionStatus ?? null,
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
          fromStatus: current.disruptionStatus,
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
    const now = new Date();

    const updatedBooking = await this.prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({
        where: { id: bookingId },
      });

      if (!current) {
        throw new NotFoundException('Booking not found');
      }

      if (current.userId !== userId) {
        throw new ForbiddenException('Insufficient permissions');
      }

      if (current.activeDisruptionRevisionId !== revisionId) {
        throw new ConflictException({
          code: 'STALE_DISRUPTION_REVISION',
          activeRevisionId: current.activeDisruptionRevisionId ?? null,
          disruptionStatus: current.disruptionStatus ?? null,
        });
      }

      if (current.disruptionStatus === 'RESOLVED') {
        return current;
      }

      if (current.disruptionStatus !== 'DETECTED' && current.disruptionStatus !== 'ACKNOWLEDGED') {
        throw new ConflictException({
          code: 'DISRUPTION_TRANSITION_INVALID',
          message: `Cannot accept disruption in state: ${current.disruptionStatus}`,
        });
      }

      const result = await tx.booking.updateMany({
        where: {
          id: bookingId,
          activeDisruptionRevisionId: revisionId,
          disruptionStatus: { in: ['DETECTED', 'ACKNOWLEDGED'] },
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
        const reloaded = await tx.booking.findUnique({ where: { id: bookingId } });
        if (reloaded && reloaded.activeDisruptionRevisionId === revisionId && reloaded.disruptionStatus === 'RESOLVED') {
          return reloaded;
        }
        throw new ConflictException({
          code: 'STALE_DISRUPTION_REVISION',
          activeRevisionId: reloaded?.activeDisruptionRevisionId ?? null,
          disruptionStatus: reloaded?.disruptionStatus ?? null,
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
          fromStatus: current.disruptionStatus,
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

