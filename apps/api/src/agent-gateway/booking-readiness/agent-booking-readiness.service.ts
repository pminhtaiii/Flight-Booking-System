import { Injectable, NotFoundException, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { ProfileService } from '@/profile/profile.service';
import { BookingReadinessService } from '@/booking-intent/booking-readiness.service';
import { BookingReadinessObservability } from '@/booking-intent/booking-readiness.observability';
import { BookingReadinessOperation } from '@/common/observability/booking-readiness-observability.types';
import {
  BookingReadinessRequestDto,
  BookingReadinessPassengerDto,
} from '@/booking-intent/dto/booking-readiness.dto';
import { AuditService } from '@/audit/audit.service';
import { AgentToolAuditService } from '../audit/agent-tool-audit.service';
import {
  AgentBookingReadinessRequestDto,
  AgentBookingReadinessResponseDto,
} from '../dto/booking-readiness.dto';
import { PassengerType } from '@prisma/client';

@Injectable()
export class AgentBookingReadinessService {
  private readonly logger = new Logger(AgentBookingReadinessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly profileService: ProfileService,
    private readonly bookingReadinessService: BookingReadinessService,
    private readonly bookingReadinessObservability: BookingReadinessObservability,
    private readonly auditService: AuditService,
    private readonly agentToolAuditService: AgentToolAuditService,
  ) {}

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
      const offerPassengers = rawOffer?.passengers;
      if (!rawOffer || !Array.isArray(offerPassengers)) {
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
        const offerPassenger = offerPassengers[passengerIndex];
        if (!offerPassenger || !offerPassenger.id) {
          throw new HttpException(
            {
              code: 'PASSENGER_MAPPING_INVALID',
              message: `No passenger found for ordinal ${p.passengerOrdinal}`,
            },
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
      const result = await this.bookingReadinessService.getAdvisoryReadiness(userId, internalDto, {
        traceId: traceId || undefined,
        correlationId: correlationId || undefined,
      });

      // 4. Extract safe fields for projection
      const hasInlinePassengers = dto.passengers.some((p) => p.sourceType === 'inline');

      const safeResponse: AgentBookingReadinessResponseDto = {
        scope: result.scope,
        ready: result.ready,
        passengers: result.passengers.map((p) => ({
          passengerType: p.passengerType as PassengerType,
          passengerOrdinal: p.passengerOrdinal,
          sections: p.sections.map((s) => ({
            name: s.name,
            fields: s.fields.map((f) => ({
              name: f.name,
              status: f.status,
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

      await this.logToolCall(
        userId,
        'bookings/readiness',
        dto,
        startTime,
        traceId,
        correlationId,
        true,
        null,
        safeResponse,
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
        dto.passengers?.length || 0,
        null,
        !(err instanceof HttpException) || err.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR,
      );

      await this.logToolCall(
        userId,
        'bookings/readiness',
        dto,
        startTime,
        traceId,
        correlationId,
        false,
        err,
        null,
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
