import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelService } from '@/duffel/duffel.service';
import { DuffelBaggage } from '@/duffel/duffel.types';
import { SelectionAttestationService } from '../selection-attestation.service';
import { FlightSearchQueryDto } from '../dto/flight-search-query.dto';
import {
  AttestedFlightSearchDto,
  AttestedFlightSearchResponseDto,
  AttestedFlightSearchResultDto,
} from '../dto/attested-flight-search.dto';
import { FlightSearchResponseDto, FlightResultDto } from '../dto/flight-result.dto';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { CABIN_KEYWORDS, PASSENGER_KEYWORDS } from '../agent-gateway.constants';
import {
  ChatMessageCryptoService,
  CryptoKeyUnavailableError,
  UnsupportedKeyVersionError,
} from '@/chat/chat-message-crypto.service';
import { AgentToolAuditService } from '../audit/agent-tool-audit.service';

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
export class AttestedFlightSearchService {
  private readonly logger = new Logger(AttestedFlightSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cacheService: CacheService,
    private readonly duffelService: DuffelService,
    private readonly selectionAttestationService: SelectionAttestationService,
    private readonly chatMessageCryptoService: ChatMessageCryptoService,
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

      const searchDate = query.date || query.departureDate;
      if (!searchDate) {
        throw new HttpException('Date is required', HttpStatus.BAD_REQUEST);
      }

      const origin = query.origin.trim().toUpperCase();
      const destination = query.destination.trim().toUpperCase();
      const cabinClass = query.cabinClass || 'economy';

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

      if (lastMessage) {
        let content: string;
        try {
          content = await this.chatMessageCryptoService.decryptMessageContent(lastMessage);
        } catch (error: unknown) {
          if (
            error instanceof CryptoKeyUnavailableError ||
            error instanceof UnsupportedKeyVersionError ||
            !this.chatMessageCryptoService.isConfigured() ||
            (error instanceof Error &&
              (error.message.includes('CHAT_ENCRYPTION_KEY') ||
                error.message.includes('Unsupported key version')))
          ) {
            throw new ServiceUnavailableException('Chat encryption service is unavailable');
          }
          throw new HttpException(
            'Unable to decrypt chat message envelope',
            HttpStatus.BAD_REQUEST,
          );
        }
        const matchedKeywords: string[] = [];

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
            `Agent gateway keyword trigger matched for user ${userId}. Matched keywords: ${matchedKeywords.join(', ')}`,
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
        origin,
        destination,
        date: searchDate,
        adults: adultsCount,
        children: 0,
        infants: 0,
        cabinClass,
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
            origin,
            destination,
            departureDate: searchDate,
            adults: adultsCount,
            children: 0,
            infants: 0,
            cabinClass,
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
            message:
              err instanceof Error
                ? err.message
                : 'Upstream flight search service is temporarily unavailable',
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
        const passengerCabinClass = segmentPassenger?.cabin_class || cabinClass;
        const fareClass = passengerCabinClass ? capitalizeCabinClass(passengerCabinClass) : null;

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
  ): Promise<AttestedFlightSearchResponseDto> {
    const startTime = Date.now();
    try {
      // 1. Verify owned ChatSession
      const chatSession = await this.prisma.chatSession.findFirst({
        where: { id: dto.chatSessionId, userId, deletedAt: null },
      });
      if (!chatSession) {
        throw new HttpException('Chat session not found', HttpStatus.NOT_FOUND);
      }

      const proposedSnapshotVersion = dto.proposedSnapshotVersion ?? dto.proposedVersion ?? 1;

      // Check degradation triggers
      let adultsCount = dto.search.adults;
      if (adultsCount === undefined) {
        adultsCount = dto.search.passengers;
      }
      if (adultsCount === undefined) {
        throw new HttpException(
          'At least one of adults or passengers must be provided',
          HttpStatus.BAD_REQUEST,
        );
      }

      const searchDate = dto.search.date || dto.search.departureDate;
      if (!searchDate) {
        throw new HttpException(
          'At least one of date or departureDate must be provided',
          HttpStatus.BAD_REQUEST,
        );
      }

      const origin = dto.search.origin.trim().toUpperCase();
      const destination = dto.search.destination.trim().toUpperCase();
      const cabinClass = dto.search.cabinClass || 'economy';

      // Check for user's latest chat message and perform honest degradation keyword validation
      const lastMessage = await this.prisma.chatMessage.findFirst({
        where: {
          sender: 'USER',
          sessionId: dto.chatSessionId,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (lastMessage) {
        let content: string;
        try {
          content = await this.chatMessageCryptoService.decryptMessageContent(lastMessage);
        } catch (error: unknown) {
          if (
            error instanceof CryptoKeyUnavailableError ||
            error instanceof UnsupportedKeyVersionError ||
            !this.chatMessageCryptoService.isConfigured() ||
            (error instanceof Error &&
              (error.message.includes('CHAT_ENCRYPTION_KEY') ||
                error.message.includes('Unsupported key version')))
          ) {
            throw new ServiceUnavailableException('Chat encryption service is unavailable');
          }
          throw new HttpException(
            'Unable to decrypt chat message envelope',
            HttpStatus.BAD_REQUEST,
          );
        }
        const matchedKeywords: string[] = [];

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
            `Agent gateway keyword trigger matched for user ${userId}. Matched keywords: ${matchedKeywords.join(', ')}`,
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
      let searchHashValue = '';
      try {
        const searchResult = await this.duffelService.searchFlights(
          {
            origin,
            destination,
            departureDate: searchDate,
            adults: adultsCount,
            children: 0,
            infants: 0,
            cabinClass,
          },
          'agent',
        );
        rawResponse = searchResult.offerRequest;
        searchHashValue = searchResult.searchHash;
      } catch (err: unknown) {
        if (err instanceof HttpException) throw err;
        throw new HttpException(
          {
            message:
              err instanceof Error
                ? err.message
                : 'Upstream flight search service is temporarily unavailable',
            code: 'UPSTREAM_UNAVAILABLE',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }

      const offers = rawResponse.offers || [];
      const limitedOffers = offers.slice(0, 5);

      const flightOffersData = limitedOffers.map((offer) => ({
        searchHash: searchHashValue,
        duffelOfferId: offer.id,
        rawOffer: offer as unknown as Prisma.InputJsonValue,
        origin,
        destination,
        departureDate: new Date(searchDate),
        adults: adultsCount,
        cabinClass,
        price: offer.total_amount,
        currency: offer.total_currency,
      }));

      if (flightOffersData.length > 0) {
        await this.prisma.flightOffer.createMany({
          data: flightOffersData,
          skipDuplicates: true,
        });
      }

      const createdOffers = await this.prisma.flightOffer.findMany({
        where: {
          searchHash: searchHashValue,
          duffelOfferId: { in: limitedOffers.map((o) => o.id) },
        },
      });

      const results: AttestedFlightSearchResultDto[] = [];
      const attestationOffers: { flightOfferId: string; duffelOfferId: string }[] = [];
      const expiresAt = new Date(Date.now() + 15 * 60000); // 15 mins

      for (let i = 0; i < limitedOffers.length; i++) {
        const offer = limitedOffers[i];
        const slice = offer.slices?.[0];
        if (!slice || !slice.segments || slice.segments.length === 0) continue;

        const createdOffer = createdOffers.find((co) => co.duffelOfferId === offer.id);
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
        const passengerCabinClass = segmentPassenger?.cabin_class || cabinClass;
        const fareClass = passengerCabinClass ? capitalizeCabinClass(passengerCabinClass) : null;

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

      const selectionAttestation =
        await this.selectionAttestationService.signSelectionAttestation(
          userId,
          dto.chatSessionId,
          proposedSnapshotVersion,
          expiresAt.toISOString(),
          attestationOffers,
        );

      const response = {
        selectionAttestation,
        snapshotVersion: proposedSnapshotVersion,
        snapshotExpiresAt: expiresAt.toISOString(),
        results,
      };

      await this.logToolCall(
        userId,
        'v2/flights/search',
        dto,
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
        'v2/flights/search',
        dto,
        startTime,
        traceId,
        correlationId,
        false,
        err,
        null,
      );
      this.logger.error('Failed to search flights V2');
      throw err;
    }
  }
}
