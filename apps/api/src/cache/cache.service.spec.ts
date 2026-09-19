import { Test, TestingModule } from '@nestjs/testing';
import { CacheService } from './cache.service';

describe('CacheService', () => {
  let service: CacheService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CacheService],
    }).compile();

    service = module.get<CacheService>(CacheService);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('checkHealth', () => {
    it('should return down when redis client is not initialized', async () => {
      const status = await service.checkHealth();
      expect(status).toBe('down');
    });

    it('should return up when redis client returns PONG', async () => {
      (service as unknown as { redisClient: unknown }).redisClient = {
        ping: jest.fn().mockResolvedValue('PONG'),
        quit: jest.fn().mockResolvedValue('OK'),
      };

      const status = await service.checkHealth();
      expect(status).toBe('up');
    });

    it('should return down when redis ping fails', async () => {
      (service as unknown as { redisClient: unknown }).redisClient = {
        ping: jest.fn().mockRejectedValue(new Error('Connection lost')),
        quit: jest.fn().mockResolvedValue('OK'),
      };

      const status = await service.checkHealth();
      expect(status).toBe('down');
    });

    it('should return down when redis ping times out', async () => {
      (service as unknown as { redisClient: unknown }).redisClient = {
        ping: jest
          .fn()
          .mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve('PONG'), 1500)),
          ),
        quit: jest.fn().mockResolvedValue('OK'),
      };

      const status = await service.checkHealth();
      expect(status).toBe('down');
    });
  });

  describe('in-memory fallback store', () => {
    it('should get and set in-memory when redis is unavailable', async () => {
      await service.set('test_key', 'test_val', 10);
      const val = await service.get('test_key');
      expect(val).toBe('test_val');
    });

    it('should delete keys from in-memory fallback', async () => {
      await service.set('del_key', 'del_val');
      await service.del('del_key');
      const val = await service.get('del_key');
      expect(val).toBeNull();
    });

    it('should increment by amount using in-memory store', async () => {
      const v1 = await service.incrby('counter_key', 3, 60);
      expect(v1).toBe(3);
      const v2 = await service.incrby('counter_key', 5);
      expect(v2).toBe(8);
      const v3 = await service.incr('counter_key');
      expect(v3).toBe(9);
    });

    it('should push, trim, and range lists using in-memory store', async () => {
      const len1 = await service.lpush('list_key', '10', '20', '30');
      expect(len1).toBe(3);

      const items1 = await service.lrange('list_key', 0, -1);
      expect(items1).toEqual(['30', '20', '10']);

      await service.lpush('list_key', '40');
      const items2 = await service.lrange('list_key', 0, 1);
      expect(items2).toEqual(['40', '30']);

      await service.ltrim('list_key', 0, 1);
      const items3 = await service.lrange('list_key', 0, -1);
      expect(items3).toEqual(['40', '30']);
    });

    it('should return empty list for non-existent key or out-of-bound range', async () => {
      const empty = await service.lrange('non_existent', 0, 5);
      expect(empty).toEqual([]);

      await service.lpush('small_list', '1');
      const outOfBounds = await service.lrange('small_list', 5, 10);
      expect(outOfBounds).toEqual([]);
    });
  });

  describe('Redis list and incr operations', () => {
    it('should delegate incrby to redisClient if available', async () => {
      const mockIncrby = jest.fn().mockResolvedValue(10);
      const mockExpire = jest.fn().mockResolvedValue(1);
      (service as unknown as { redisClient: unknown }).redisClient = {
        incrby: mockIncrby,
        expire: mockExpire,
        quit: jest.fn().mockResolvedValue('OK'),
      };

      const result = await service.incrby('metric_key', 10, 60);
      expect(result).toBe(10);
      expect(mockIncrby).toHaveBeenCalledWith('metric_key', 10);
      expect(mockExpire).toHaveBeenCalledWith('metric_key', 60);
    });

    it('should delegate lpush, ltrim, lrange to redisClient if available', async () => {
      const mockLpush = jest.fn().mockResolvedValue(2);
      const mockLtrim = jest.fn().mockResolvedValue('OK');
      const mockLrange = jest.fn().mockResolvedValue(['100', '200']);
      (service as unknown as { redisClient: unknown }).redisClient = {
        lpush: mockLpush,
        ltrim: mockLtrim,
        lrange: mockLrange,
        quit: jest.fn().mockResolvedValue('OK'),
      };

      const len = await service.lpush('latency_key', '100', '200');
      expect(len).toBe(2);
      expect(mockLpush).toHaveBeenCalledWith('latency_key', '100', '200');

      await service.ltrim('latency_key', 0, 1999);
      expect(mockLtrim).toHaveBeenCalledWith('latency_key', 0, 1999);

      const samples = await service.lrange('latency_key', 0, -1);
      expect(samples).toEqual(['100', '200']);
      expect(mockLrange).toHaveBeenCalledWith('latency_key', 0, -1);
    });
  });

  describe('Distributed Lock operations', () => {
    describe('in-memory fallback', () => {
      it('acquires lock when key is free', async () => {
        const acquired = await service.acquireLock('lock:res1', 'owner-1', 10);
        expect(acquired).toBe(true);
      });

      it('rejects lock acquisition when key is already held by another owner', async () => {
        const first = await service.acquireLock('lock:res2', 'owner-1', 10);
        expect(first).toBe(true);

        const second = await service.acquireLock('lock:res2', 'owner-2', 10);
        expect(second).toBe(false);
      });

      it('allows lock acquisition after previous lease expires', async () => {
        await service.acquireLock('lock:res3', 'owner-1', 0.001); // 1ms
        await new Promise((r) => setTimeout(r, 10));

        const second = await service.acquireLock('lock:res3', 'owner-2', 10);
        expect(second).toBe(true);
      });

      it('releases lock only when owner matches and prevents foreign release', async () => {
        await service.acquireLock('lock:res4', 'owner-1', 10);

        // Attempt release with wrong owner
        const wrongRelease = await service.releaseLock('lock:res4', 'owner-2');
        expect(wrongRelease).toBe(false);

        // Lock is still held: another cannot acquire
        const secondAcquire = await service.acquireLock('lock:res4', 'owner-3', 10);
        expect(secondAcquire).toBe(false);

        // Correct owner release
        const correctRelease = await service.releaseLock('lock:res4', 'owner-1');
        expect(correctRelease).toBe(true);

        // Now key is free
        const thirdAcquire = await service.acquireLock('lock:res4', 'owner-3', 10);
        expect(thirdAcquire).toBe(true);
      });

      it('renews lock lease when owner matches and rejects foreign renewal', async () => {
        await service.acquireLock('lock:res5', 'owner-1', 10);

        // Foreign renewal fails
        const foreignRenew = await service.renewLock('lock:res5', 'owner-2', 30);
        expect(foreignRenew).toBe(false);

        // Owner renewal succeeds
        const ownerRenew = await service.renewLock('lock:res5', 'owner-1', 30);
        expect(ownerRenew).toBe(true);
      });
    });

    describe('Redis client delegation', () => {
      it('delegates acquireLock with NX and EX to redisClient', async () => {
        const mockSet = jest.fn().mockResolvedValue('OK');
        (service as unknown as { redisClient: unknown }).redisClient = {
          set: mockSet,
          quit: jest.fn().mockResolvedValue('OK'),
        };

        const result = await service.acquireLock('lock:redis1', 'owner-token', 30);
        expect(result).toBe(true);
        expect(mockSet).toHaveBeenCalledWith(
          'lock:redis1',
          'owner-token',
          'EX',
          30,
          'NX',
        );
      });

      it('returns false when redisClient SET NX fails (lock already held)', async () => {
        const mockSet = jest.fn().mockResolvedValue(null);
        (service as unknown as { redisClient: unknown }).redisClient = {
          set: mockSet,
          quit: jest.fn().mockResolvedValue('OK'),
        };

        const result = await service.acquireLock('lock:redis2', 'owner-token', 30);
        expect(result).toBe(false);
      });

      it('delegates releaseLock with atomic Lua compare-and-delete', async () => {
        const mockEval = jest.fn().mockResolvedValue(1);
        (service as unknown as { redisClient: unknown }).redisClient = {
          eval: mockEval,
          quit: jest.fn().mockResolvedValue('OK'),
        };

        const result = await service.releaseLock('lock:redis3', 'owner-token');
        expect(result).toBe(true);
        expect(mockEval).toHaveBeenCalledWith(
          expect.stringContaining("redis.call('del', KEYS[1])"),
          1,
          'lock:redis3',
          'owner-token',
        );
      });

      it('returns false from releaseLock when owner token does not match in Redis', async () => {
        const mockEval = jest.fn().mockResolvedValue(0);
        (service as unknown as { redisClient: unknown }).redisClient = {
          eval: mockEval,
          quit: jest.fn().mockResolvedValue('OK'),
        };

        const result = await service.releaseLock('lock:redis4', 'wrong-token');
        expect(result).toBe(false);
      });

      it('delegates renewLock with atomic Lua check-and-expire', async () => {
        const mockEval = jest.fn().mockResolvedValue(1);
        (service as unknown as { redisClient: unknown }).redisClient = {
          eval: mockEval,
          quit: jest.fn().mockResolvedValue('OK'),
        };

        const result = await service.renewLock('lock:redis5', 'owner-token', 30);
        expect(result).toBe(true);
        expect(mockEval).toHaveBeenCalledWith(
          expect.stringContaining("redis.call('expire', KEYS[1], ARGV[2])"),
          1,
          'lock:redis5',
          'owner-token',
          30,
        );
      });
    });
  });
});
