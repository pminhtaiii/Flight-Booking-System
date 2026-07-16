import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { PaymentIdempotencyService } from './payment-idempotency.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PaymentIdempotencyService', () => {
  type MockIdempotencyKey = {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };

  let service: PaymentIdempotencyService;
  let mockPrisma: {
    idempotencyKey: MockIdempotencyKey;
  };

  beforeEach(() => {
    mockPrisma = {
      idempotencyKey: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    service = new PaymentIdempotencyService(mockPrisma as unknown as PrismaService);
  });

  describe('computeHash', () => {
    it('computes hash for empty inputs', () => {
      const hash1 = service.computeHash(null);
      const hash2 = service.computeHash(undefined);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex length
    });

    it('computes deterministic hashes regardless of key order', () => {
      const body1 = { a: 1, b: 2, c: { d: 3, e: 4 } };
      const body2 = { b: 2, c: { e: 4, d: 3 }, a: 1 };

      const hash1 = service.computeHash(body1);
      const hash2 = service.computeHash(body2);

      expect(hash1).toBe(hash2);
    });

    it('computes different hashes for different payloads', () => {
      const body1 = { a: 1, b: 2 };
      const body2 = { a: 1, b: 3 };

      const hash1 = service.computeHash(body1);
      const hash2 = service.computeHash(body2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('acquireOrReplay', () => {
    const key = 'test-idempotency-key';
    const hash = 'test-hash';
    const userId = 'user-123';
    const path = '/api/payments/create';

    it('acquires the key if it does not exist', async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce(null);
      mockPrisma.idempotencyKey.create.mockResolvedValueOnce({ id: 'new-id' });

      const result = await service.acquireOrReplay(key, hash, userId, path);

      expect(result).toEqual({ status: 'acquired' });
      expect(mockPrisma.idempotencyKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            key,
            requestHash: hash,
            customerId: userId,
            requestPath: path,
            lockedAt: expect.any(Date),
            recoveryPoint: 'started',
            expiresAt: expect.any(Date),
          }),
        }),
      );
    });

    it('throws UnprocessableEntityException if key is reused with different payload', async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({
        id: 'existing-id',
        key,
        requestHash: 'different-hash',
      });

      await expect(service.acquireOrReplay(key, hash, userId, path)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('returns replay if responseBody is already stored', async () => {
      const responseBody = { success: true };
      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({
        id: 'existing-id',
        key,
        requestHash: hash,
        responseCode: 201,
        responseBody,
      });

      const result = await service.acquireOrReplay(key, hash, userId, path);

      expect(result).toEqual({
        status: 'replay',
        responseCode: 201,
        responseBody: JSON.stringify(responseBody),
      });
    });

    it('throws ConflictException if request is in progress (locked < 5 minutes)', async () => {
      const fourMinutesAgo = new Date();
      fourMinutesAgo.setMinutes(fourMinutesAgo.getMinutes() - 4);

      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({
        id: 'existing-id',
        key,
        requestHash: hash,
        responseBody: null,
        lockedAt: fourMinutesAgo,
      });

      await expect(service.acquireOrReplay(key, hash, userId, path)).rejects.toThrow(
        ConflictException,
      );
    });

    it('acquires lock and updates lockedAt if existing lock is stale (> 5 minutes)', async () => {
      const sixMinutesAgo = new Date();
      sixMinutesAgo.setMinutes(sixMinutesAgo.getMinutes() - 6);

      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({
        id: 'existing-id',
        key,
        requestHash: hash,
        responseBody: null,
        lockedAt: sixMinutesAgo,
      });
      mockPrisma.idempotencyKey.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.acquireOrReplay(key, hash, userId, path);

      expect(result).toEqual({ status: 'acquired' });
      expect(mockPrisma.idempotencyKey.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'existing-id',
          lockedAt: sixMinutesAgo,
        },
        data: { lockedAt: expect.any(Date) },
      });
    });

    it('acquires lock if existing lockedAt is null', async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({
        id: 'existing-id',
        key,
        requestHash: hash,
        responseBody: null,
        lockedAt: null,
      });
      mockPrisma.idempotencyKey.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.acquireOrReplay(key, hash, userId, path);

      expect(result).toEqual({ status: 'acquired' });
      expect(mockPrisma.idempotencyKey.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'existing-id',
          lockedAt: null,
        },
        data: { lockedAt: expect.any(Date) },
      });
    });

    it('throws ConflictException if updateMany returns 0 (lost acquisition race)', async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({
        id: 'existing-id',
        key,
        requestHash: hash,
        responseBody: null,
        lockedAt: null,
      });
      mockPrisma.idempotencyKey.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.acquireOrReplay(key, hash, userId, path)).rejects.toThrow(
        ConflictException,
      );
    });

    it('handles P2002 race conditions during concurrent key creation', async () => {
      mockPrisma.idempotencyKey.findUnique
        .mockResolvedValueOnce(null) // first check sees nothing
        .mockResolvedValueOnce({
          id: 'existing-id',
          key,
          requestHash: hash,
          responseBody: { success: true },
          responseCode: 200,
          lockedAt: null,
        }); // fallback fetch finds the key created by rival thread

      const prismaError = new Error('Unique constraint violation') as Error & { code?: string };
      prismaError.code = 'P2002';
      mockPrisma.idempotencyKey.create.mockRejectedValueOnce(prismaError);

      const result = await service.acquireOrReplay(key, hash, userId, path);

      expect(result).toEqual({
        status: 'replay',
        responseCode: 200,
        responseBody: JSON.stringify({ success: true }),
      });
    });
  });

  describe('updateRecoveryPoint', () => {
    it('updates recoveryPoint field', async () => {
      mockPrisma.idempotencyKey.update.mockResolvedValueOnce({});
      await service.updateRecoveryPoint('key-1', 'stripe_authorized');
      expect(mockPrisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: 'key-1' },
        data: { recoveryPoint: 'stripe_authorized' },
      });
    });
  });

  describe('completeKey', () => {
    it('saves response details and clears lockedAt', async () => {
      mockPrisma.idempotencyKey.update.mockResolvedValueOnce({});
      await service.completeKey('key-1', 200, { success: true });
      expect(mockPrisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: 'key-1' },
        data: {
          responseCode: 200,
          responseBody: { success: true },
          lockedAt: null,
        },
      });
    });
  });

  describe('getResumePoint', () => {
    it('returns recoveryPoint if key exists', async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({
        key: 'key-1',
        recoveryPoint: 'duffel_order_created',
      });
      const result = await service.getResumePoint('key-1');
      expect(result).toBe('duffel_order_created');
    });

    it('returns null if key does not exist', async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce(null);
      const result = await service.getResumePoint('key-1');
      expect(result).toBeNull();
    });
  });

  describe('isLocked', () => {
    it('returns false if key does not exist or lockedAt is null', async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce(null);
      expect(await service.isLocked('key-1')).toBe(false);

      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({ lockedAt: null });
      expect(await service.isLocked('key-1')).toBe(false);
    });

    it('returns true if locked within 5 minutes', async () => {
      const threeMinutesAgo = new Date();
      threeMinutesAgo.setMinutes(threeMinutesAgo.getMinutes() - 3);

      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({ lockedAt: threeMinutesAgo });
      expect(await service.isLocked('key-1')).toBe(true);
    });

    it('returns false if locked more than 5 minutes ago', async () => {
      const sixMinutesAgo = new Date();
      sixMinutesAgo.setMinutes(sixMinutesAgo.getMinutes() - 6);

      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({ lockedAt: sixMinutesAgo });
      expect(await service.isLocked('key-1')).toBe(false);
    });
  });
});
