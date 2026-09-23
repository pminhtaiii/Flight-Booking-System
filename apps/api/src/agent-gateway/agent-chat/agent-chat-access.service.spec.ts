import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { AgentChatAccessService } from '@/chat/agent-chat-access.service';
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
      hget: jest.fn(),
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
    it('returns allowed: true for active user status check', async () => {
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

    it('throws 401 UNAUTHORIZED for expired token (exp * 1000 <= Date.now())', async () => {
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

    it('returns allowed: true for valid unexpired token', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_1',
        status: 'ACTIVE',
      });

      const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour in the future

      const res = await service.checkUserAccess({ sub: 'usr_1', exp: futureExp });
      expect(res).toEqual({ allowed: true });
    });

    it('throws 401 UNAUTHORIZED if JTI is revoked in Redis (blacklist:jti:${jti})', async () => {
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

    it('returns allowed: true for valid unrevoked JTI', async () => {
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

    describe('fail-closed behavior', () => {
      it('fails closed immediately when user is missing without checking token expiration or cache', async () => {
        (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce(null);

        await expect(
          service.checkUserAccess({
            sub: 'missing_user',
            jti: 'jti_any',
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        ).rejects.toThrow(HttpException);

        expect(cacheService.get).not.toHaveBeenCalled();
      });

      it('fails closed immediately when user status is not ACTIVE (e.g. SUSPENDED or DELETED)', async () => {
        (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
          id: 'usr_suspended',
          status: 'SUSPENDED',
        });

        await expect(
          service.checkUserAccess({
            sub: 'usr_suspended',
            jti: 'jti_any',
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        ).rejects.toThrow(HttpException);

        expect(cacheService.get).not.toHaveBeenCalled();
      });

      it('fails closed when token is expired without checking JTI blacklist', async () => {
        (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
          id: 'usr_1',
          status: 'ACTIVE',
        });

        const expiredTimestamp = Math.floor(Date.now() / 1000) - 10;
        await expect(
          service.checkUserAccess({
            sub: 'usr_1',
            jti: 'jti_any',
            exp: expiredTimestamp,
          }),
        ).rejects.toThrow(HttpException);

        expect(cacheService.get).not.toHaveBeenCalled();
      });

      it('fails closed when JTI is revoked even if user is active and token is unexpired', async () => {
        (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
          id: 'usr_1',
          status: 'ACTIVE',
        });
        (cacheService.get as jest.Mock).mockResolvedValueOnce('1');

        await expect(
          service.checkUserAccess({
            sub: 'usr_1',
            jti: 'jti_revoked',
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        ).rejects.toThrow(HttpException);

        expect(cacheService.get).toHaveBeenCalledWith('blacklist:jti:jti_revoked');
      });
    });
  });

  describe('fencing token validation semantics against session state', () => {
    it('operates at user/token scope and does not query or mutate session lock/fencing cache keys', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_1',
        status: 'ACTIVE',
      });
      (cacheService.get as jest.Mock).mockResolvedValueOnce(null);

      const res = await service.checkUserAccess({
        sub: 'usr_1',
        jti: 'jti_valid_123',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      expect(res).toEqual({ allowed: true });
      expect(cacheService.hget).not.toHaveBeenCalled();
      expect(cacheService.get).toHaveBeenCalledWith('blacklist:jti:jti_valid_123');
    });

    it('preserves fail-closed user authentication regardless of session-level fencing state', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'usr_inactive',
        status: 'INACTIVE',
      });

      await expect(
        service.checkUserAccess({
          sub: 'usr_inactive',
        }),
      ).rejects.toThrow(HttpException);

      expect(cacheService.hget).not.toHaveBeenCalled();
    });
  });
});
