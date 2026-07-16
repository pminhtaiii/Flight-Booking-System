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
  ): Promise<{ status: 'acquired' } | { status: 'replay'; responseCode: number; responseBody: string }> {
    const now = new Date();
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException('Idempotency key reuse with different payload');
      }

      if (existing.responseBody !== null) {
        return {
          status: 'replay',
          responseCode: existing.responseCode!,
          responseBody: typeof existing.responseBody === 'string'
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

      // Stale lock: update lockedAt to now to acquire the lock
      await this.prisma.idempotencyKey.update({
        where: { id: existing.id },
        data: {
          lockedAt: now,
        },
      });

      return { status: 'acquired' };
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

      return { status: 'acquired' };
    } catch (error) {
      const err = error as { code?: string };
      // Handle race condition on duplicate key check
      if (err.code === 'P2002') {
        this.logger.warn(`Race condition met for key creation: ${key}. Re-evaluating existing key logic.`);
        return this.handleExistingKeyAfterRace(key, requestHash, now);
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
    now: Date,
  ): Promise<{ status: 'acquired' } | { status: 'replay'; responseCode: number; responseBody: string }> {
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });

    if (!existing) {
      throw new ConflictException('Idempotency key conflict');
    }

    if (existing.requestHash !== requestHash) {
      throw new UnprocessableEntityException('Idempotency key reuse with different payload');
    }

    if (existing.responseBody !== null) {
      return {
        status: 'replay',
        responseCode: existing.responseCode!,
        responseBody: typeof existing.responseBody === 'string'
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

    await this.prisma.idempotencyKey.update({
      where: { id: existing.id },
      data: {
        lockedAt: now,
      },
    });

    return { status: 'acquired' };
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
    if (!body) {
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
