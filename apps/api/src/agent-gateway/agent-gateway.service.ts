import { Injectable, NotFoundException, Logger, HttpException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { FlightSearchQueryDto } from './dto/flight-search-query.dto';
import { FlightSearchResponseDto, FlightResultDto } from './dto/flight-result.dto';
import { UserPreferencesDto } from './dto/user-preferences.dto';
import { UserBookingsResponseDto, BookingResultDto } from './dto/user-bookings.dto';

@Injectable()
export class AgentGatewayService {
  private readonly logger = new Logger(AgentGatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private async logToolCall(
    userId: string,
    toolName: string,
    params: unknown,
    startTime: number,
    traceId?: string | null,
    correlationId?: string | null,
    success: boolean = true,
    error: unknown = null,
    response: unknown = null,
  ) {
    const durationMs = Date.now() - startTime;
    const responseSize = response ? Buffer.byteLength(JSON.stringify(response)) : 0;
    
    let errorMessage: string | null = null;
    if (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      if (error instanceof HttpException) {
        errorMessage = rawMessage;
      } else {
        const errorName = error instanceof Error ? error.name : 'Error';
        errorMessage = `Internal Service Error: ${errorName}`;
      }
      if (errorMessage.length > 256) {
        errorMessage = errorMessage.substring(0, 256) + '...';
      }
    }

    try {
      await this.auditService.createLog(null, {
        userId,
        action: 'TOOL_CALL',
        resourceType: 'agent-gateway',
        resourceId: toolName,
        metadata: {
          toolName,
          responseSize,
          durationMs,
          claimTokenUserId: userId,
          parameters: params,
          success,
          errorMessage,
        },
        traceId,
        correlationId,
      });
    } catch (logErr: unknown) {
      const logMsg = logErr instanceof Error ? logErr.message : String(logErr);
      this.logger.error(`Failed to write tool call audit log: ${logMsg}`);
    }
  }

  async searchFlights(
    userId: string,
    query: FlightSearchQueryDto,
    traceId?: string | null,
    correlationId?: string | null,
  ): Promise<FlightSearchResponseDto> {
    const startTime = Date.now();
    try {
      const { origin, destination, date, passengers } = query;

      // Mock flight search results (Amadeus client/cache is Phase 3)
      const results: FlightResultDto[] = [
        {
          airline: 'Vietnam Airlines',
          flightNumber: 'VN310',
          departureAirport: origin,
          arrivalAirport: destination,
          departureTime: `${date}T08:30:00Z`,
          arrivalTime: `${date}T15:00:00Z`,
          duration: 330,
          stops: 0,
          price: 452.00 * passengers,
          currency: 'USD',
          fareClass: 'Economy',
          baggageAllowance: '23kg checked + 7kg carry-on',
        },
        {
          airline: 'ANA',
          flightNumber: 'NH858',
          departureAirport: origin,
          arrivalAirport: destination,
          departureTime: `${date}T10:15:00Z`,
          arrivalTime: `${date}T17:45:00Z`,
          duration: 390,
          stops: 1,
          price: 389.00 * passengers,
          currency: 'USD',
          fareClass: 'Economy',
          baggageAllowance: '23kg checked + 7kg carry-on',
        },
        {
          airline: 'Japan Airlines',
          flightNumber: 'JL752',
          departureAirport: origin,
          arrivalAirport: destination,
          departureTime: `${date}T23:55:00Z`,
          arrivalTime: `${date}T07:30:00Z`,
          duration: 335,
          stops: 0,
          price: 520.00 * passengers,
          currency: 'USD',
          fareClass: 'Business',
          baggageAllowance: '32kg checked + 10kg carry-on',
        },
        {
          airline: 'VietJet Air',
          flightNumber: 'VJ932',
          departureAirport: origin,
          arrivalAirport: destination,
          departureTime: `${date}T00:15:00Z`,
          arrivalTime: `${date}T08:00:00Z`,
          duration: 345,
          stops: 0,
          price: 199.00 * passengers,
          currency: 'USD',
          fareClass: 'Eco',
          baggageAllowance: '7kg carry-on only',
        },
        {
          airline: 'Singapore Airlines',
          flightNumber: 'SQ176',
          departureAirport: origin,
          arrivalAirport: destination,
          departureTime: `${date}T12:00:00Z`,
          arrivalTime: `${date}T21:30:00Z`,
          duration: 570,
          stops: 1,
          price: 610.00 * passengers,
          currency: 'USD',
          fareClass: 'Premium Economy',
          baggageAllowance: '30kg checked + 7kg carry-on',
        },
      ];

      const response = { results };
      await this.logToolCall(userId, 'flights/search', query, startTime, traceId, correlationId, true, null, response);
      return response;
    } catch (err) {
      await this.logToolCall(userId, 'flights/search', query, startTime, traceId, correlationId, false, err, null);
      throw err;
    }
  }

  async getUserPreferences(
    userId: string,
    traceId?: string | null,
    correlationId?: string | null,
  ): Promise<UserPreferencesDto> {
    const startTime = Date.now();
    try {
      // Exclude passportNumber and passportExpiry at query level via Prisma select
      const profile = await this.prisma.travelerProfile.findUnique({
        where: { userId },
        select: {
          seatPreference: true,
          classPreference: true,
          preferredAirlines: true,
          blacklistedAirlines: true,
          dietaryNeeds: true,
        },
      });

      if (!profile) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'No traveler profile exists for this user',
          code: 'PROFILE_NOT_FOUND',
        });
      }

      await this.logToolCall(userId, 'users/preferences', {}, startTime, traceId, correlationId, true, null, profile);
      return profile;
    } catch (err) {
      await this.logToolCall(userId, 'users/preferences', {}, startTime, traceId, correlationId, false, err, null);
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
      // Exclude pnrCode, eTicketNumber, and paymentReference at query level via Prisma select
      const bookings = await this.prisma.booking.findMany({
        where: { userId },
        select: {
          id: true,
          airline: true,
          flightNumber: true,
          origin: true,
          destination: true,
          departureTime: true,
          arrivalTime: true,
          duration: true,
          stops: true,
          fareClass: true,
          price: true,
          currency: true,
          passengers: true,
          baggageAllowance: true,
          status: true,
        },
      });

      const formattedBookings: BookingResultDto[] = bookings.map((b) => ({
        id: b.id,
        airline: b.airline,
        flightNumber: b.flightNumber,
        origin: b.origin,
        destination: b.destination,
        departureTime: b.departureTime.toISOString(),
        arrivalTime: b.arrivalTime.toISOString(),
        duration: b.duration,
        stops: b.stops,
        fareClass: b.fareClass,
        price: Number(b.price),
        currency: b.currency,
        passengers: b.passengers,
        baggageAllowance: b.baggageAllowance,
        status: b.status as 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'REFUNDED',
      }));

      const response = { bookings: formattedBookings };
      await this.logToolCall(userId, 'users/bookings', {}, startTime, traceId, correlationId, true, null, response);
      return response;
    } catch (err) {
      await this.logToolCall(userId, 'users/bookings', {}, startTime, traceId, correlationId, false, err, null);
      throw err;
    }
  }
}
