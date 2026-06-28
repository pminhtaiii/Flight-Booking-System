import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('CacheService');
  private redisClient: Redis | null = null;
  private inMemoryStore = new Map<string, { value: string; expiry: number }>();

  async onModuleInit() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        reconnectOnError: () => false,
      });

      this.redisClient.on('error', (err) => {
        this.logger.warn(
          `Redis connection error: ${err.message}. Falling back to in-memory cache.`,
        );
      });

      this.redisClient.on('connect', () => {
        this.logger.log('Successfully connected to Redis.');
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to initialize Redis client: ${errMsg}. Using in-memory cache.`);
      this.redisClient = null;
    }
  }

  async onModuleDestroy() {
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to close Redis client: ${errMsg}`);
      }
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.redisClient) {
      try {
        return await this.redisClient.get(key);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Redis GET failed for key ${key}: ${errMsg}. Using in-memory fallback.`,
        );
      }
    }

    const item = this.inMemoryStore.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.inMemoryStore.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.redisClient) {
      try {
        if (ttlSeconds) {
          await this.redisClient.set(key, value, 'EX', ttlSeconds);
        } else {
          await this.redisClient.set(key, value);
        }
        return;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Redis SET failed for key ${key}: ${errMsg}. Using in-memory fallback.`,
        );
      }
    }

    const expiry = ttlSeconds ? Date.now() + ttlSeconds * 1000 : Infinity;
    this.inMemoryStore.set(key, { value, expiry });
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    if (this.redisClient) {
      try {
        const val = await this.redisClient.incr(key);
        if (ttlSeconds && val === 1) {
          await this.redisClient.expire(key, ttlSeconds);
        }
        return val;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Redis INCR failed for key ${key}: ${errMsg}. Using in-memory fallback.`,
        );
      }
    }

    const now = Date.now();
    const item = this.inMemoryStore.get(key);

    let current = 0;
    let expiry = ttlSeconds ? now + ttlSeconds * 1000 : Infinity;

    if (item && now <= item.expiry) {
      current = parseInt(item.value, 10) || 0;
      expiry = item.expiry;
    }

    const nextVal = current + 1;
    this.inMemoryStore.set(key, { value: String(nextVal), expiry });
    return nextVal;
  }

  async del(key: string): Promise<void> {
    if (this.redisClient) {
      try {
        await this.redisClient.del(key);
        return;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Redis DEL failed for key ${key}: ${errMsg}. Using in-memory fallback.`,
        );
      }
    }

    this.inMemoryStore.delete(key);
  }

  async getTtl(key: string): Promise<number> {
    if (this.redisClient) {
      try {
        return await this.redisClient.ttl(key);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Redis TTL failed for key ${key}: ${errMsg}. Using in-memory fallback.`,
        );
      }
    }

    const item = this.inMemoryStore.get(key);
    if (!item) return -2;
    if (item.expiry === Infinity) return -1;
    const remaining = Math.max(0, Math.ceil((item.expiry - Date.now()) / 1000));
    return remaining > 0 ? remaining : -2;
  }

  async keys(pattern: string): Promise<string[]> {
    if (this.redisClient) {
      try {
        return await this.redisClient.keys(pattern);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Redis KEYS failed: ${errMsg}. Using in-memory fallback.`);
      }
    }

    const matched: string[] = [];
    const escapedPattern = pattern
      .replace(/[\\^$.|()+[\]{}]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp('^' + escapedPattern + '$');
    const now = Date.now();
    for (const [key, item] of this.inMemoryStore.entries()) {
      if (regex.test(key)) {
        if (now > item.expiry) {
          this.inMemoryStore.delete(key);
        } else {
          matched.push(key);
        }
      }
    }
    return matched;
  }
}
