import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { LockoutService } from './rate-limit/lockout.service';
import { JwtService } from '@nestjs/jwt';
import { CacheService } from '@/cache/cache.service';
import { ConflictException, BadRequestException, UnauthorizedException } from '@nestjs/common';

describe('AuthService', () => {
  let service: AuthService;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      return cb(mockPrismaService);
    }),
  };

  const mockAuditService = {
    createLog: jest.fn().mockResolvedValue({ id: 'log-123' }),
  };

  const mockLockoutService = {
    isLockedOut: jest.fn(),
    recordFailedAttempt: jest.fn(),
    resetLockoutState: jest.fn(),
  };

  const mockJwtService = {
    sign: jest.fn(() => 'mock_token'),
  };

  const mockCacheService = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: LockoutService, useValue: mockLockoutService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: CacheService, useValue: mockCacheService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);

    jest.clearAllMocks();
  });

  describe('register', () => {
    const validDto = { email: 'Test@Example.com', password: 'Password123!' };

    it('should successfully register a user, hash password, normalize email, write audit log, and return token', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        status: 'ACTIVE',
      });

      const res = await service.register(validDto, '1.2.3.4', 'trace-id', 'correlation-id');

      expect(res).toHaveProperty('token', 'mock_token');
      expect(res.user).toEqual({ id: 'user-123', email: 'test@example.com' });
      expect(mockPrismaService.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
      });
      expect(mockPrismaService.user.create).toHaveBeenCalled();
      expect(mockAuditService.createLog).toHaveBeenCalled();
    });

    it('should throw ConflictException if email is already taken', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'existing-123',
        email: 'test@example.com',
      });

      await expect(service.register(validDto)).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException if password does not meet complexity requirements', async () => {
      const weakPasswords = ['pwd123!', 'password123!', 'PASSWORD123!', 'Password!', 'Password123'];

      for (const password of weakPasswords) {
        await expect(service.register({ email: 'test@example.com', password })).rejects.toThrow(
          BadRequestException,
        );
      }
    });

    it('should issue canonical JWTs including sub, iss, aud, jti, exp, and legacy id properties', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'user-456',
        email: 'jwt@example.com',
        status: 'ACTIVE',
      });

      await service.register({ email: 'jwt@example.com', password: 'Password123!' }, '1.2.3.4');
      
      expect(mockJwtService.sign).toHaveBeenCalled();
      
      const calls = mockJwtService.sign.mock.calls;
      const lastCall = calls[calls.length - 1] as any[];
      const payload = lastCall[0];
      const options = lastCall[1] || {};

      expect(payload).toHaveProperty('id', 'user-456');
      expect(payload).toHaveProperty('sub', 'user-456');
      expect(payload).toHaveProperty('jti');
      expect(options).toHaveProperty('issuer', 'booking-systems-api');
      expect(options).toHaveProperty('audience', 'booking-systems-clients');
      expect(options).toHaveProperty('expiresIn', '24h');
    });
  });

  describe('login', () => {
    it('should issue canonical JWTs including sub, iss, aud, jti, exp, and legacy id properties on login', async () => {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash('Password123!', 10);
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-login-123',
        email: 'login@example.com',
        password: hash,
        status: 'ACTIVE',
      });
      mockPrismaService.user.update.mockResolvedValue({
        id: 'user-login-123',
        email: 'login@example.com',
        lastLogin: new Date(),
      });

      await service.login({ email: 'login@example.com', password: 'Password123!' }, '1.2.3.4');

      expect(mockJwtService.sign).toHaveBeenCalled();
      const calls = mockJwtService.sign.mock.calls;
      const lastCall = calls[calls.length - 1] as any[];
      const payload = lastCall[0];
      const options = lastCall[1] || {};

      expect(payload).toHaveProperty('id', 'user-login-123');
      expect(payload).toHaveProperty('sub', 'user-login-123');
      expect(payload).toHaveProperty('jti');
      expect(options).toHaveProperty('issuer', 'booking-systems-api');
      expect(options).toHaveProperty('audience', 'booking-systems-clients');
      expect(options).toHaveProperty('expiresIn', '24h');
    });
  });

  describe('logout & revocation', () => {
    it('should blacklist both token and jti in cache upon logout', async () => {
      await service.logout('user-123', 'mock_token', '1.2.3.4', null, null, 'jti-123');

      expect(mockCacheService.set).toHaveBeenCalledWith('blacklist:mock_token', 'true', 86400);
      expect(mockCacheService.set).toHaveBeenCalledWith('blacklist:jti:jti-123', 'true', 86400);
    });
  });

  describe('validateUserAccess', () => {
    it('should return allowed true for active user with valid non-blacklisted token/jti', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-123',
        status: 'ACTIVE',
      });
      mockCacheService.get.mockResolvedValue(null);

      const res = await service.validateUserAccess('user-123', 'jti-123', 'mock_token');
      expect(res).toEqual({ allowed: true, userId: 'user-123' });
    });

    it('should throw UnauthorizedException if user status is INACTIVE (user deactivation)', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-123',
        status: 'INACTIVE',
      });

      await expect(service.validateUserAccess('user-123', 'jti-123', 'mock_token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException if user does not exist', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(service.validateUserAccess('user-999', 'jti-123')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException if jti or token is blacklisted in cache (logout revocation)', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-123',
        status: 'ACTIVE',
      });
      mockCacheService.get.mockImplementation(async (key: string) => {
        if (key === 'blacklist:jti:jti-revoked') return 'true';
        return null;
      });

      await expect(service.validateUserAccess('user-123', 'jti-revoked', 'mock_token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});

