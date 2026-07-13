import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { PaymentIdempotencyService } from './payment-idempotency.service';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

describe('PaymentIdempotencyService', () => {
  let service: PaymentIdempotencyService;
  let prisma: PrismaService;

  const mockPrismaService = {
    idempotencyKey: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key === 'IDEMPOTENCY_LOCK_TIMEOUT_MINUTES') return 5;
      if (key === 'IDEMPOTENCY_KEY_TTL_HOURS') return 24;
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentIdempotencyService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService as unknown as ConfigService },
      ],
    }).compile();

    service = module.get<PaymentIdempotencyService>(PaymentIdempotencyService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('computeHash', () => {
    it('should compute consistent SHA-256 hash', () => {
      const payload = { amount: 100, currency: 'usd' };
      const hash1 = service.computeHash(payload);
      const hash2 = service.computeHash(payload);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('should be order-independent for object keys', () => {
      const payload1 = { a: 1, b: 2 };
      const payload2 = { b: 2, a: 1 };
      const hash1 = service.computeHash(payload1);
      const hash2 = service.computeHash(payload2);
      expect(hash1).toBe(hash2);
    });

    it('should differentiate between different falsy values', () => {
      const hashes = [
        service.computeHash(0),
        service.computeHash(false),
        service.computeHash(''),
        service.computeHash(null),
        service.computeHash(undefined),
      ];
      // Make sure all hashes are unique
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(hashes.length);
    });
  });

  describe('acquireOrReplay', () => {
    const customerId = 'user_123';
    const requestPath = '/api/payments/create';
    const key = 'idemp_key_123';
    const requestHash = 'hash_123';
    const requestParams = { amount: 1000 };

    it('should acquire lock for a new key', async () => {
      mockPrismaService.idempotencyKey.findUnique.mockResolvedValue(null);
      const mockCreatedKey = {
        id: 'db_id_123',
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams,
        lockedAt: new Date('2026-07-12T13:00:00Z'),
        expiresAt: new Date('2026-07-13T13:00:00Z'),
        recoveryPoint: 'started',
      };
      mockPrismaService.idempotencyKey.create.mockResolvedValue(mockCreatedKey);

      const result = await service.acquireOrReplay({
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams,
      });

      expect(prisma.idempotencyKey.findUnique).toHaveBeenCalledWith({ where: { key } });
      expect(prisma.idempotencyKey.create).toHaveBeenCalled();
      expect(result).toEqual({
        status: 'acquired',
        idempotencyKey: mockCreatedKey,
        leaseToken: mockCreatedKey.lockedAt.toISOString(),
      });
    });

    it('should replay cached response if key is already completed', async () => {
      const mockExistingKey = {
        id: 'db_id_123',
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams,
        responseCode: 201,
        responseBody: { success: true },
        lockedAt: null,
        expiresAt: new Date('2026-07-13T13:00:00Z'),
        recoveryPoint: 'completed',
      };
      mockPrismaService.idempotencyKey.findUnique.mockResolvedValue(mockExistingKey);

      const result = await service.acquireOrReplay({
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams,
      });

      expect(result).toEqual({
        status: 'replay',
        responseCode: 201,
        responseBody: { success: true },
      });
    });

    it('should throw ConflictException if key is currently locked (active)', async () => {
      const mockExistingKey = {
        id: 'db_id_123',
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams,
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 100000),
        recoveryPoint: 'started',
      };
      mockPrismaService.idempotencyKey.findUnique.mockResolvedValue(mockExistingKey);

      await expect(
        service.acquireOrReplay({
          key,
          requestHash,
          customerId,
          requestPath,
          requestParams,
        })
      ).rejects.toThrow(ConflictException);
    });

    it('should re-acquire lock if key is locked but lock is stale', async () => {
      const fiveMinutesAgo = new Date();
      fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 10);

      const mockExistingKey = {
        id: 'db_id_123',
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams,
        lockedAt: fiveMinutesAgo,
        expiresAt: new Date(Date.now() + 100000),
        recoveryPoint: 'started',
      };
      mockPrismaService.idempotencyKey.findUnique.mockResolvedValue(mockExistingKey);
      mockPrismaService.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.acquireOrReplay({
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams,
      });

      expect(prisma.idempotencyKey.updateMany).toHaveBeenCalled();
      expect(result.status).toBe('acquired');
      expect(result).toHaveProperty('leaseToken');
    });

    it('should throw UnprocessableEntityException if key is used with a different request hash', async () => {
      const mockExistingKey = {
        id: 'db_id_123',
        key,
        requestHash: 'different_hash',
        customerId,
        requestPath,
        requestParams,
        lockedAt: null,
        expiresAt: new Date(Date.now() + 100000),
        recoveryPoint: 'completed',
      };
      mockPrismaService.idempotencyKey.findUnique.mockResolvedValue(mockExistingKey);

      await expect(
        service.acquireOrReplay({
          key,
          requestHash,
          customerId,
          requestPath,
          requestParams,
        })
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should throw UnprocessableEntityException if customer ID mismatch', async () => {
      const mockExistingKey = {
        id: 'db_id_123',
        key,
        requestHash,
        customerId: 'different_customer',
        requestPath,
        requestParams,
        lockedAt: null,
        expiresAt: new Date(Date.now() + 100000),
        recoveryPoint: 'completed',
      };
      mockPrismaService.idempotencyKey.findUnique.mockResolvedValue(mockExistingKey);

      await expect(
        service.acquireOrReplay({
          key,
          requestHash,
          customerId,
          requestPath,
          requestParams,
        })
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should throw UnprocessableEntityException if request path mismatch', async () => {
      const mockExistingKey = {
        id: 'db_id_123',
        key,
        requestHash,
        customerId,
        requestPath: '/different/path',
        requestParams,
        lockedAt: null,
        expiresAt: new Date(Date.now() + 100000),
        recoveryPoint: 'completed',
      };
      mockPrismaService.idempotencyKey.findUnique.mockResolvedValue(mockExistingKey);

      await expect(
        service.acquireOrReplay({
          key,
          requestHash,
          customerId,
          requestPath,
          requestParams,
        })
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should re-acquire lock and reset key parameters if key is expired', async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 2);

      const mockExistingKey = {
        id: 'db_id_123',
        key,
        requestHash: 'old_hash',
        customerId: 'old_customer',
        requestPath: '/old/path',
        lockedAt: null,
        expiresAt: pastDate,
        recoveryPoint: 'completed',
      };
      mockPrismaService.idempotencyKey.findUnique.mockResolvedValue(mockExistingKey);
      mockPrismaService.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.acquireOrReplay({
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams,
      });

      expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            key,
            expiresAt: mockExistingKey.expiresAt,
          },
        })
      );
      expect(result.status).toBe('acquired');
      expect(result).toHaveProperty('leaseToken');
    });

    it('should throw ConflictException if database create throws P2002 unique-constraint error', async () => {
      mockPrismaService.idempotencyKey.findUnique.mockResolvedValue(null);
      const mockPrismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.14.0',
      });
      mockPrismaService.idempotencyKey.create.mockRejectedValue(mockPrismaError);

      await expect(
        service.acquireOrReplay({
          key,
          requestHash,
          customerId,
          requestPath,
          requestParams,
        })
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('updateRecoveryPoint', () => {
    it('should update the recovery point if lease matches', async () => {
      mockPrismaService.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });
      const leaseToken = new Date().toISOString();

      await service.updateRecoveryPoint('key_123', 'stripe_authorized', leaseToken);

      expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledWith({
        where: { key: 'key_123', lockedAt: new Date(leaseToken) },
        data: { recoveryPoint: 'stripe_authorized' },
      });
    });

    it('should throw ConflictException if lease is lost', async () => {
      mockPrismaService.idempotencyKey.updateMany.mockResolvedValue({ count: 0 });
      const leaseToken = new Date().toISOString();

      await expect(
        service.updateRecoveryPoint('key_123', 'stripe_authorized', leaseToken)
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('completeKey', () => {
    it('should set response and release lock if lease matches', async () => {
      mockPrismaService.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });
      const leaseToken = new Date().toISOString();

      await service.completeKey('key_123', 200, { data: 'ok' }, leaseToken);

      expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledWith({
        where: { key: 'key_123', lockedAt: new Date(leaseToken) },
        data: {
          responseCode: 200,
          responseBody: { data: 'ok' },
          recoveryPoint: 'completed',
          lockedAt: null,
        },
      });
    });

    it('should throw ConflictException if lease is lost', async () => {
      mockPrismaService.idempotencyKey.updateMany.mockResolvedValue({ count: 0 });
      const leaseToken = new Date().toISOString();

      await expect(
        service.completeKey('key_123', 200, { data: 'ok' }, leaseToken)
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('releaseLock', () => {
    it('should set lockedAt to null to release lock if lease matches', async () => {
      mockPrismaService.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });
      const leaseToken = new Date().toISOString();

      await service.releaseLock('key_123', leaseToken);

      expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledWith({
        where: { key: 'key_123', lockedAt: new Date(leaseToken) },
        data: { lockedAt: null },
      });
    });

    it('should throw ConflictException if lease is lost', async () => {
      mockPrismaService.idempotencyKey.updateMany.mockResolvedValue({ count: 0 });
      const leaseToken = new Date().toISOString();

      await expect(
        service.releaseLock('key_123', leaseToken)
      ).rejects.toThrow(ConflictException);
    });
  });
});
