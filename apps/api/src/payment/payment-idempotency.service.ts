import { Injectable, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { IdempotencyKey } from '@prisma/client';
import * as crypto from 'crypto';

export type AcquireOrReplayResult =
  | { status: 'replay'; responseCode: number; responseBody: any }
  | { status: 'acquired'; idempotencyKey: IdempotencyKey };

@Injectable()
export class PaymentIdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService
  ) {}

  /**
   * Computes a SHA-256 hash of the request payload deterministically.
   */
  computeHash(payload: any): string {
    const serialized = payload ? JSON.stringify(payload) : '';
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Tries to acquire a lock for the given idempotency key or replays the cached response.
   * Throws ConflictException if currently locked and not stale.
   * Throws UnprocessableEntityException if the key is reused with a different request payload.
   */
  async acquireOrReplay(params: {
    key: string;
    requestHash: string;
    customerId: string;
    requestPath: string;
    requestParams?: any;
  }): Promise<AcquireOrReplayResult> {
    const { key, requestHash, customerId, requestPath, requestParams } = params;

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException('Idempotency key reuse with different payload');
      }

      if (existing.responseCode !== null && existing.responseCode !== undefined) {
        return {
          status: 'replay',
          responseCode: existing.responseCode,
          responseBody: existing.responseBody,
        };
      }

      if (existing.lockedAt !== null) {
        const lockTimeoutMinutes = this.configService.get<number>(
          'IDEMPOTENCY_LOCK_TIMEOUT_MINUTES',
          5
        );
        const isStale =
          Date.now() - existing.lockedAt.getTime() > lockTimeoutMinutes * 60 * 1000;

        if (!isStale) {
          throw new ConflictException('A request with this idempotency key is already in progress');
        }
      }

      // Re-acquire lock (either it wasn't locked, or the lock was stale)
      const updated = await this.prisma.idempotencyKey.update({
        where: { key },
        data: { lockedAt: new Date() },
      });

      return {
        status: 'acquired',
        idempotencyKey: updated,
      };
    }

    // Create a new key with lock acquired
    const ttlHours = this.configService.get<number>('IDEMPOTENCY_KEY_TTL_HOURS', 24);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    const created = await this.prisma.idempotencyKey.create({
      data: {
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams: requestParams ?? null,
        lockedAt: new Date(),
        expiresAt,
        recoveryPoint: 'started',
      },
    });

    return {
      status: 'acquired',
      idempotencyKey: created,
    };
  }

  /**
   * Advances the recovery point checkpoint for the pipeline.
   */
  async updateRecoveryPoint(key: string, recoveryPoint: string): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: { recoveryPoint },
    });
  }

  /**
   * Completes the idempotency key operation, caching the response code/body and releasing the lock.
   */
  async completeKey(key: string, responseCode: number, responseBody: any): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: {
        responseCode,
        responseBody: responseBody ?? null,
        recoveryPoint: 'completed',
        lockedAt: null,
      },
    });
  }

  /**
   * Explicitly releases the lock (allows retry on same key if process failed safely).
   */
  async releaseLock(key: string): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: { lockedAt: null },
    });
  }
}
