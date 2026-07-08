import { Injectable, NotFoundException, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelService } from '@/duffel/duffel.service';
import { DuffelBaggage } from '@/duffel/duffel.types';
import { FlightSearchQueryDto } from './dto/flight-search-query.dto';
import { FlightSearchResponseDto, FlightResultDto } from './dto/flight-result.dto';
import { UserPreferencesDto } from './dto/user-preferences.dto';
import { UserBookingsResponseDto, BookingResultDto } from './dto/user-bookings.dto';
import * as crypto from 'crypto';

function capitalizeCabinClass(cabinClass: string): string {
  if (!cabinClass) return '';
  return cabinClass
    .trim()
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function cleanIsoTime(t: string): string {
  if (!t) return '';
  const [datePart, timePartWithOffset] = t.split('T');
  if (!timePartWithOffset) return t;
  const timePart = timePartWithOffset.split('Z')[0].split('+')[0].split('-')[0];
  return `${datePart}T${timePart}`;
}

function formatDuffelBaggageAllowance(baggages?: DuffelBaggage[]): string {
  if (!baggages || baggages.length === 0) return 'No checked baggage';
  const checked = baggages.find((b) => b.type === 'checked');
  if (!checked) {
    return 'No checked baggage';
  }
  if (checked.quantity === 0) {
    return 'No checked baggage';
  }
  if (typeof checked.quantity === 'number') {
    return `${checked.quantity} checked bag(s)`;
  }
  if (typeof checked.weight === 'number') {
    return `${checked.weight}${checked.weight_unit?.toLowerCase() || 'kg'} checked`;
  }
  return 'No checked baggage';
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

@Injectable()
export class AgentGatewayService {
  private readonly logger = new Logger(AgentGatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cacheService: CacheService,
    private readonly duffelService: DuffelService,
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
      // 1. Check Redis cache first for mapped results
      const normalizedQuery = {
        origin: query.origin.trim().toUpperCase(),
        destination: query.destination.trim().toUpperCase(),
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

      // 2. Call DuffelService
      let rawResponse;
      try {
        const searchResult = await this.duffelService.searchFlights(
          {
            origin: query.origin,
            destination: query.destination,
            departureDate: query.date,
            passengers: Number(query.passengers),
          },
          'agent',
        );
        rawResponse = searchResult.offerRequest;
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

      // 3. Parse/map raw response to FlightResultDto (limit to 5 results)
      const offers = rawResponse.offers || [];
      const limitedOffers = offers.slice(0, 5);

      const results: FlightResultDto[] = [];
      for (const offer of limitedOffers) {
        const slice = offer.slices?.[0];
        if (!slice || !slice.segments || slice.segments.length === 0) {
          continue;
        }

        const segments = slice.segments;
        const firstSegment = segments[0];
        const lastSegment = segments[segments.length - 1];

        const airline = firstSegment.operating_carrier?.name || 'Unknown Airline';
        const flightNumber = `${firstSegment.marketing_carrier?.iata_code || ''}${
          firstSegment.marketing_carrier_flight_number || ''
        }`;

        const departureAirport = firstSegment.origin?.iata_code || '';
        const arrivalAirport = lastSegment.destination?.iata_code || '';
        const departureTime = cleanIsoTime(firstSegment.departing_at);
        const arrivalTime = cleanIsoTime(lastSegment.arriving_at);

        let duration = 0;
        if (slice.duration) {
          if (slice.duration.startsWith('P')) {
            duration = parseISODurationToMinutes(slice.duration);
          } else {
            duration = parseInt(slice.duration, 10) || 0;
          }
        }
        const stops = segments.length - 1;

        const price = parseFloat(offer.total_amount);
        const currency = offer.total_currency;

        const segmentPassenger = firstSegment.passengers?.[0];
        const offerPassenger = offer.passengers?.[0];
        const cabinClass = segmentPassenger?.cabin_class || '';
        const fareClass = cabinClass ? capitalizeCabinClass(cabinClass) : null;
        
        const baggages = segmentPassenger?.baggages || offerPassenger?.baggages;
        const baggageAllowance = formatDuffelBaggageAllowance(baggages);

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

      // 4. Cache mapped results in Redis with TTL 900 seconds
      await this.cacheService.set(cacheKey, JSON.stringify(response), 900);

      // 5. Log TOOL_CALL audit log
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
