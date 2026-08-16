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
        ping: jest.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('PONG'), 1500))),
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
  });
});
