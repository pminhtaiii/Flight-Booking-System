import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { SelectionAttestationService } from '../selection-attestation.service';
import { FlightSearchQueryDto } from '../dto/flight-search-query.dto';
import {
  AttestedFlightSearchDto,
  AttestedFlightSearchResponseDto,
  AttestedFlightSearchResultDto,
} from '../dto/attested-flight-search.dto';
import { FlightSearchResponseDto, FlightResultDto } from '../dto/flight-result.dto';
import { CABIN_KEYWORDS, PASSENGER_KEYWORDS } from '../agent-gateway.constants';
import {
  ChatMessageCryptoService,
  CryptoKeyUnavailableError,
  UnsupportedKeyVersionError,
} from '@/chat/chat-message-crypto.service';
import { AgentToolAuditService } from '../audit/agent-tool-audit.service';
import { FlightsService } from '@/flights/flights.service';
import { FlightSearchRequestDto } from '@/flights/dto/search-flight.dto';

@Injectable()
export class AttestedFlightSearchService {
  private readonly logger = new Logger(AttestedFlightSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly selectionAttestationService: SelectionAttestationService,
    private readonly chatMessageCryptoService: ChatMessageCryptoService,
    private readonly agentToolAuditService: AgentToolAuditService,
    private readonly flightsService: FlightsService,
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

  private buildFlightSearchRequest(query: FlightSearchQueryDto): FlightSearchRequestDto {
    let adultsCount = query.adults;
    if (adultsCount === undefined) {
      adultsCount = query.passengers;
    }
    if (adultsCount === undefined || adultsCount === null || adultsCount <= 0) {
      throw new HttpException(
        'At least one of adults or passengers must be provided',
        HttpStatus.BAD_REQUEST,
      );
    }

    const searchDate = query.date || query.departureDate;
    if (!searchDate) {
      throw new HttpException(
        'At least one of date or departureDate must be provided',
        HttpStatus.BAD_REQUEST,
      );
    }

    const origin = (query.origin || '').trim().toUpperCase();
    const destination = (query.destination || '').trim().toUpperCase();
    const cabinClass: FlightSearchRequestDto['cabinClass'] = query.cabinClass || 'economy';

    return {
      origin,
      destination,
      departureDate: searchDate,
      adults: adultsCount,
      children: 0,
      infants: 0,
      cabinClass,
    };
  }

  async searchFlights(
    userId: string,
    query: FlightSearchQueryDto,
    traceId?: string | null,
    correlationId?: string | null,
  ): Promise<FlightSearchResponseDto> {
    const startTime = Date.now();
    try {
      const mappedQuery = this.buildFlightSearchRequest(query);

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

      // Delegate to canonical FlightsService search
      let searchResponse;
      try {
        searchResponse = await this.flightsService.search(
          userId,
          mappedQuery,
          traceId || undefined,
          correlationId || undefined,
          { caller: 'agent' },
        );
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

      // Slice canonical results to top 5
      const limitedOffers = (searchResponse.results || []).slice(0, 5);

      const results: FlightResultDto[] = [];
      for (const offer of limitedOffers) {
        results.push({
          airline: offer.airline,
          flightNumber: offer.flightNumber,
          departureAirport: offer.departureAirport,
          arrivalAirport: offer.arrivalAirport,
          departureTime: offer.departureTime,
          arrivalTime: offer.arrivalTime,
          duration: offer.duration,
          stops: offer.stops,
          price: offer.price,
          currency: offer.currency,
          fareClass: offer.fareClass,
          baggageAllowance: offer.baggageAllowance,
          matchResult: offer.matchResult ?? null,
        });
      }

      const response: FlightSearchResponseDto = {
        mode: searchResponse.mode,
        results,
        meta: searchResponse.meta
          ? {
              scoringVersion: searchResponse.meta.scoringVersion ?? null,
              totalResults: searchResponse.meta.totalResults,
              cached: searchResponse.meta.cached,
              searchHash: searchResponse.meta.searchHash,
            }
          : undefined,
      };

      // Log TOOL_CALL audit log
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

      // Check degradation triggers and build mapped search query
      const mappedQuery = this.buildFlightSearchRequest(dto.search);

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

      // Delegate to canonical FlightsService search
      let searchResponse;
      try {
        searchResponse = await this.flightsService.search(
          userId,
          mappedQuery,
          traceId || undefined,
          correlationId || dto.chatSessionId,
          { caller: 'agent', persistence: 'required' },
        );
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

      const limitedOffers = (searchResponse.results || []).slice(0, 5);
      const results: AttestedFlightSearchResultDto[] = [];
      const attestationOffers: { flightOfferId: string; duffelOfferId: string }[] = [];
      const expiresAt = new Date(Date.now() + 15 * 60000); // 15 mins

      for (const offer of limitedOffers) {
        attestationOffers.push({ flightOfferId: offer.id, duffelOfferId: offer.duffelOfferId });
        results.push({
          flightOfferId: offer.id,
          duffelOfferId: offer.duffelOfferId,
          offerExpiresAt: expiresAt.toISOString(),
          airline: offer.airline,
          flightNumber: offer.flightNumber,
          departureAirport: offer.departureAirport,
          arrivalAirport: offer.arrivalAirport,
          departureTime: offer.departureTime,
          arrivalTime: offer.arrivalTime,
          duration: offer.duration,
          stops: offer.stops,
          price: offer.price,
          currency: offer.currency,
          fareClass: offer.fareClass,
          baggageAllowance: offer.baggageAllowance,
          matchResult: offer.matchResult ?? null,
        });
      }

      const selectionAttestation = await this.selectionAttestationService.signSelectionAttestation(
        userId,
        dto.chatSessionId,
        proposedSnapshotVersion,
        expiresAt.toISOString(),
        attestationOffers,
      );

      const response: AttestedFlightSearchResponseDto = {
        selectionAttestation,
        snapshotVersion: proposedSnapshotVersion,
        snapshotExpiresAt: expiresAt.toISOString(),
        mode: searchResponse.mode,
        meta: {
          scoringVersion: searchResponse.meta.scoringVersion ?? null,
          totalResults: searchResponse.meta.totalResults,
          cached: searchResponse.meta.cached,
          searchHash: searchResponse.meta.searchHash,
        },
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
