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
    get: jest.fn((key: string, defaultValue?: any) => {
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
        { provide: ConfigService, useValue: mockConfigService },
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
      expect(hash1).toHaveLength(64); // SHA-256 hex is 64 chars
    });

    it('should handle empty/null payloads', () => {
      const hash = service.computeHash(null);
      expect(hash).toHaveLength(64);
    });
  });

  describe('acquireOrReplay', () => {
    const customerId = 'user_123';
    const requestPath = '/api/payments/create';
    const key = 'idemp_key_123';
    const requestHash = 'hash_123';
    const requestParams = { amount: 1000 };

    it('should acquire lock for a new key directly via create', async () => {
      const mockCreatedKey = {
        id: 'db_id_123',
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams,
        lockedAt: new Date(),
        expiresAt: new Date(),
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

      expect(prisma.idempotencyKey.create).toHaveBeenCalled();
      expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'acquired', idempotencyKey: mockCreatedKey });
    });

    it('should replay cached response if key is already completed', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Duplicate key', {
        code: 'P2002',
        clientVersion: '5.14.0',
      });
      mockPrismaService.idempotencyKey.create.mockRejectedValue(p2002Error);

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
        expiresAt: new Date(),
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

      expect(prisma.idempotencyKey.create).toHaveBeenCalled();
      expect(prisma.idempotencyKey.findUnique).toHaveBeenCalledWith({ where: { key } });
      expect(result).toEqual({
        status: 'replay',
        responseCode: 201,
        responseBody: { success: true },
      });
    });

    it('should throw ConflictException if key is currently locked (active)', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Duplicate key', {
        code: 'P2002',
        clientVersion: '5.14.0',
      });
      mockPrismaService.idempotencyKey.create.mockRejectedValue(p2002Error);

      const mockExistingKey = {
        id: 'db_id_123',
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams,
        lockedAt: new Date(), // Locked right now
        expiresAt: new Date(),
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
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Duplicate key', {
        code: 'P2002',
        clientVersion: '5.14.0',
      });
      mockPrismaService.idempotencyKey.create.mockRejectedValue(p2002Error);

      const fiveMinutesAgo = new Date();
      fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 10); // 10 minutes ago, stale!

      const mockExistingKey = {
        id: 'db_id_123',
        key,
        requestHash,
        customerId,
        requestPath,
        requestParams,
        lockedAt: fiveMinutesAgo,
        expiresAt: new Date(),
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

      expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledWith({
        where: {
          key,
          lockedAt: fiveMinutesAgo,
        },
        data: {
          lockedAt: expect.any(Date),
        },
      });
      expect(result.status).toBe('acquired');
      if (result.status === 'acquired') {
        expect(result.idempotencyKey).toBeDefined();
      }
    });

    it('should throw ConflictException if updateMany count is 0 (concurrency collision)', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Duplicate key', {
        code: 'P2002',
        clientVersion: '5.14.0',
      });
      mockPrismaService.idempotencyKey.create.mockRejectedValue(p2002Error);

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
        expiresAt: new Date(),
        recoveryPoint: 'started',
      };
      mockPrismaService.idempotencyKey.findUnique.mockResolvedValue(mockExistingKey);
      mockPrismaService.idempotencyKey.updateMany.mockResolvedValue({ count: 0 }); // Collision!

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

    it('should throw UnprocessableEntityException if key is used with a different request hash', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Duplicate key', {
        code: 'P2002',
        clientVersion: '5.14.0',
      });
      mockPrismaService.idempotencyKey.create.mockRejectedValue(p2002Error);

      const mockExistingKey = {
        id: 'db_id_123',
        key,
        requestHash: 'different_hash',
        customerId,
        requestPath,
        requestParams,
        lockedAt: null,
        expiresAt: new Date(),
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
  });

  describe('updateRecoveryPoint', () => {
    it('should update the recovery point', async () => {
      mockPrismaService.idempotencyKey.update.mockResolvedValue({ id: '123' });
      await service.updateRecoveryPoint('key_123', 'stripe_authorized');
      expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: 'key_123' },
        data: { recoveryPoint: 'stripe_authorized' },
      });
    });
  });

  describe('completeKey', () => {
    it('should set response and release lock', async () => {
      mockPrismaService.idempotencyKey.update.mockResolvedValue({ id: '123' });
      await service.completeKey('key_123', 200, { data: 'ok' });
      expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: 'key_123' },
        data: {
          responseCode: 200,
          responseBody: { data: 'ok' },
          recoveryPoint: 'completed',
          lockedAt: null,
        },
      });
    });
  });

  describe('releaseLock', () => {
    it('should set lockedAt to null to release lock', async () => {
      mockPrismaService.idempotencyKey.update.mockResolvedValue({ id: '123' });
      await service.releaseLock('key_123');
      expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: 'key_123' },
        data: { lockedAt: null },
      });
    });
  });
});
