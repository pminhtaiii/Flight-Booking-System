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
});
