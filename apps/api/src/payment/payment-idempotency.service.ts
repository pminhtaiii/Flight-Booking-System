import { Injectable, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { IdempotencyKey, Prisma } from '@prisma/client';
import * as crypto from 'crypto';

export type AcquireOrReplayResult =
  | { status: 'replay'; responseCode: number; responseBody: unknown }
  | { status: 'acquired'; idempotencyKey: IdempotencyKey; leaseToken: string };

@Injectable()
export class PaymentIdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService
  ) {}

  /**
   * Computes a SHA-256 hash of the request payload deterministically.
   * Employs a stable order-independent key sorting serialization to ensure identical payloads
   * with different key orderings produce matching hashes, while distinct falsy values are properly separated.
   */
  computeHash(payload: unknown): string {
    const serializeStably = (val: unknown): string => {
      if (val === null) return 'null';
      if (val === undefined) return 'undefined';
      if (typeof val === 'object') {
        if (Array.isArray(val)) {
          return '[' + val.map(serializeStably).join(',') + ']';
        }
        if (val instanceof Date) {
          return `Date(${val.toISOString()})`;
        }
        const obj = val as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        const parts = keys.map((k) => `${k}:${serializeStably(obj[k])}`);
        return '{' + parts.join(',') + '}';
      }
      return `${typeof val}:${val}`;
    };

    const serialized = serializeStably(payload);
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Tries to acquire a lock for the given idempotency key or replays the cached response.
   * Throws ConflictException if currently locked and not stale.
   * Throws UnprocessableEntityException if key is reused by different customer, path, or payload.
   */
  async acquireOrReplay(params: {
    key: string;
    requestHash: string;
    customerId: string;
    requestPath: string;
    requestParams?: unknown;
  }): Promise<AcquireOrReplayResult> {
    const { key, requestHash, customerId, requestPath, requestParams } = params;

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });

    if (existing) {
      // Handle atomically key expiration (reusable if expiresAt is in the past)
      // Expired keys are completely reset without validating mismatch properties.
      const isExpired = existing.expiresAt.getTime() < Date.now();
      if (isExpired) {
        const ttlHours = this.configService.get<number>('IDEMPOTENCY_KEY_TTL_HOURS', 24);
        const newExpiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
        const newLockedAt = new Date();

        const result = await this.prisma.idempotencyKey.updateMany({
          where: {
            key,
            expiresAt: existing.expiresAt,
          },
          data: {
            requestHash,
            customerId,
            requestPath,
            requestParams: (requestParams as Prisma.InputJsonValue) ?? Prisma.DbNull,
            lockedAt: newLockedAt,
            expiresAt: newExpiresAt,
            recoveryPoint: 'started',
            responseCode: null,
            responseBody: Prisma.DbNull,
          },
        });

        if (result.count === 0) {
          throw new ConflictException('Concurrency conflict resetting expired idempotency key');
        }

        return {
          status: 'acquired',
          idempotencyKey: {
            ...existing,
            requestHash,
            customerId,
            requestPath,
            requestParams: (requestParams as Prisma.JsonValue) ?? null,
            lockedAt: newLockedAt,
            expiresAt: newExpiresAt,
            recoveryPoint: 'started',
            responseCode: null,
            responseBody: null,
          },
          leaseToken: newLockedAt.toISOString(),
        };
      }

      // Validate request identity matches completely for active/non-expired keys
      if (existing.customerId !== customerId) {
        throw new UnprocessableEntityException('Idempotency key customer mismatch');
      }
      if (existing.requestPath !== requestPath) {
        throw new UnprocessableEntityException('Idempotency key request path mismatch');
      }

      // Validate request hash matching
      if (existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException('Idempotency key reuse with different payload');
      }

      // Replay completed keys
      if (existing.responseCode !== null && existing.responseCode !== undefined) {
        return {
          status: 'replay',
          responseCode: existing.responseCode,
          responseBody: existing.responseBody,
        };
      }

      // Check if key is currently locked
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

      // Atomic stale lock takeover
      const newLockDate = new Date();
      const updateResult = await this.prisma.idempotencyKey.updateMany({
        where: {
          key,
          lockedAt: existing.lockedAt,
        },
        data: {
          lockedAt: newLockDate,
        },
      });

      if (updateResult.count === 0) {
        throw new ConflictException('A request with this idempotency key is already in progress');
      }

      return {
        status: 'acquired',
        idempotencyKey: {
          ...existing,
          lockedAt: newLockDate,
        },
        leaseToken: newLockDate.toISOString(),
      };
    }

    // Create a new key with lock acquired
    const ttlHours = this.configService.get<number>('IDEMPOTENCY_KEY_TTL_HOURS', 24);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    const lockedAt = new Date();

    try {
      const created = await this.prisma.idempotencyKey.create({
        data: {
          key,
          requestHash,
          customerId,
          requestPath,
          requestParams: (requestParams as Prisma.InputJsonValue) ?? Prisma.DbNull,
          lockedAt,
          expiresAt,
          recoveryPoint: 'started',
        },
      });

      return {
        status: 'acquired',
        idempotencyKey: created,
        leaseToken: created.lockedAt ? created.lockedAt.toISOString() : lockedAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A request with this idempotency key is already in progress');
      }
      throw error;
    }
  }

  /**
   * Advances the recovery point checkpoint for the pipeline if the lease matches.
   */
  async updateRecoveryPoint(key: string, recoveryPoint: string, leaseToken: string): Promise<void> {
    const result = await this.prisma.idempotencyKey.updateMany({
      where: {
        key,
        lockedAt: new Date(leaseToken),
      },
      data: { recoveryPoint },
    });

    if (result.count === 0) {
      throw new ConflictException('Lease expired or lost for this idempotency key');
    }
  }

  /**
   * Completes the idempotency key operation, caching the response code/body and releasing the lock if the lease matches.
   */
  async completeKey(
    key: string,
    responseCode: number,
    responseBody: unknown,
    leaseToken: string
  ): Promise<void> {
    const result = await this.prisma.idempotencyKey.updateMany({
      where: {
        key,
        lockedAt: new Date(leaseToken),
      },
      data: {
        responseCode,
        responseBody: (responseBody as Prisma.InputJsonValue) ?? Prisma.DbNull,
        recoveryPoint: 'completed',
        lockedAt: null,
      },
    });

    if (result.count === 0) {
      throw new ConflictException('Lease expired or lost for this idempotency key');
    }
  }

  /**
   * Explicitly releases the lock if the lease matches.
   */
  async releaseLock(key: string, leaseToken: string): Promise<void> {
    const result = await this.prisma.idempotencyKey.updateMany({
      where: {
        key,
        lockedAt: new Date(leaseToken),
      },
      data: { lockedAt: null },
    });

    if (result.count === 0) {
      throw new ConflictException('Lease expired or lost for this idempotency key');
    }
  }
}
