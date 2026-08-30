import { Injectable } from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import type { DashboardSummary, DashboardStats, DashboardRecentBooking } from '@shared/types';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(userId: string): Promise<DashboardSummary> {
    const now = new Date();

    const [
      totalBookings,
      upcomingBookings,
      completedBookings,
      cancelledBookings,
      recentDbBookings,
    ] = await Promise.all([
      this.prisma.booking.count({
        where: { userId },
      }),
      this.prisma.booking.count({
        where: {
          userId,
          status: BookingStatus.CONFIRMED,
          departureAt: { gte: now },
        },
      }),
      this.prisma.booking.count({
        where: {
          userId,
          OR: [
            { status: BookingStatus.COMPLETED },
            { status: BookingStatus.CONFIRMED, departureAt: { lt: now } },
          ],
        },
      }),
      this.prisma.booking.count({
        where: {
          userId,
          status: {
            in: [
              BookingStatus.CANCELLATION_PENDING,
              BookingStatus.CANCELLED_PENDING_REFUND,
              BookingStatus.CANCELLED_AND_REFUNDED,
              BookingStatus.CANCELLED_NO_REFUND,
              BookingStatus.REFUND_FAILED_NEEDS_ATTENTION,
            ],
          },
        },
      }),
      this.prisma.booking.findMany({
        where: { userId },
        take: 5,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    const stats: DashboardStats = {
      totalBookings,
      upcomingBookings,
      completedBookings,
      cancelledBookings,
    };

    const recentBookings: DashboardRecentBooking[] = recentDbBookings.map((b) => {
      const { originCode, destinationCode, airlineCode, flightNumber } = this.extractFlightDetails(
        b.flightSnapshot,
      );

      return {
        id: b.id,
        status: b.status as DashboardRecentBooking['status'],
        createdAt: b.createdAt.toISOString(),
        departureAt: b.departureAt ? b.departureAt.toISOString() : null,
        originCode,
        destinationCode,
        airlineCode,
        flightNumber,
      };
    });

    return {
      stats,
      recentBookings,
      generatedAt: now.toISOString(),
    };
  }

  private extractFlightDetails(snapshot: unknown): {
    originCode: string | null;
    destinationCode: string | null;
    airlineCode: string | null;
    flightNumber: string | null;
  } {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return { originCode: null, destinationCode: null, airlineCode: null, flightNumber: null };
    }

    const s = snapshot as Record<string, unknown>;

    // 1. Direct flat properties
    if (
      typeof s.originCode === 'string' ||
      typeof s.destinationCode === 'string' ||
      typeof s.airlineCode === 'string' ||
      typeof s.flightNumber === 'string'
    ) {
      return {
        originCode: typeof s.originCode === 'string' ? s.originCode : null,
        destinationCode: typeof s.destinationCode === 'string' ? s.destinationCode : null,
        airlineCode: typeof s.airlineCode === 'string' ? s.airlineCode : null,
        flightNumber: typeof s.flightNumber === 'string' ? s.flightNumber : null,
      };
    }

    // 2. Standard segments array
    if (Array.isArray(s.segments) && s.segments.length > 0) {
      const firstSeg = s.segments[0];
      const lastSeg = s.segments[s.segments.length - 1];

      const originCode =
        firstSeg?.departureAirport?.iataCode ??
        firstSeg?.origin?.iata_code ??
        firstSeg?.originCode ??
        null;
      const destinationCode =
        lastSeg?.arrivalAirport?.iataCode ??
        lastSeg?.destination?.iata_code ??
        lastSeg?.destinationCode ??
        null;
      const airlineCode =
        firstSeg?.airline?.iataCode ??
        firstSeg?.operating_carrier?.iata_code ??
        firstSeg?.airlineCode ??
        null;
      const flightNumber =
        firstSeg?.flightNumber ??
        firstSeg?.marketing_carrier_flight_number ??
        firstSeg?.flight_number ??
        null;

      return {
        originCode: typeof originCode === 'string' ? originCode : null,
        destinationCode: typeof destinationCode === 'string' ? destinationCode : null,
        airlineCode: typeof airlineCode === 'string' ? airlineCode : null,
        flightNumber: typeof flightNumber === 'string' ? flightNumber : null,
      };
    }

    // 3. Slice-based Duffel-like structure
    if (Array.isArray(s.slices) && s.slices.length > 0) {
      const firstSlice = s.slices[0];
      if (Array.isArray(firstSlice?.segments) && firstSlice.segments.length > 0) {
        const firstSeg = firstSlice.segments[0];
        const lastSeg = firstSlice.segments[firstSlice.segments.length - 1];

        const originCode =
          firstSeg?.origin?.iata_code ??
          firstSeg?.departureAirport?.iataCode ??
          firstSeg?.originCode ??
          null;
        const destinationCode =
          lastSeg?.destination?.iata_code ??
          lastSeg?.arrivalAirport?.iataCode ??
          lastSeg?.destinationCode ??
          null;
        const airlineCode =
          firstSeg?.operating_carrier?.iata_code ??
          firstSeg?.airline?.iataCode ??
          firstSeg?.airlineCode ??
          null;
        const flightNumber =
          firstSeg?.marketing_carrier_flight_number ??
          firstSeg?.flightNumber ??
          firstSeg?.flight_number ??
          null;

        return {
          originCode: typeof originCode === 'string' ? originCode : null,
          destinationCode: typeof destinationCode === 'string' ? destinationCode : null,
          airlineCode: typeof airlineCode === 'string' ? airlineCode : null,
          flightNumber: typeof flightNumber === 'string' ? flightNumber : null,
        };
      }
    }

    return { originCode: null, destinationCode: null, airlineCode: null, flightNumber: null };
  }
}
