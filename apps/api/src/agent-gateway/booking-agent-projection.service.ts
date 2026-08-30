import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma, BookingAgentProjection } from '@prisma/client';
import * as crypto from 'crypto';
import { FlightSnapshot } from '@shared/booking-types';

export interface SafeBookingProjectionData {
  airline: string;
  origin: string;
  destination: string;
  departureAt: Date;
  arrivalAt: Date;
  durationMinutes: number;
  stopCount: number;
  flightNumber: string | null;
  baggageSummary: string | null;
  refundable: boolean | null;
  changeable: boolean | null;
}

@Injectable()
export class BookingAgentProjectionService {
  private readonly logger = new Logger(BookingAgentProjectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  generateAgentReference(): string {
    return `bkref_${crypto.randomUUID()}`;
  }

  extractProjectionData(booking: any): SafeBookingProjectionData | null {
    let origin = '';
    let destination = '';
    let departureAt = new Date(0);
    let arrivalAt = new Date(0);
    let durationMinutes = 0;
    let stopCount = 0;
    let airline = '';
    let flightNumber: string | null = null;
    let baggageSummary: string | null = null;
    const refundable: boolean | null = null;
    const changeable: boolean | null = null;
    let hasFlightData = false;

    // 1. Primary: Active ItineraryRevision segments
    if (booking.itineraryRevisions && booking.itineraryRevisions.length > 0) {
      const activeRevision = booking.itineraryRevisions[0];
      const segments = activeRevision.segments || [];
      if (segments.length > 0) {
        origin = segments[0].departureAirportIata || '';
        destination = segments[segments.length - 1].arrivalAirportIata || '';
        departureAt = new Date(segments[0].departureAt);
        arrivalAt = new Date(segments[segments.length - 1].arrivalAt);
        durationMinutes = Math.max(
          0,
          Math.round((arrivalAt.getTime() - departureAt.getTime()) / 60000),
        );
        stopCount = Math.max(0, segments.length - 1);
        airline = segments[0].airlineName || '';
        flightNumber =
          segments[0].marketingCarrierIata && segments[0].flightNumber
            ? `${segments[0].marketingCarrierIata} ${segments[0].flightNumber}`
            : segments[0].flightNumber || null;
        hasFlightData = true;
      }
    }

    // 2. Fallback: flightSnapshot JSON
    if (!hasFlightData) {
      const flightSnapshot = booking.flightSnapshot as FlightSnapshot | null;
      if (
        flightSnapshot &&
        flightSnapshot.segments &&
        Array.isArray(flightSnapshot.segments) &&
        flightSnapshot.segments.length > 0
      ) {
        const segments = flightSnapshot.segments;
        const depStr = segments[0].departureAt;
        const arrStr = segments[segments.length - 1].arrivalAt;

        if (depStr && arrStr) {
          const parsedDep = new Date(depStr);
          const parsedArr = new Date(arrStr);

          if (!isNaN(parsedDep.getTime()) && !isNaN(parsedArr.getTime())) {
            origin = segments[0].departureAirport?.iataCode || '';
            destination = segments[segments.length - 1].arrivalAirport?.iataCode || '';
            departureAt = parsedDep;
            arrivalAt = parsedArr;
            durationMinutes = Math.max(
              0,
              Math.round((arrivalAt.getTime() - departureAt.getTime()) / 60000),
            );
            stopCount = flightSnapshot.stops ?? Math.max(0, segments.length - 1);
            airline = segments[0].airline?.name || '';
            flightNumber =
              segments[0].airline?.iataCode && segments[0].flightNumber
                ? `${segments[0].airline.iataCode} ${segments[0].flightNumber}`
                : segments[0].flightNumber || null;
            baggageSummary = flightSnapshot.baggageAllowance || null;
            hasFlightData = true;
          }
        }
      }
    }

    if (!hasFlightData) {
      return null;
    }

    return {
      airline,
      origin,
      destination,
      departureAt,
      arrivalAt,
      durationMinutes,
      stopCount,
      flightNumber,
      baggageSummary,
      refundable,
      changeable,
    };
  }

  async createOrUpdateProjection(
    bookingId: string,
    client?: Prisma.TransactionClient | PrismaService,
  ): Promise<BookingAgentProjection | null> {
    const prismaClient = client || this.prisma;

    const booking = await prismaClient.booking.findUnique({
      where: { id: bookingId },
      include: {
        itineraryRevisions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: { segments: { orderBy: { globalOrder: 'asc' } } },
        },
      },
    });

    if (!booking) {
      this.logger.warn(`Cannot create/update projection: booking ${bookingId} not found`);
      return null;
    }

    const data = this.extractProjectionData(booking);
    if (!data) {
      this.logger.warn(
        `Cannot create/update projection: no flight data found for booking ${bookingId}`,
      );
      return null;
    }

    let agentReference: string;
    const existing = await prismaClient.bookingAgentProjection.findUnique({
      where: { bookingId },
    });

    if (existing) {
      agentReference = existing.agentReference;
    } else {
      agentReference = this.generateAgentReference();
    }

    let attempt = 0;
    let result: BookingAgentProjection | null = null;

    while (attempt < 3 && !result) {
      try {
        result = await prismaClient.bookingAgentProjection.upsert({
          where: { bookingId },
          create: {
            bookingId,
            agentReference,
            status: booking.status,
            airline: data.airline,
            origin: data.origin,
            destination: data.destination,
            departureAt: data.departureAt,
            arrivalAt: data.arrivalAt,
            durationMinutes: data.durationMinutes,
            stopCount: data.stopCount,
            flightNumber: data.flightNumber,
            baggageSummary: data.baggageSummary,
            refundable: data.refundable,
            changeable: data.changeable,
          },
          update: {
            status: booking.status,
            airline: data.airline,
            origin: data.origin,
            destination: data.destination,
            departureAt: data.departureAt,
            arrivalAt: data.arrivalAt,
            durationMinutes: data.durationMinutes,
            stopCount: data.stopCount,
            flightNumber: data.flightNumber,
            baggageSummary: data.baggageSummary,
            refundable: data.refundable,
            changeable: data.changeable,
          },
        });
      } catch (error: any) {
        if (error.code === 'P2002' && attempt < 2) {
          attempt++;
          agentReference = this.generateAgentReference();
        } else {
          throw error;
        }
      }
    }

    return result;
  }

  async updateProjectionStatus(
    bookingId: string,
    status: string,
    client?: Prisma.TransactionClient | PrismaService,
  ): Promise<BookingAgentProjection | null> {
    const prismaClient = client || this.prisma;
    const updated = await prismaClient.bookingAgentProjection.updateMany({
      where: { bookingId },
      data: { status },
    });

    if (updated.count === 0) {
      return await this.createOrUpdateProjection(bookingId, prismaClient);
    }

    return await prismaClient.bookingAgentProjection.findUnique({
      where: { bookingId },
    });
  }

  async getProjectionByBookingId(
    bookingId: string,
    client?: Prisma.TransactionClient | PrismaService,
  ): Promise<BookingAgentProjection | null> {
    const prismaClient = client || this.prisma;
    return prismaClient.bookingAgentProjection.findUnique({
      where: { bookingId },
    });
  }

  async getProjectionByReference(
    agentReference: string,
    userId: string,
  ): Promise<BookingAgentProjection | null> {
    const projection = await this.prisma.bookingAgentProjection.findUnique({
      where: { agentReference },
      include: {
        booking: {
          select: { userId: true },
        },
      },
    });

    if (!projection || projection.booking.userId !== userId) {
      return null;
    }

    return projection;
  }

  async backfill(batchSize = 50): Promise<{ processed: number; success: number; failed: number }> {
    let processed = 0;
    let success = 0;
    let failed = 0;
    let lastId: string | undefined = undefined;

    while (true) {
      const bookings: any[] = await this.prisma.booking.findMany({
        take: batchSize,
        skip: lastId ? 1 : 0,
        ...(lastId && { cursor: { id: lastId } }),
        orderBy: { id: 'asc' },
        include: {
          itineraryRevisions: {
            orderBy: { version: 'desc' },
            take: 1,
            include: { segments: { orderBy: { globalOrder: 'asc' } } },
          },
        },
      });

      if (bookings.length === 0) {
        break;
      }

      for (const booking of bookings) {
        processed++;
        try {
          const res = await this.createOrUpdateProjection(booking.id);
          if (res) {
            success++;
          } else {
            failed++;
          }
        } catch (err) {
          failed++;
        }
        lastId = booking.id;
      }
    }

    return { processed, success, failed };
  }
}
