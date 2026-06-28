import { Test, TestingModule } from '@nestjs/testing';
import { LockoutService } from './lockout.service';
import { CacheService } from '@/cache/cache.service';

describe('LockoutService', () => {
  let service: LockoutService;

  const mockCacheService = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    incr: jest.fn(),
    getTtl: jest.fn(),
    keys: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LockoutService, { provide: CacheService, useValue: mockCacheService }],
    }).compile();

    service = module.get<LockoutService>(LockoutService);

    jest.clearAllMocks();
  });

  describe('isLockedOut', () => {
    it('should return locked: true with retryAfterSeconds when TTL > 0', async () => {
      mockCacheService.getTtl.mockResolvedValue(45);
      const res = await service.isLockedOut('1.2.3.4');
      expect(res).toEqual({ locked: true, retryAfterSeconds: 45 });
    });

    it('should return locked: false when TTL <= 0', async () => {
      mockCacheService.getTtl.mockResolvedValue(-2);
      const res = await service.isLockedOut('1.2.3.4');
      expect(res).toEqual({ locked: false, retryAfterSeconds: 0 });
    });
  });

  describe('recordFailedAttempt', () => {
    it('should increment attempts and not lock if attempts < 5', async () => {
      mockCacheService.incr.mockResolvedValue(4);
      const res = await service.recordFailedAttempt('1.2.3.4');
      expect(res).toEqual({ locked: false, retryAfterSeconds: 0, attempts: 4 });
    });

    it('should lock IP for 60s at escalation level 1', async () => {
      mockCacheService.incr.mockResolvedValue(5);
      mockCacheService.get.mockResolvedValue(null);

      const res = await service.recordFailedAttempt('1.2.3.4');
      expect(res).toEqual({ locked: true, retryAfterSeconds: 60, attempts: 5 });
      expect(mockCacheService.set).toHaveBeenCalledWith(
        expect.stringContaining('lockout-level'),
        '1',
        expect.any(Number),
      );
      expect(mockCacheService.set).toHaveBeenCalledWith(
        expect.stringContaining('lockout'),
        'true',
        60,
      );
    });

    it('should escalate lock duration to 120s at level 2', async () => {
      mockCacheService.incr.mockResolvedValue(6);
      mockCacheService.get.mockResolvedValue('1');

      const res = await service.recordFailedAttempt('1.2.3.4');
      expect(res).toEqual({ locked: true, retryAfterSeconds: 120, attempts: 6 });
      expect(mockCacheService.set).toHaveBeenCalledWith(
        expect.stringContaining('lockout-level'),
        '2',
        expect.any(Number),
      );
      expect(mockCacheService.set).toHaveBeenCalledWith(
        expect.stringContaining('lockout'),
        'true',
        120,
      );
    });
  });
});
