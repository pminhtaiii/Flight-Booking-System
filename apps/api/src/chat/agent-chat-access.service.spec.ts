import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { AgentChatAccessService } from './agent-chat-access.service';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';

describe('AgentChatAccessService', () => {
  let service: AgentChatAccessService;
  let prismaService: jest.Mocked<PrismaService>;
  let cacheService: jest.Mocked<CacheService>;

  beforeEach(async () => {
    prismaService = {
      user: {
        findUnique: jest.fn(),
      },
    } as unknown as jest.Mocked<PrismaService>;

    cacheService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<CacheService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentChatAccessService,
        { provide: PrismaService, useValue: prismaService },
        { provide: CacheService, useValue: cacheService },
      ],
    }).compile();

    service = module.get<AgentChatAccessService>(AgentChatAccessService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkUserAccess', () => {
    it('returns allowed: true for active user with no jti/exp', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_1',
        status: 'ACTIVE',
      });

      const res = await service.checkUserAccess({ sub: 'usr_1' });
      expect(res).toEqual({ allowed: true });
      expect(prismaService.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'usr_1' },
      });
      expect(cacheService.get).not.toHaveBeenCalled();
    });

    it('throws 401 UNAUTHORIZED if user is missing', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.checkUserAccess({ sub: 'usr_missing' })).rejects.toThrow(HttpException);

      try {
        (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
        await service.checkUserAccess({ sub: 'usr_missing' });
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
        expect(httpErr.getResponse()).toEqual({
          code: 'UNAUTHORIZED',
          message: 'User is inactive or not found',
        });
      }
    });

    it('throws 401 UNAUTHORIZED if user is INACTIVE', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_inactive',
        status: 'INACTIVE',
      });

      await expect(service.checkUserAccess({ sub: 'usr_inactive' })).rejects.toThrow(HttpException);

      try {
        (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
          id: 'usr_inactive',
          status: 'INACTIVE',
        });
        await service.checkUserAccess({ sub: 'usr_inactive' });
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
        expect(httpErr.getResponse()).toEqual({
          code: 'UNAUTHORIZED',
          message: 'User is inactive or not found',
        });
      }
    });

    it('throws 401 UNAUTHORIZED for expired token (exp in the past)', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_1',
        status: 'ACTIVE',
      });

      const pastExp = Math.floor(Date.now() / 1000) - 60; // 60 seconds in the past

      await expect(service.checkUserAccess({ sub: 'usr_1', exp: pastExp })).rejects.toThrow(
        HttpException,
      );

      try {
        (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
          id: 'usr_1',
          status: 'ACTIVE',
        });
        await service.checkUserAccess({ sub: 'usr_1', exp: pastExp });
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
        expect(httpErr.getResponse()).toEqual({
          code: 'UNAUTHORIZED',
          message: 'Token has expired',
        });
      }
    });

    it('returns allowed: true for valid unexpired token (exp in the future)', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_1',
        status: 'ACTIVE',
      });

      const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour in the future

      const res = await service.checkUserAccess({ sub: 'usr_1', exp: futureExp });
      expect(res).toEqual({ allowed: true });
    });

    it('throws 401 UNAUTHORIZED if JTI is revoked in cache', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_1',
        status: 'ACTIVE',
      });
      (cacheService.get as jest.Mock).mockResolvedValueOnce('revoked');

      await expect(
        service.checkUserAccess({ sub: 'usr_1', jti: 'jti_revoked_123' }),
      ).rejects.toThrow(HttpException);

      expect(cacheService.get).toHaveBeenCalledWith('blacklist:jti:jti_revoked_123');

      try {
        (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
          id: 'usr_1',
          status: 'ACTIVE',
        });
        (cacheService.get as jest.Mock).mockResolvedValueOnce('revoked');
        await service.checkUserAccess({ sub: 'usr_1', jti: 'jti_revoked_123' });
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
        expect(httpErr.getResponse()).toEqual({
          code: 'UNAUTHORIZED',
          message: 'Token JTI has been revoked',
        });
      }
    });

    it('returns allowed: true for valid unrevoked JTI in cache (null or false)', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_1',
        status: 'ACTIVE',
      });
      (cacheService.get as jest.Mock).mockResolvedValueOnce(null);

      const resNull = await service.checkUserAccess({
        sub: 'usr_1',
        jti: 'jti_valid_456',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(resNull).toEqual({ allowed: true });
      expect(cacheService.get).toHaveBeenCalledWith('blacklist:jti:jti_valid_456');

      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_1',
        status: 'ACTIVE',
      });
      (cacheService.get as jest.Mock).mockResolvedValueOnce(false);

      const resFalse = await service.checkUserAccess({
        sub: 'usr_1',
        jti: 'jti_valid_789',
      });
      expect(resFalse).toEqual({ allowed: true });
      expect(cacheService.get).toHaveBeenCalledWith('blacklist:jti:jti_valid_789');
    });
  });
});
