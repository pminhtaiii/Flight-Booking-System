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

  async hydrate(bookingId: string, minVersion?: number): Promise<CoherentBookingSnapshot | null> {
    const existing = this.inFlight.get(bookingId);
    if (existing) {
      const snapshot = await existing;
      if (!minVersion || (snapshot && snapshot.version >= minVersion)) {
        return snapshot;
      }
      // If snapshot has lower version than minVersion, pending query was started before commit.
      // Fall through to query database freshly.
    }

    const promise = this.prisma.booking
      .findUnique({
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
      })
      .finally(() => {
        if (this.inFlight.get(bookingId) === promise) {
          this.inFlight.delete(bookingId);
        }
      });

    this.inFlight.set(bookingId, promise);
    return promise;
  }
}
