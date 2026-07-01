import { Injectable, NotFoundException, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { CacheService } from '@/cache/cache.service';
import { AmadeusService } from './amadeus/amadeus.service';
import { FlightSearchQueryDto } from './dto/flight-search-query.dto';
import { FlightSearchResponseDto, FlightResultDto } from './dto/flight-result.dto';
import { UserPreferencesDto } from './dto/user-preferences.dto';
import { UserBookingsResponseDto, BookingResultDto } from './dto/user-bookings.dto';
import * as crypto from 'crypto';

function toTitleCase(str: string): string {
  if (!str) return '';
  return str
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function parseISODurationToMinutes(durationStr: string): number {
  const regex = /P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/;
  const matches = durationStr.match(regex);
  if (!matches) return 0;
  const days = parseInt(matches[1] || '0', 10);
  const hours = parseInt(matches[2] || '0', 10);
  const minutes = parseInt(matches[3] || '0', 10);
  return days * 1440 + hours * 60 + minutes;
}

function formatBaggageAllowance(baggage?: { quantity?: number; weight?: number; weightUnit?: string }): string {
  if (!baggage) return 'No checked baggage';
  if (typeof baggage.quantity === 'number') {
    return `${baggage.quantity} checked bag(s)`;
  }
  if (typeof baggage.weight === 'number') {
    return `${baggage.weight}${baggage.weightUnit?.toLowerCase() || 'kg'} checked`;
  }
  return 'No checked baggage';
}

@Injectable()
export class AgentGatewayService {
  private readonly logger = new Logger(AgentGatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cacheService: CacheService,
    private readonly amadeusService: AmadeusService,
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
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const budgetKey = `budget:amadeus:${year}-${month}`;

      // 1. Perform budget check
      const currentBudgetStr = await this.cacheService.get(budgetKey);
      const currentBudget = currentBudgetStr ? parseInt(currentBudgetStr, 10) : 0;
      if (currentBudget >= 2000) {
        throw new HttpException(
          {
            message: 'Amadeus API monthly search budget limit exceeded',
            code: 'RATE_LIMIT_EXCEEDED',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // 2. Check Redis cache first
      const normalizedQuery = {
        origin: query.origin,
        destination: query.destination,
        date: query.date,
        passengers: Number(query.passengers),
      };
      const queryStr = JSON.stringify(normalizedQuery);
      const sha256 = crypto.createHash('sha256').update(queryStr).digest('hex');
      const cacheKey = `flights:search:${sha256}`;

      const cachedData = await this.cacheService.get(cacheKey);
      if (cachedData) {
        const parsed = JSON.parse(cachedData) as FlightSearchResponseDto;
        await this.logToolCall(
          userId,
          'flights/search',
          query,
          startTime,
          traceId,
          correlationId,
          true,
          null,
          parsed,
        );
        return parsed;
      }

      // 3. On cache miss: increment budget
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      const ttlSeconds = Math.max(0, Math.ceil((endOfMonth.getTime() - Date.now()) / 1000));
      await this.cacheService.incr(budgetKey, ttlSeconds);

      // 4. Call AmadeusService.searchFlights()
      let rawResponse;
      try {
        rawResponse = await this.amadeusService.searchFlights(query);
      } catch (err: unknown) {
        if (err instanceof HttpException) {
          throw err;
        }
        throw new HttpException(
          {
            message: err instanceof Error ? err.message : 'Upstream flight search service is temporarily unavailable',
            code: 'UPSTREAM_UNAVAILABLE',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }

      // 5. Parse/map raw response to FlightResultDto (limit to 5 results)
      const offers = rawResponse.data || [];
      const limitedOffers = offers.slice(0, 5);

      const results: FlightResultDto[] = [];
      for (const offer of limitedOffers) {
        const itinerary = offer.itineraries?.[0];
        if (!itinerary || !itinerary.segments || itinerary.segments.length === 0) {
          continue;
        }

        const segments = itinerary.segments;
        const firstSegment = segments[0];
        const lastSegment = segments[segments.length - 1];

        const carrierCode = firstSegment.carrierCode;
        const rawAirlineName = rawResponse.dictionaries?.carriers?.[carrierCode] || carrierCode;
        const airline = toTitleCase(rawAirlineName);
        const flightNumber = `${firstSegment.carrierCode}${firstSegment.number}`;

        const departureAirport = firstSegment.departure.iataCode;
        const arrivalAirport = lastSegment.arrival.iataCode;
        const departureTime = firstSegment.departure.at;
        const arrivalTime = lastSegment.arrival.at;

        const duration = parseISODurationToMinutes(itinerary.duration);
        const stops = segments.length - 1;

        const price = parseFloat(offer.price.total);
        const currency = offer.price.currency;

        const travelerPricing = offer.travelerPricings?.[0];
        const firstSegmentFareDetails = travelerPricing?.fareDetailsBySegment?.[0];
        const fareClass = firstSegmentFareDetails?.cabin ? toTitleCase(firstSegmentFareDetails.cabin) : null;
        const baggageAllowance = firstSegmentFareDetails ? formatBaggageAllowance(firstSegmentFareDetails.includedCheckedBags) : null;

        results.push({
          airline,
          flightNumber,
          departureAirport,
          arrivalAirport,
          departureTime,
          arrivalTime,
          duration,
          stops,
          price,
          currency,
          fareClass,
          baggageAllowance,
        });
      }

      const response: FlightSearchResponseDto = { results };

      // 6. Cache mapped results in Redis with TTL 900 seconds
      await this.cacheService.set(cacheKey, JSON.stringify(response), 900);

      // 7. Log TOOL_CALL audit log
      await this.logToolCall(
        userId,
        'flights/search',
        query,
        startTime,
        traceId,
        correlationId,
        true,
        null,
        response,
      );

      return response;
    } catch (err: unknown) {
      await this.logToolCall(
        userId,
        'flights/search',
        query,
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
