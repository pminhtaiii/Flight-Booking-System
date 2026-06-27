import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { LockoutService } from './rate-limit/lockout.service';
import { JwtService } from '@nestjs/jwt';
import { CacheService } from '@/cache/cache.service';
import { ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: PrismaService;
  let audit: AuditService;
  let lockout: LockoutService;
  let jwt: JwtService;

  const mockPrismaService: any = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (cb: (tx: any) => Promise<any>): Promise<any> => {
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
    prisma = module.get<PrismaService>(PrismaService);
    audit = module.get<AuditService>(AuditService);
    lockout = module.get<LockoutService>(LockoutService);
    jwt = module.get<JwtService>(JwtService);

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
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'existing-123', email: 'test@example.com' });

      await expect(service.register(validDto)).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException if password does not meet complexity requirements', async () => {
      const weakPasswords = [
        'pwd123!',
        'password123!',
        'PASSWORD123!',
        'Password!',
        'Password123',
      ];

      for (const password of weakPasswords) {
        await expect(
          service.register({ email: 'test@example.com', password })
        ).rejects.toThrow(BadRequestException);
      }
    });
  });
});
