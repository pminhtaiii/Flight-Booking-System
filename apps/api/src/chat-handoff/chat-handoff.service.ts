import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import {
  createChatTelemetryEvent,
  emitChatTelemetry,
  type ChatTelemetryContext,
  type ChatTelemetryOperation,
} from '@/common/observability/chat-observability';
import { CreateChatHandoffDto } from './dto/create-chat-handoff.dto';
import { ChatHandoffResponseDto } from './dto/chat-handoff-response.dto';
import { ChatHandoffTokenService } from './chat-handoff-token.service';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';

type JsonRecord = Record<string, unknown>;

type ResolvedChatHandoff = Prisma.ChatHandoffGetPayload<{
  include: {
    chatSession: {
      select: {
        userId: true;
        deletedAt: true;
      };
    };
  };
}>;

export type ChatHandoffSafeResolveResponse = {
  status: 'ACTIVE' | 'CLAIMED' | 'CONSUMED';
  expiresAt: string;
  offer: {
    airline: string;
    origin: string;
    destination: string;
    departureAt: string;
    arrivalAt: string;
    price: string;
    currency: string;
    adults: number;
    children: number;
    infants: number;
  };
  passengers?: Array<{ id: string; type: 'ADULT' | 'CHILD' | 'INFANT' }>;
};

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isoDateValue(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function firstFlightSegment(rawOffer: unknown): JsonRecord | null {
  if (!isJsonRecord(rawOffer) || !Array.isArray(rawOffer.slices)) {
    return null;
  }

  const firstSlice = rawOffer.slices[0];
  if (!isJsonRecord(firstSlice) || !Array.isArray(firstSlice.segments)) {
    return null;
  }

  const firstSegment = firstSlice.segments[0];
  return isJsonRecord(firstSegment) ? firstSegment : null;
}

function lastFlightSegment(rawOffer: unknown): JsonRecord | null {
  if (!isJsonRecord(rawOffer) || !Array.isArray(rawOffer.slices)) {
    return null;
  }

  const lastSlice = rawOffer.slices[rawOffer.slices.length - 1];
  if (!isJsonRecord(lastSlice) || !Array.isArray(lastSlice.segments)) {
    return null;
  }

  const lastSegment = lastSlice.segments[lastSlice.segments.length - 1];
  return isJsonRecord(lastSegment) ? lastSegment : null;
}

function handoffPassengers(rawOffer: JsonRecord | null): Array<{ id: string; type: 'ADULT' | 'CHILD' | 'INFANT' }> | null {
  if (!rawOffer || !Array.isArray(rawOffer.passengers)) return null;
  const passengers = rawOffer.passengers.map((passenger) => {
    if (!isJsonRecord(passenger)) return null;
    const id = stringValue(passenger.id);
    const type = stringValue(passenger.type)?.toUpperCase();
    return id && (type === 'ADULT' || type === 'CHILD' || type === 'INFANT') ? { id, type } : null;
  });
  return passengers.every((passenger) => passenger !== null)
    ? passengers as Array<{ id: string; type: 'ADULT' | 'CHILD' | 'INFANT' }>
    : null;
}

/**
 * ChatHandoffService — implementation.
 */
@Injectable()
export class ChatHandoffService {
  private readonly logger = new Logger(ChatHandoffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly tokenService: ChatHandoffTokenService,
    private readonly selectionAttestationService: SelectionAttestationService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  /**
   * Creates a new chat handoff claim record.
   */
  async create(
    dto: CreateChatHandoffDto,
    context: ChatTelemetryContext = {},
  ): Promise<ChatHandoffResponseDto> {
    const startedAt = Date.now();
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ISSUE') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException('Chat handoff issuance is disabled');
    }

    const parts = dto.selectionAttestationHash.split('_v1_');
    if (parts.length !== 2) throw new UnauthorizedException('Invalid attestation format');
    const [payloadBase64, signature] = parts[1].split('.');
    if (!payloadBase64 || !signature) throw new UnauthorizedException('Invalid attestation format');
    const payloadStr = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    let payload;
    try {
      payload = JSON.parse(payloadStr);
    } catch (e) {
      throw new UnauthorizedException('Invalid attestation payload');
    }
    const {
      userId,
      sessionId: chatSessionId,
      version: snapshotVersion,
      expiresAt: attestationExpiresAt,
      offers,
    } = payload;
    if (!offers || !Array.isArray(offers))
      throw new UnauthorizedException('Invalid attestation offers');
    if (dto.selectedOfferIndex < 1 || dto.selectedOfferIndex > offers.length) {
      throw new UnauthorizedException('Selected offer index out of bounds');
    }

    await this.selectionAttestationService.verifySelectionAttestation(
      dto.selectionAttestationHash,
      userId,
      chatSessionId,
      snapshotVersion,
      offers,
    );

    const selectedOffer = offers[dto.selectedOfferIndex - 1];
    const flightOfferId = selectedOffer.flightOfferId;
    const duffelOfferIdHash = crypto
      .createHash('sha256')
      .update(selectedOffer.duffelOfferId)
      .digest('hex');
    const snapshotFingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify(offers))
      .digest('hex');

    const idempotencyHash = this.tokenService.deriveIdempotencyHash(
      dto.selectionAttestationHash,
      dto.selectedOfferIndex,
    );

    try {
      const attestationExpiry = new Date(attestationExpiresAt);
      const expiresAt = new Date(
        Math.min(Date.now() + 15 * 60 * 1000, attestationExpiry.getTime()),
      );
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
        throw new GoneException({
          code: 'HANDOFF_OFFER_STALE',
          message: 'Handoff offer is stale',
        });
      }
      const id = crypto.randomUUID();
      const { token, tokenHash, keyVersion } = await this.tokenService.generateToken(
        id,
        idempotencyHash,
      );
      const selectionAttestationHash = crypto
        .createHash('sha256')
        .update(dto.selectionAttestationHash)
        .digest('hex');

      const record = await this.prisma.chatHandoff.create({
        data: {
          id,
          userId,
          chatSessionId,
          flightOfferId,
          duffelOfferIdHash,
          selectionAttestationHash,
          selectedOfferIndex: dto.selectedOfferIndex,
          snapshotVersion,
          snapshotFingerprint,
          tokenHash,
          tokenKeyVersion: keyVersion,
          idempotencyKeyHash: idempotencyHash,
          expiresAt,
        },
      });

      await this.recordTelemetry(
        'handoff_create',
        'created',
        Date.now() - startedAt,
        context,
        userId,
        { outcome: 'created' },
      );

      return {
        token,
        expiresAt: record.expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.chatHandoff.findUnique({
          where: { idempotencyKeyHash: idempotencyHash },
        });
        if (!existing) {
          throw new ConflictException('Idempotency collision but record not found');
        }

        const { token } = await this.tokenService.generateToken(
          existing.id,
          existing.idempotencyKeyHash,
        );

        await this.recordTelemetry(
          'handoff_replay',
          'replayed',
          Date.now() - startedAt,
          context,
          userId,
          { outcome: 'idempotent_retry', retry: true },
        );

        return {
          token,
          expiresAt: existing.expiresAt.toISOString(),
        };
      }
      throw error;
    }
  }

  /**
   * Resolves a handoff token, binding it to an authenticated user.
   */
  async resolve(
    token: string,
    userId: string,
    context: ChatTelemetryContext = {},
  ): Promise<ResolvedChatHandoff> {
    const startedAt = Date.now();
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException({
        code: 'CHAT_HANDOFF_DISABLED',
        message: 'Chat handoff acceptance is disabled',
      });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const record = await this.prisma.chatHandoff.findUnique({
      where: { tokenHash },
      include: {
        chatSession: {
          select: {
            userId: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!record) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff not found',
      });
    }

    if (
      record.userId !== userId ||
      record.chatSession.userId !== userId ||
      record.chatSession.deletedAt !== null
    ) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff not found',
      });
    }

    if (record.expiresAt < new Date()) {
      throw new GoneException({
        code: 'HANDOFF_EXPIRED',
        message: 'Handoff expired',
      });
    }

    const isValid = await this.tokenService.verifyToken(
      token,
      record.tokenHash,
      record.tokenKeyVersion,
    );
    if (!isValid) {
      throw new BadRequestException({
        code: 'HANDOFF_TOKEN_INVALID',
        message: 'Invalid handoff token',
      });
    }

    const operation: ChatTelemetryOperation = record.consumedAt
      ? 'handoff_replay'
      : 'handoff_resolve';
    await this.recordTelemetry(
      operation,
      record.consumedAt ? 'replayed' : 'resolved',
      Date.now() - startedAt,
      context,
      userId,
      { outcome: record.consumedAt ? 'already_consumed' : 'resolved' },
    );

    return record;
  }

  async resolveSafe(
    token: string,
    userId: string,
    context: ChatTelemetryContext = {},
  ): Promise<ChatHandoffSafeResolveResponse> {
    const handoff: unknown = await this.resolve(token, userId, context);
    if (!isJsonRecord(handoff)) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff not found',
      });
    }

    if (handoff.consumedAt !== null && handoff.consumedAt !== undefined) {
      throw new ConflictException({
        code: 'HANDOFF_ALREADY_CONSUMED',
        message: 'Handoff already consumed',
      });
    }

    const now = new Date();
    const claimExpiresAt = isoDateValue(handoff.claimExpiresAt);
    const claimRecoverAfter = isoDateValue(handoff.claimRecoverAfter);
    if (
      (claimExpiresAt && new Date(claimExpiresAt) > now) ||
      (claimRecoverAfter && new Date(claimRecoverAfter) > now)
    ) {
      throw new ConflictException({
        code: 'HANDOFF_IN_PROGRESS',
        message: 'Handoff in progress',
      });
    }

    const flightOfferId = stringValue(handoff.flightOfferId);
    const duffelOfferIdHash = stringValue(handoff.duffelOfferIdHash);
    const expiresAt = isoDateValue(handoff.expiresAt);
    if (!flightOfferId || !duffelOfferIdHash || !expiresAt) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff offer unavailable',
      });
    }

    const flightOffer = await this.prisma.flightOffer.findUnique({
      where: { id: flightOfferId },
      select: {
        duffelOfferId: true,
        origin: true,
        destination: true,
        adults: true,
        children: true,
        infants: true,
        price: true,
        currency: true,
        rawOffer: true,
      },
    });
    if (!flightOffer) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff offer unavailable',
      });
    }

    const computedDuffelOfferIdHash = crypto
      .createHash('sha256')
      .update(flightOffer.duffelOfferId)
      .digest('hex');
    if (computedDuffelOfferIdHash !== duffelOfferIdHash) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff offer unavailable',
      });
    }

    const rawOffer = isJsonRecord(flightOffer.rawOffer) ? flightOffer.rawOffer : null;
    const passengers = handoffPassengers(rawOffer);
    const offerExpiresAt = isoDateValue(rawOffer?.expires_at);
    if (!offerExpiresAt || new Date(offerExpiresAt) <= new Date()) {
      throw new GoneException({
        code: 'HANDOFF_OFFER_STALE',
        message: 'Handoff offer is stale',
      });
    }

    const firstSegment = firstFlightSegment(rawOffer);
    const lastSegment = lastFlightSegment(rawOffer);
    const departureAt = firstSegment ? stringValue(firstSegment.departing_at) : null;
    const arrivalAt = lastSegment ? stringValue(lastSegment.arriving_at) : null;
    if (!departureAt || !arrivalAt) {
      throw new NotFoundException('Handoff offer unavailable');
    }

    const operatingCarrier =
      firstSegment && isJsonRecord(firstSegment.operating_carrier)
        ? firstSegment.operating_carrier
        : null;
    const marketingCarrier =
      firstSegment && isJsonRecord(firstSegment.marketing_carrier)
        ? firstSegment.marketing_carrier
        : null;
    const airline =
      stringValue(operatingCarrier?.name) ??
      stringValue(marketingCarrier?.name) ??
      'Unknown Airline';

    return {
      status: 'ACTIVE',
      expiresAt,
      offer: {
        airline,
        origin: flightOffer.origin,
        destination: flightOffer.destination,
        departureAt,
        arrivalAt,
        price: String(flightOffer.price),
        currency: flightOffer.currency,
        adults: flightOffer.adults,
        children: flightOffer.children,
        infants: flightOffer.infants,
      },
      ...(passengers && passengers.length > 0 ? { passengers } : {}),
    };
  }

  private async recordTelemetry(
    operation: ChatTelemetryOperation,
    status: string,
    latencyMs: number,
    context: ChatTelemetryContext,
    userId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      const event = createChatTelemetryEvent(operation, status, latencyMs, context, metadata);
      emitChatTelemetry(this.logger, event);

      if (this.auditService) {
        const auditWrite = this.auditService.createLog(null, {
          userId,
          action:
            operation === 'handoff_create'
              ? 'chat_handoff_created'
              : operation === 'handoff_resolve'
                ? 'chat_handoff_resolved'
                : 'chat_handoff_replay',
          resourceType: 'ChatHandoff',
          resourceId: null,
          metadata: {
            operation: event.operation,
            metric: event.metric,
            status: event.status,
            latency_ms: event.latency_ms,
            ...event.metadata,
          },
          traceId: event.trace_id,
          correlationId: event.correlation_id,
        });
        void Promise.resolve(auditWrite).catch(() => {
          this.logger.warn('chat_handoff_telemetry_failed');
        });
      }
    } catch {
      // Telemetry must never change the handoff result or expose raw failures.
      this.logger.warn('chat_handoff_telemetry_failed');
    }
  }

  /**
   * Acquires a temporary claim over a handoff record to prevent concurrent checkouts.
   */
  async acquireClaim(handoffId: string, userId: string, ttlMs: number): Promise<string> {
    const claimToken = crypto.randomUUID();
    const claimTokenHash = crypto.createHash('sha256').update(claimToken).digest('hex');
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + ttlMs);
    const claimRecoverAfter = new Date(now.getTime() + ttlMs + 5000); // 5s recovery buffer

    const result = await this.prisma.chatHandoff.updateMany({
      where: {
        id: handoffId,
        userId: userId,
        consumedAt: null,
        expiresAt: { gt: now },
        OR: [{ claimRecoverAfter: null }, { claimRecoverAfter: { lte: now } }],
      },
      data: {
        claimedAt: now,
        claimTokenHash,
        claimExpiresAt,
        claimRecoverAfter,
      },
    });

    if (result.count === 0) {
      throw new ConflictException('Failed to acquire handoff claim');
    }

    return claimToken;
  }

  /**
   * Refreshes an existing claim to extend its TTL.
   */
  async refreshClaim(handoffId: string, claimToken: string, ttlMs: number): Promise<void> {
    const claimTokenHash = crypto.createHash('sha256').update(claimToken).digest('hex');
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + ttlMs);
    const claimRecoverAfter = new Date(now.getTime() + ttlMs + 5000);

    const result = await this.prisma.chatHandoff.updateMany({
      where: {
        id: handoffId,
        claimTokenHash,
        consumedAt: null,
        claimExpiresAt: { gt: now },
      },
      data: {
        claimExpiresAt,
        claimRecoverAfter,
      },
    });

    if (result.count === 0) {
      throw new ConflictException('Claim lost or expired');
    }
  }

  /**
   * Releases an existing claim, making the handoff available for others.
   */
  async releaseClaim(handoffId: string, claimToken: string, maxRetries = 3): Promise<void> {
    const claimTokenHash = crypto.createHash('sha256').update(claimToken).digest('hex');
    const now = new Date();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.prisma.chatHandoff.updateMany({
          where: {
            id: handoffId,
            claimTokenHash,
            consumedAt: null,
            claimExpiresAt: { gt: now },
          },
          data: {
            claimedAt: null,
            claimTokenHash: null,
            claimExpiresAt: null,
            claimRecoverAfter: null,
          },
        });
        return;
      } catch (error) {
        if (attempt === maxRetries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }
}
