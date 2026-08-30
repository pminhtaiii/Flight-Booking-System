import { Injectable, NotFoundException, Logger, HttpException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AgentToolAuditService } from '../audit/agent-tool-audit.service';
import { BookingSummaryDto, BookingSummariesResponseDto } from '../dto/booking-summary.dto';
import { BookingDetailDto } from '../dto/booking-detail.dto';
import { UserBookingsResponseDto, BookingResultDto } from '../dto/user-bookings.dto';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';

function parseISODurationToMinutes(durationStr: string): number {
  const regex = /P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/;
  const matches = durationStr.match(regex);
  if (!matches) return 0;
  const days = parseInt(matches[1] || '0', 10);
  const hours = parseInt(matches[2] || '0', 10);
  const minutes = parseInt(matches[3] || '0', 10);
  return days * 1440 + hours * 60 + minutes;
}

@Injectable()
export class SafeBookingReadService {
  private readonly logger = new Logger(SafeBookingReadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentToolAuditService: AgentToolAuditService,
  ) {}

  private async logToolCall(
    userId: string,
    toolName: string,
    _params: unknown = null,
    startTime: number,
    traceId?: string | null,
    correlationId?: string | null,
    success: boolean = true,
    error: unknown = null,
    response: unknown = null,
  ) {
    const durationMs = Date.now() - startTime;
    const responseSizeBytes = response ? Buffer.byteLength(JSON.stringify(response)) : 0;

    let errorCode: string | null = null;
    if (error) {
      if (error instanceof HttpException) {
        const responseObj = error.getResponse();
        if (
          typeof responseObj === 'object' &&
          responseObj !== null &&
          'code' in responseObj &&
          typeof (responseObj as { code?: unknown }).code === 'string'
        ) {
          errorCode = (responseObj as { code: string }).code;
        } else {
          errorCode = `HTTP_${error.getStatus()}`;
        }
      } else {
        errorCode = 'INTERNAL_ERROR';
      }
    }

    await this.agentToolAuditService.recordToolExecution({
      toolName,
      actorId: userId,
      outcome: success ? 'SUCCESS' : 'FAILURE',
      durationMs,
      responseSizeBytes,
      occurredAt: new Date().toISOString(),
      errorCode: errorCode || undefined,
      traceId: traceId || undefined,
      correlationId: correlationId || undefined,
    });
  }

  async getBookingSummaries(
    userId: string,
    traceId?: string | null,
    correlationId?: string | null,
  ): Promise<BookingSummariesResponseDto> {
    const startTime = Date.now();
    try {
      const projections = await this.prisma.bookingAgentProjection.findMany({
        where: { booking: { userId } },
        select: {
          agentReference: true,
          airline: true,
          origin: true,
          destination: true,
          departureAt: true,
          arrivalAt: true,
          status: true,
          durationMinutes: true,
          stopCount: true,
        },
        orderBy: { departureAt: 'asc' },
      });

      const bookings: BookingSummaryDto[] = projections.map((p) => ({
        bookingReference: p.agentReference,
        airline: p.airline,
        origin: p.origin,
        destination: p.destination,
        departureTime: p.departureAt.toISOString(),
        arrivalTime: p.arrivalAt.toISOString(),
        status: p.status,
        durationMinutes: p.durationMinutes,
        stops: p.stopCount,
      }));

      const response: BookingSummariesResponseDto = { bookings };
      await this.logToolCall(
        userId,
        'users/bookings/summaries',
        {},
        startTime,
        traceId,
        correlationId,
        true,
        null,
        response,
      );
      return response;
    } catch (err) {
      await this.logToolCall(
        userId,
        'users/bookings/summaries',
        {},
        startTime,
        traceId,
        correlationId,
        false,
        err,
        null,
      );
      throw err;
    }
  }

  async getBookingDetailByReference(
    userId: string,
    bookingReference: string,
    traceId?: string | null,
    correlationId?: string | null,
  ): Promise<BookingDetailDto> {
    const startTime = Date.now();
    try {
      const BKREF_REGEX = /^bkref_[0-9a-fA-F-]{36}$/;
      if (!bookingReference || !BKREF_REGEX.test(bookingReference)) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'Booking reference not found',
          code: 'BOOKING_REFERENCE_NOT_FOUND',
        });
      }

      const projection = await this.prisma.bookingAgentProjection.findUnique({
        where: { agentReference: bookingReference },
        select: {
          agentReference: true,
          airline: true,
          origin: true,
          destination: true,
          departureAt: true,
          arrivalAt: true,
          status: true,
          durationMinutes: true,
          stopCount: true,
          flightNumber: true,
          baggageSummary: true,
          refundable: true,
          changeable: true,
          booking: {
            select: {
              userId: true,
            },
          },
        },
      });

      if (!projection || projection.booking.userId !== userId) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'Booking reference not found',
          code: 'BOOKING_REFERENCE_NOT_FOUND',
        });
      }

      const detail: BookingDetailDto = {
        bookingReference: projection.agentReference,
        airline: projection.airline,
        origin: projection.origin,
        destination: projection.destination,
        departureTime: projection.departureAt.toISOString(),
        arrivalTime: projection.arrivalAt.toISOString(),
        status: projection.status,
        durationMinutes: projection.durationMinutes,
        stops: projection.stopCount,
        flightNumber: projection.flightNumber ?? null,
        baggageAllowance: projection.baggageSummary ?? null,
        changeable: projection.changeable ?? null,
        refundable: projection.refundable ?? null,
      };

      await this.logToolCall(
        userId,
        'users/bookings/detail',
        { bookingReference },
        startTime,
        traceId,
        correlationId,
        true,
        null,
        detail,
      );

      return detail;
    } catch (err) {
      await this.logToolCall(
        userId,
        'users/bookings/detail',
        { bookingReference },
        startTime,
        traceId,
        correlationId,
        false,
        err,
        null,
      );
      throw err;
    }
  }

  async getUserBookings(
    userId: string,
    traceId?: string | null,
    correlationId?: string | null,
  ): Promise<UserBookingsResponseDto> {
    const startTime = Date.now();
    try {
      const bookings = await this.prisma.booking.findMany({
        where: { userId },
        include: {
          payment: {
            select: {
              status: true,
            },
          },
        },
      });

      const formattedBookings: BookingResultDto[] = bookings.map((b) => {
        const flight = b.flightSnapshot as unknown as FlightSnapshot | null;
        const passenger = b.passengerSnapshot as unknown as PassengerSnapshot | null;

        const firstSegment = flight?.segments?.[0];
        const lastSegment = flight?.segments?.[flight.segments.length - 1];

        let mappedStatus: 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'REFUNDED' = 'PENDING';
        if (b.payment?.status === 'REFUNDED') {
          mappedStatus = 'REFUNDED';
        } else if (b.status === 'PROCESSING') {
          mappedStatus = 'PENDING';
        } else if (b.status === 'FAILED') {
          mappedStatus = 'CANCELLED';
        } else if (b.status === 'CONFIRMED' || b.status === 'COMPLETED') {
          mappedStatus = 'CONFIRMED';
        }

        return {
          id: b.id,
          airline: firstSegment?.airline?.iataCode || 'Unknown',
          flightNumber: firstSegment?.flightNumber || 'Unknown',
          origin: firstSegment?.departureAirport?.iataCode || 'Unknown',
          destination: lastSegment?.arrivalAirport?.iataCode || 'Unknown',
          departureTime:
            b.departureAt?.toISOString() || firstSegment?.departureAt || b.createdAt.toISOString(),
          arrivalTime: lastSegment?.arrivalAt || b.createdAt.toISOString(),
          duration: flight?.totalDuration ? parseISODurationToMinutes(flight.totalDuration) : 0,
          stops: flight?.stops ?? 0,
          fareClass: flight?.fareClass || 'Economy',
          price: Number(b.totalAmount),
          currency: b.currency,
          passengers: passenger?.passengers?.length || 1,
          baggageAllowance: flight?.baggageAllowance || 'No checked baggage',
          status: mappedStatus,
        };
      });

      const response = { bookings: formattedBookings };
      await this.logToolCall(
        userId,
        'users/bookings',
        {},
        startTime,
        traceId,
        correlationId,
        true,
        null,
        response,
      );
      return response;
    } catch (err) {
      await this.logToolCall(
        userId,
        'users/bookings',
        {},
        startTime,
        traceId,
        correlationId,
        false,
        err,
        null,
      );
      throw err;
    }
  }
}
