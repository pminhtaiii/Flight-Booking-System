import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

export type CoherentBookingSnapshotPayload = Prisma.BookingGetPayload<{
  include: {
    itineraryRevisions: {
      include: {
        segments: true;
      };
    };
  };
}>;

export interface CoherentBookingSnapshot extends CoherentBookingSnapshotPayload {}

@Injectable()
export class BookingEventHydratorService {
  private readonly inFlight = new Map<string, Promise<CoherentBookingSnapshot | null>>();

  constructor(private readonly prisma: PrismaService) {}

  async hydrate(
    bookingId: string,
    minVersion?: number,
    processingCycleId?: string,
  ): Promise<CoherentBookingSnapshot | null> {
    // Event listeners retain the existing `(bookingId, sourceVersion)` call shape. A
    // caller with an explicit event ID can provide it as the cycle key so deliveries
    // for the same booking do not share a read across processing cycles.
    const explicitCycleKey = processingCycleId?.trim();
    const cacheKey = explicitCycleKey
      ? `${explicitCycleKey}:${bookingId}`
      : `booking:${bookingId}`;
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      const snapshot = await existing;
      if (minVersion === undefined || (snapshot && snapshot.version >= minVersion)) {
        return snapshot;
      }
      // If snapshot has lower version than minVersion, pending query was started before commit.
      // Fall through to query database freshly.
    }

    const promise = this.prisma
      .$transaction(
        (tx) =>
          tx.booking.findUnique({
            where: { id: bookingId },
            include: {
              itineraryRevisions: {
                orderBy: { version: 'desc' },
                take: 1,
                include: {
                  segments: {
                    orderBy: { globalOrder: 'asc' },
                  },
                },
              },
            },
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      )
      .finally(() => {
        if (this.inFlight.get(cacheKey) === promise) {
          this.inFlight.delete(cacheKey);
        }
      });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }
}
