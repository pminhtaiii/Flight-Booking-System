import {
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
    const { userId, sessionId: chatSessionId, version: snapshotVersion, offers } = payload;
    if (!offers || !Array.isArray(offers)) throw new UnauthorizedException('Invalid attestation offers');
    if (dto.selectedOfferIndex < 1 || dto.selectedOfferIndex > offers.length) {
      throw new UnauthorizedException('Selected offer index out of bounds');
    }

    await this.selectionAttestationService.verifySelectionAttestation(
      dto.selectionAttestationHash,
      userId,
      chatSessionId,
      snapshotVersion,
      offers
    );

    const selectedOffer = offers[dto.selectedOfferIndex - 1];
    const flightOfferId = selectedOffer.flightOfferId;
    const duffelOfferIdHash = crypto.createHash('sha256').update(selectedOffer.duffelOfferId).digest('hex');
    const snapshotFingerprint = crypto.createHash('sha256').update(JSON.stringify(offers)).digest('hex');

    const idempotencyHash = this.tokenService.deriveIdempotencyHash(
      dto.selectionAttestationHash,
      dto.selectedOfferIndex
    );

    try {
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
      const id = crypto.randomUUID();
      const { token, tokenHash, keyVersion } = await this.tokenService.generateToken(id, idempotencyHash);

      const record = await this.prisma.chatHandoff.create({
        data: {
          id,
          userId,
          chatSessionId,
          flightOfferId,
          duffelOfferIdHash,
          selectionAttestationHash: dto.selectionAttestationHash,
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
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.chatHandoff.findUnique({
          where: { idempotencyKeyHash: idempotencyHash },
        });
        if (!existing) {
          throw new ConflictException('Idempotency collision but record not found');
        }
        
        const { token } = await this.tokenService.generateToken(existing.id, existing.idempotencyKeyHash);
        
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
  ): Promise<any> {
    const startedAt = Date.now();
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException('Chat handoff acceptance is disabled');
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const record = await this.prisma.chatHandoff.findUnique({
      where: { tokenHash },
    });

    if (!record) {
      throw new NotFoundException('Handoff not found');
    }

    if (record.expiresAt < new Date()) {
      throw new GoneException('Handoff expired');
    }

    if (record.userId !== userId) {
      throw new UnauthorizedException('Not authorized for this handoff');
    }
    
    const isValid = await this.tokenService.verifyToken(token, record.tokenHash, record.tokenKeyVersion);
    if (!isValid) {
      throw new UnauthorizedException('Invalid token');
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

  private async recordTelemetry(
    operation: ChatTelemetryOperation,
    status: string,
    latencyMs: number,
    context: ChatTelemetryContext,
    userId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      const event = createChatTelemetryEvent(
        operation,
        status,
        latencyMs,
        context,
        metadata,
      );
      emitChatTelemetry(this.logger, event);

      if (this.auditService) {
        await this.auditService.createLog(null, {
          userId,
          action: operation === 'handoff_create'
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
        OR: [
          { claimExpiresAt: null },
          { claimExpiresAt: { lte: now } },
        ],
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

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.prisma.chatHandoff.updateMany({
          where: {
            id: handoffId,
            claimTokenHash,
            consumedAt: null,
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
