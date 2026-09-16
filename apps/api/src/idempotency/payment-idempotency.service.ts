import {
  Injectable,
  Logger,
  ConflictException,
  UnprocessableEntityException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';

export interface SagaOwnership {
  key: string;
  userId: string;
  requestPath: string;
  requestHash: string;
  lockedAt: Date;
}

export type SagaCheckpoint =
  | 'started'
  | 'stripe_authorized'
  | 'duffel_order_created'
  | 'captured'
  | 'completed';

export const SAGA_CHECKPOINTS: readonly SagaCheckpoint[] = [
  'started',
  'stripe_authorized',
  'duffel_order_created',
  'captured',
  'completed',
] as const;

@Injectable()
export class PaymentIdempotencyService {
  private readonly logger = new Logger(PaymentIdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Acquires a lock or replays the response for an idempotency key.
   */
  async acquireOrReplay(
    key: string,
    requestHash: string,
    userId: string,
    requestPath: string,
  ): Promise<
    | { status: 'acquired'; lockedAt: Date }
    | { status: 'replay'; responseCode: number; responseBody: string }
  > {
    const now = new Date();
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });

    if (existing) {
      this.ensureKeyScope(existing, userId, requestPath);

      if (existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException('Idempotency key reuse with different payload');
      }

      if (existing.responseBody !== null) {
        return {
          status: 'replay',
          responseCode: existing.responseCode!,
          responseBody:
            typeof existing.responseBody === 'string'
              ? existing.responseBody
              : JSON.stringify(existing.responseBody),
        };
      }

      if (existing.lockedAt !== null) {
        const lockedTime = new Date(existing.lockedAt).getTime();
        const diffMinutes = (now.getTime() - lockedTime) / (1000 * 60);
        if (diffMinutes < 5) {
          throw new ConflictException('Request is already in progress');
        }
      }

      // Stale lock: update lockedAt to now to acquire the lock atomically
      const result = await this.prisma.idempotencyKey.updateMany({
        where: {
          id: existing.id,
          lockedAt: existing.lockedAt,
        },
        data: {
          lockedAt: now,
        },
      });

      if (result.count === 0) {
        throw new ConflictException('Request is already in progress');
      }

      return { status: 'acquired', lockedAt: now };
    }

    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      await this.prisma.idempotencyKey.create({
        data: {
          key,
          requestHash,
          customerId: userId,
          requestPath,
          lockedAt: now,
          recoveryPoint: 'started',
          expiresAt,
        },
      });

      return { status: 'acquired', lockedAt: now };
    } catch (error) {
      const err = error as { code?: string };
      // Handle race condition on duplicate key check
      if (err.code === 'P2002') {
        this.logger.warn(
          `Race condition met for key creation: ${key}. Re-evaluating existing key logic.`,
        );
        return this.handleExistingKeyAfterRace(key, requestHash, userId, requestPath, now);
      }
      throw error;
    }
  }

  /**
   * Helper to handle the existing key logic if we lose a creation race.
   */
  private async handleExistingKeyAfterRace(
    key: string,
    requestHash: string,
    userId: string,
    requestPath: string,
    now: Date,
  ): Promise<
    | { status: 'acquired'; lockedAt: Date }
    | { status: 'replay'; responseCode: number; responseBody: string }
  > {
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });

    if (!existing) {
      throw new ConflictException('Idempotency key conflict');
    }

    this.ensureKeyScope(existing, userId, requestPath);

    if (existing.requestHash !== requestHash) {
      throw new UnprocessableEntityException('Idempotency key reuse with different payload');
    }

    if (existing.responseBody !== null) {
      return {
        status: 'replay',
        responseCode: existing.responseCode!,
        responseBody:
          typeof existing.responseBody === 'string'
            ? existing.responseBody
            : JSON.stringify(existing.responseBody),
      };
    }

    if (existing.lockedAt !== null) {
      const lockedTime = new Date(existing.lockedAt).getTime();
      const diffMinutes = (now.getTime() - lockedTime) / (1000 * 60);
      if (diffMinutes < 5) {
        throw new ConflictException('Request is already in progress');
      }
    }

    const result = await this.prisma.idempotencyKey.updateMany({
      where: {
        id: existing.id,
        lockedAt: existing.lockedAt,
      },
      data: {
        lockedAt: now,
      },
    });

    if (result.count === 0) {
      throw new ConflictException('Request is already in progress');
    }

    return { status: 'acquired', lockedAt: now };
  }

  /**
   * Removes a failed, still-owned acquisition so a corrected request can reuse its key.
   */
  async abandonAcquiredKey(
    key: string,
    requestHash: string,
    userId: string,
    requestPath: string,
    lockedAt: Date,
  ): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({
      where: {
        key,
        requestHash,
        customerId: userId,
        requestPath,
        lockedAt,
        responseBody: { equals: Prisma.DbNull },
      },
    });
  }

  /**
   * Ensures a key can only be used by the customer and route that created it.
   */
  private ensureKeyScope(
    existing: { customerId: string; requestPath: string },
    userId: string,
    requestPath: string,
  ): void {
    if (existing.customerId !== userId || existing.requestPath !== requestPath) {
      throw new ConflictException('Idempotency key is not valid for this request');
    }
  }

  /**
   * Updates the recovery point for a given key.
   */
  async updateRecoveryPoint(key: string, recoveryPoint: string): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: { recoveryPoint },
    });
  }

  /**
   * Completes the key lifecycle, saving the response and unlocking.
   */
  async completeKey(key: string, responseCode: number, responseBody: unknown): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: {
        responseCode,
        responseBody: (responseBody ?? null) as Prisma.InputJsonValue,
        lockedAt: null,
      },
    });
  }

  /**
   * Asserts that the current worker holds active, uncontested ownership of the saga key.
   * Matches key, customerId, requestPath, requestHash, lockedAt, and uncompleted responseBody.
   * If key is deleted, cron-cleared, lease stolen/modified, or completed, throws ConflictException.
   */
  async assertOwned(ownership: SagaOwnership): Promise<void> {
    const existing = await this.prisma.idempotencyKey.findFirst({
      where: {
        key: ownership.key,
        customerId: ownership.userId,
        requestPath: ownership.requestPath,
        requestHash: ownership.requestHash,
        lockedAt: ownership.lockedAt,
        responseBody: { equals: Prisma.DbNull },
      },
      select: { id: true },
    });

    if (!existing) {
      throw new ConflictException('Idempotency key ownership lost');
    }
  }

  /**
   * Atomically advances the saga recovery point without allowing checkpoint regression.
   * Validates transition against current checkpoint, allows same-stage no-op,
   * and conditions atomic update on full ownership predicate and allowed predecessor recoveryPoints.
   */
  async advanceSagaCheckpoint(
    ownership: SagaOwnership,
    targetCheckpoint: SagaCheckpoint,
  ): Promise<void> {
    const existing = await this.prisma.idempotencyKey.findFirst({
      where: {
        key: ownership.key,
        customerId: ownership.userId,
        requestPath: ownership.requestPath,
        requestHash: ownership.requestHash,
        lockedAt: ownership.lockedAt,
        responseBody: { equals: Prisma.DbNull },
      },
      select: {
        recoveryPoint: true,
      },
    });

    if (!existing) {
      throw new ConflictException('Idempotency key ownership lost');
    }

    const targetIndex = SAGA_CHECKPOINTS.indexOf(targetCheckpoint);
    if (targetIndex === -1) {
      throw new ConflictException(`Invalid saga checkpoint: ${targetCheckpoint}`);
    }

    const currentIndex = SAGA_CHECKPOINTS.indexOf(existing.recoveryPoint as SagaCheckpoint);
    if (currentIndex !== -1 && currentIndex > targetIndex) {
      throw new ConflictException(
        `Cannot regress saga checkpoint from '${existing.recoveryPoint}' to '${targetCheckpoint}'`,
      );
    }

    if (currentIndex === targetIndex) {
      return;
    }

    const allowedPredecessors = SAGA_CHECKPOINTS.slice(0, targetIndex);
    const result = await this.prisma.idempotencyKey.updateMany({
      where: {
        key: ownership.key,
        customerId: ownership.userId,
        requestPath: ownership.requestPath,
        requestHash: ownership.requestHash,
        lockedAt: ownership.lockedAt,
        responseBody: { equals: Prisma.DbNull },
        recoveryPoint: { in: [...allowedPredecessors] },
      },
      data: {
        recoveryPoint: targetCheckpoint,
      },
    });

    if (result.count === 0) {
      throw new ConflictException('Idempotency key ownership lost');
    }
  }

  /**
   * Atomically completes the saga key lifecycle: persists responseCode, responseBody,
   * sets recoveryPoint to 'completed', and clears lockedAt in a single owner-fenced update.
   */
  async completeSagaKeyAtomic(
    ownership: SagaOwnership,
    responseCode: number,
    responseBody: unknown,
  ): Promise<void> {
    const result = await this.prisma.idempotencyKey.updateMany({
      where: {
        key: ownership.key,
        customerId: ownership.userId,
        requestPath: ownership.requestPath,
        requestHash: ownership.requestHash,
        lockedAt: ownership.lockedAt,
        responseBody: { equals: Prisma.DbNull },
      },
      data: {
        recoveryPoint: 'completed',
        responseCode,
        responseBody: (responseBody ?? null) as Prisma.InputJsonValue,
        lockedAt: null,
      },
    });

    if (result.count === 0) {
      throw new ConflictException('Idempotency key ownership lost');
    }
  }

  /**
   * Retrieves the current resume recovery point for a key.
   */
  async getResumePoint(key: string): Promise<string | null> {
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });
    return existing ? existing.recoveryPoint : null;
  }

  /**
   * Checks if a key is currently locked (active lock < 5 mins).
   */
  async isLocked(key: string): Promise<boolean> {
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });
    if (!existing || existing.lockedAt === null) {
      return false;
    }
    const lockedTime = new Date(existing.lockedAt).getTime();
    const diffMinutes = (Date.now() - lockedTime) / (1000 * 60);
    return diffMinutes < 5;
  }

  /**
   * Deterministically sorts object keys recursively.
   */
  private sortKeys(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.sortKeys(item));
    }
    const record = obj as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce((result: Record<string, unknown>, key) => {
        result[key] = this.sortKeys(record[key]);
        return result;
      }, {});
  }

  /**
   * Computes a deterministic SHA-256 hash of the request body.
   */
  computeHash(body: unknown): string {
    if (body == null) {
      return crypto.createHash('sha256').update('').digest('hex');
    }
    const sorted = this.sortKeys(body);
    const serialized = JSON.stringify(sorted);
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }
}

/**
 * Custom NestJS Param Decorator to extract the idempotency key from headers.
 */
export const IdempotencyKey = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    const header = request.headers['idempotency-key'] || request.headers['Idempotency-Key'];
    if (Array.isArray(header)) {
      return header[0];
    }
    return typeof header === 'string' ? header : undefined;
  },
);
