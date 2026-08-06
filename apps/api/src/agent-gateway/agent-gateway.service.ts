import { Injectable, NotFoundException, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelService } from '@/duffel/duffel.service';
import { DuffelBaggage } from '@/duffel/duffel.types';
import { SelectionAttestationService } from './selection-attestation.service';
import { FlightSearchQueryDto } from './dto/flight-search-query.dto';
import { AttestedFlightSearchDto } from './dto/attested-flight-search.dto';
import { FlightSearchResponseDto, FlightResultDto } from './dto/flight-result.dto';
import { UserPreferencesDto } from './dto/user-preferences.dto';
import { UserBookingsResponseDto, BookingResultDto } from './dto/user-bookings.dto';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import * as crypto from 'crypto';
import { CABIN_KEYWORDS, PASSENGER_KEYWORDS } from './agent-gateway.constants';
import {
  AgentBookingReadinessRequestDto,
  AgentBookingReadinessResponseDto,
} from './dto/booking-readiness.dto';
import { BookingReadinessService } from '@/booking-intent/booking-readiness.service';
import { BookingReadinessObservability } from '@/booking-intent/booking-readiness.observability';
import { BookingReadinessOperation } from '@/common/observability/booking-readiness-observability.types';
import { ProfileService } from '@/profile/profile.service';
import { BookingReadinessRequestDto, BookingReadinessPassengerDto } from '@/booking-intent/dto/booking-readiness.dto';
import { ChatService } from '@/chat/chat.service';

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
    private readonly profileService: ProfileService,
    private readonly bookingReadinessService: BookingReadinessService,
    private readonly bookingReadinessObservability: BookingReadinessObservability,
    private readonly configService: ConfigService,
    private readonly chatService: ChatService,
    private readonly selectionAttestationService: SelectionAttestationService,
  ) {}

  /**
   * Verifies user active status and token non-revocation.
   */
  async checkUserAccess(dto: { sub: string; jti?: string; exp?: number }): Promise<{ allowed: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.sub },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new HttpException(
        { code: 'UNAUTHORIZED', message: 'User is inactive or not found' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (dto.jti) {
      const isJtiBlacklisted = await this.cacheService.get(`blacklist:jti:${dto.jti}`);
      if (isJtiBlacklisted) {
        throw new HttpException(
          { code: 'UNAUTHORIZED', message: 'Token JTI has been revoked' },
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    return { allowed: true };
  }

  /**
   * Validates fencing token using Redis session lock if Phase 4 write fence is enabled.
   */
  async validateFencingToken(
    userId: string,
    sessionId: string,
    fencingToken?: string | null,
  ): Promise<void> {
    return this.chatService.validateFencingToken(userId, sessionId, fencingToken);
  }

  /**
   * Creates a chat session for a claimed user.
   */
  async createSession(userId: string, title?: string) {
    return this.chatService.createSession(userId, title);
  }

  /**
   * Gets memory for a session.
   */
  async getMemory(userId: string, sessionId: string, query: { recentCount?: number; unsummarizedOnly?: boolean }) {
    return this.chatService.getMemory(userId, sessionId, {
      recentCount: query.recentCount || 20,
      unsummarizedOnly: query.unsummarizedOnly || false,
    });
  }

  /**
   * Creates a chat message in the session with write fence validation.
   */
  async createChatMessage(
    userId: string,
    sessionId: string,
    dto: { sender: string; content: string; type?: string },
    fencingToken?: string | null,
  ) {
    try {
      return await this.chatService.createMessage(
        userId,
        sessionId,
        {
          sender: dto.sender as any,
          content: dto.content,
          type: (dto.type || 'STANDARD') as any,
        },
        undefined,
        undefined,
        undefined,
        fencingToken || undefined,
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'Session not found',
          code: 'CHAT_SESSION_NOT_FOUND',
        });
      }
      throw err;
    }
  }

  async createMessageBatch(
    userId: string,
    sessionId: string,
    dto: { messages: Array<{ sender: string; content: string; type?: string }> },
    fencingToken?: string | null,
  ) {
    try {
      return await this.chatService.createMessageBatch(
        userId,
        sessionId,
        {
          messages: dto.messages.map((m) => ({
            sender: m.sender as any,
            content: m.content,
            type: (m.type || 'STANDARD') as any,
          })),
        },
        undefined,
        undefined,
        undefined,
        fencingToken || undefined,
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'Session not found',
          code: 'CHAT_SESSION_NOT_FOUND',
        });
      }
      throw err;
    }
  }

  /**
   * Soft deletes a chat session.
   */
  async deleteSession(userId: string, sessionId: string) {
    return this.chatService.deleteSession(userId, sessionId);
  }

  private async recordReadinessOutcome(
    userId: string,
    status: string,
    startedAt: number,
    traceId: string | null | undefined,
    correlationId: string | null | undefined,
    passengerCount: number,
    scope: string | null,
    error = false,
  ): Promise<void> {
    const metadata = { status, scope, passengerCount };
    this.bookingReadinessObservability.recordOutcome({
      status,
      error,
      operation: BookingReadinessOperation.GATEWAY_READINESS,
      latencyMs: Date.now() - startedAt,
      metadata,
      context: { traceId: traceId ?? undefined, correlationId: correlationId ?? undefined },
    });

    try {
      await this.auditService.createLog(null, {
        userId,
        action: 'AGENT_GATEWAY_READINESS',
        resourceType: 'agent-gateway',
        resourceId: 'bookings/readiness',
        metadata,
        traceId,
        correlationId,
      });
    } catch {
      this.logger.error('Failed to write booking readiness audit log');
    }
  }

  private readinessErrorCode(error: unknown): string {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'object' && response !== null && 'code' in response) {
        const code = (response as { code?: unknown }).code;
        if (typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)) {
          return code;
        }
      }
      return `HTTP_${error.getStatus()}`;
    }

    return 'READINESS_REQUEST_FAILED';
  }

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
      const adultsCount = query.adults || query.passengers;
      if (!adultsCount) {
        throw new HttpException('Adults count is required', HttpStatus.BAD_REQUEST);
      }

      // Check for user's latest chat message and perform honest degradation keyword validation
      let lastMessage = null;
      if (correlationId) {
        lastMessage = await this.prisma.chatMessage.findFirst({
          where: {
            sender: 'USER',
            sessionId: correlationId,
          },
          orderBy: { createdAt: 'desc' },
        });
      }

      if (!lastMessage) {
        lastMessage = await this.prisma.chatMessage.findFirst({
          where: {
            sender: 'USER',
            session: { userId },
          },
          orderBy: { createdAt: 'desc' },
        });
      }

      if (lastMessage && lastMessage.content) {
        const matchedKeywords: string[] = [];
        const content = lastMessage.content;

        for (const kw of CABIN_KEYWORDS) {
          const regex = new RegExp(`\\b${kw}\\b`, 'i');
          if (regex.test(content)) {
            matchedKeywords.push(kw);
          }
        }

        for (const kw of PASSENGER_KEYWORDS) {
          const regex = new RegExp(`\\b${kw}\\b`, 'i');
          if (regex.test(content)) {
            matchedKeywords.push(kw);
          }
        }

        if (matchedKeywords.length > 0) {
          this.logger.warn(
            `Agent gateway keyword trigger matched for user ${userId}. Matched keywords: ${matchedKeywords.join(', ')}`
          );

          // Write audit log
          await this.auditService.createLog(null, {
            userId,
            action: 'AGENT_KEYWORD_TRIGGER',
            resourceType: 'agent-gateway',
            resourceId: lastMessage.id,
            metadata: {
              matchedKeywords,
              messageId: lastMessage.id,
            },
            traceId,
            correlationId,
          });

          throw new HttpException(
            'I can currently only search economy class for adult passengers. For other cabin classes or passenger types, please use the search page.',
            HttpStatus.BAD_REQUEST,
          );
        }
      }

      // 1. Check Redis cache first for mapped results
      const normalizedQuery = {
        origin: query.origin.trim().toUpperCase(),
        destination: query.destination.trim().toUpperCase(),
        date: query.date,
        adults: adultsCount,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
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
            adults: adultsCount,
            children: 0,
            infants: 0,
            cabinClass: 'economy',
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

  async searchFlightsV2(
    userId: string,
    dto: AttestedFlightSearchDto,
    traceId: string | null = null,
    correlationId: string | null = null,
  ): Promise<any> {
    const startTime = Date.now();
    try {
      // 1. Verify owned ChatSession
      const chatSession = await this.prisma.chatSession.findFirst({
        where: { id: dto.chatSessionId, userId, deletedAt: null },
      });
      if (!chatSession) {
        throw new HttpException('Chat session not found', HttpStatus.NOT_FOUND);
      }

      // Check degradation triggers
      let adultsCount = dto.search.adults;
      if (adultsCount === undefined) {
        adultsCount = (dto.search as any).passengers;
      }
      if (adultsCount === undefined) {
        throw new HttpException(
          'At least one of adults or passengers must be provided',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Check for user's latest chat message and perform honest degradation keyword validation
      const lastMessage = await this.prisma.chatMessage.findFirst({
        where: {
          sender: 'USER',
          sessionId: dto.chatSessionId,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (lastMessage && lastMessage.content) {
        const matchedKeywords: string[] = [];
        const content = lastMessage.content;

        for (const kw of CABIN_KEYWORDS) {
          const regex = new RegExp(`\\b${kw}\\b`, 'i');
          if (regex.test(content)) {
            matchedKeywords.push(kw);
          }
        }

        for (const kw of PASSENGER_KEYWORDS) {
          const regex = new RegExp(`\\b${kw}\\b`, 'i');
          if (regex.test(content)) {
            matchedKeywords.push(kw);
          }
        }

        if (matchedKeywords.length > 0) {
          this.logger.warn(
            `Agent gateway keyword trigger matched for user ${userId}. Matched keywords: ${matchedKeywords.join(', ')}`
          );

          // Write audit log
          await this.auditService.createLog(null, {
            userId,
            action: 'AGENT_KEYWORD_TRIGGER',
            resourceType: 'agent-gateway',
            resourceId: lastMessage.id,
            metadata: {
              matchedKeywords,
              messageId: lastMessage.id,
            },
            traceId,
            correlationId: correlationId || dto.chatSessionId,
          });

          throw new HttpException(
            'I can currently only search economy class for adult passengers. For other cabin classes or passenger types, please use the search page.',
            HttpStatus.BAD_REQUEST,
          );
        }
      }

      // Call DuffelService
      let rawResponse;
      let createdOffers;
      try {
        const searchResult = await this.duffelService.searchFlights(
          {
            origin: dto.search.origin,
            destination: dto.search.destination,
            departureDate: dto.search.date,
            adults: adultsCount,
            children: 0,
            infants: 0,
            cabinClass: 'economy',
          },
          'agent',
        );
        rawResponse = searchResult.offerRequest;
        createdOffers = searchResult.flightOffers || [];
      } catch (err: unknown) {
        if (err instanceof HttpException) throw err;
        throw new HttpException(
          {
            message: err instanceof Error ? err.message : 'Upstream flight search service is temporarily unavailable',
            code: 'UPSTREAM_UNAVAILABLE',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }

      const offers = rawResponse.offers || [];
      const limitedOffers = offers.slice(0, 5);
      
      const results = [];
      const attestationOffers = [];
      const expiresAt = new Date(Date.now() + 15 * 60000); // 15 mins

      for (let i = 0; i < limitedOffers.length; i++) {
        const offer = limitedOffers[i];
        const slice = offer.slices?.[0];
        if (!slice || !slice.segments || slice.segments.length === 0) continue;
        
        const createdOffer = createdOffers.find((co: any) => co.duffelOfferId === offer.id);
        if (!createdOffer) continue;

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

        attestationOffers.push({ flightOfferId: createdOffer.id, duffelOfferId: offer.id });
        results.push({
          flightOfferId: createdOffer.id,
          duffelOfferId: offer.id,
          offerExpiresAt: expiresAt.toISOString(),
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

      const selectionAttestation = await this.selectionAttestationService.signSelectionAttestation(
        userId,
        dto.chatSessionId,
        dto.proposedSnapshotVersion,
        expiresAt.toISOString(),
        attestationOffers,
      );

      return {
        selectionAttestation,
        snapshotVersion: dto.proposedSnapshotVersion,
        snapshotExpiresAt: expiresAt.toISOString(),
        results,
      };
    } catch (err: unknown) {
      this.logger.error(`Failed to search flights V2: ${err}`);
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
        // Assert JsonValue type to FlightSnapshot/PassengerSnapshot as Prisma returns loose JSON
        const flight = b.flightSnapshot as unknown as FlightSnapshot | null;
        const passenger = b.passengerSnapshot as unknown as PassengerSnapshot | null;

        const firstSegment = flight?.segments?.[0];
        const lastSegment = flight?.segments?.[flight.segments.length - 1];

        // Map status: 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'REFUNDED'
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
          departureTime: b.departureAt?.toISOString() || firstSegment?.departureAt || b.createdAt.toISOString(),
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
      await this.logToolCall(userId, 'users/bookings', {}, startTime, traceId, correlationId, true, null, response);
      return response;
    } catch (err) {
      await this.logToolCall(userId, 'users/bookings', {}, startTime, traceId, correlationId, false, err, null);
      throw err;
    }
  }

  async checkBookingReadiness(
    userId: string,
    dto: AgentBookingReadinessRequestDto,
    traceId?: string | null,
    correlationId?: string | null,
  ): Promise<AgentBookingReadinessResponseDto> {
    const startTime = Date.now();
    try {
      // 1. Get primary profile ID if needed
      let travelerProfileId: string | null = null;
      if (dto.passengers.some((p) => p.sourceType === 'traveler_profile')) {
        const profile = await this.profileService.getProfile(userId);
        if (!profile || !profile.profileId) {
          throw new NotFoundException({
            statusCode: 404,
            message: 'No traveler profile exists for this user',
            code: 'PROFILE_NOT_FOUND',
          });
        }
        travelerProfileId = profile.profileId;
      }

      // 2. Map passenger ordinals to offerPassengerId
      const flightOffer = await this.prisma.flightOffer.findUnique({
        where: { id: dto.flightOfferId },

      });

      if (!flightOffer) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'Flight offer not found',
          code: 'OFFER_NOT_FOUND',
        });
      }

      const rawOffer = flightOffer.rawOffer as { passengers?: Array<{ id?: string }> } | null;
      if (!rawOffer || !Array.isArray(rawOffer.passengers)) {
        throw new HttpException(
          { code: 'OFFER_MALFORMED', message: 'Stored offer data is malformed' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const internalDto = new BookingReadinessRequestDto();
      internalDto.flightOfferId = dto.flightOfferId;
      internalDto.passengers = dto.passengers.map((p) => {
        // ordinal is 1-indexed
        const passengerIndex = p.passengerOrdinal - 1;
        const offerPassenger = (rawOffer as any)?.passengers?.[passengerIndex];
        if (!offerPassenger || !offerPassenger.id) {
          throw new HttpException(
            { code: 'PASSENGER_MAPPING_INVALID', message: `No passenger found for ordinal ${p.passengerOrdinal}` },
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        const pdto = new BookingReadinessPassengerDto();
        pdto.offerPassengerId = offerPassenger.id;
        pdto.passengerType = p.passengerType;

        if (p.sourceType === 'traveler_profile') {
          if (!travelerProfileId) {
             throw new HttpException(
              { code: 'PROFILE_NOT_FOUND', message: 'Profile not found' },
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }
          pdto.source = {
            type: 'traveler_profile',
            travelerProfileId: travelerProfileId,
          };
        } else {
          pdto.source = {
            type: 'inline',
          };
        }
        return pdto;
      });

      // 3. Call internal readiness service
      const result = await this.bookingReadinessService.getAdvisoryReadiness(
        userId,
        internalDto,
        { traceId: traceId || undefined, correlationId: correlationId || undefined },
      );

      // 4. Extract safe fields for projection
      // The result is already safe from getAdvisoryReadiness (BookingReadinessResult)
      // We explicitly map it to ensure no PII leaks.
      const hasInlinePassengers = dto.passengers.some((p) => p.sourceType === 'inline');
      
      const safeResponse: AgentBookingReadinessResponseDto = {
        scope: result.scope,
        ready: result.ready,
        passengers: result.passengers.map((p) => ({
          passengerType: p.passengerType as any,
          passengerOrdinal: p.passengerOrdinal,
          sections: p.sections.map((s) => ({
            name: s.name,
            fields: s.fields.map((f) => ({
              name: f.name,
              status: f.status as string,
              reason: f.reason,
            })),
          })),
        })),
        nextAction: result.ready || hasInlinePassengers ? 'CONTINUE_CHECKOUT' : 'COMPLETE_PROFILE',
      };

      await this.recordReadinessOutcome(
        userId,
        result.ready ? 'ready' : 'not_ready',
        startTime,
        traceId,
        correlationId,
        dto.passengers.length,
        result.scope,
      );

      return safeResponse;
    } catch (err: unknown) {
      const status = this.readinessErrorCode(err);
      await this.recordReadinessOutcome(
        userId,
        status,
        startTime,
        traceId,
        correlationId,
        dto.passengers.length,
        null,
        !(err instanceof HttpException) || err.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR,
      );

      if (err instanceof HttpException) {
        throw err;
      }

      throw new HttpException(
        { code: 'READINESS_REQUEST_FAILED', message: 'Failed to evaluate booking readiness' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
