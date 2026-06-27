import { Injectable } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import * as crypto from 'crypto';

@Injectable()
export class LockoutService {
  constructor(private readonly cacheService: CacheService) {}

  private hashIp(ip: string): string {
    return crypto.createHash('sha256').update(ip).digest('hex');
  }

  async isLockedOut(ip: string): Promise<{ locked: boolean; retryAfterSeconds: number }> {
    const ipHash = this.hashIp(ip);
    const lockoutKey = `auth:lockout:${ipHash}`;

    const ttl = await this.cacheService.getTtl(lockoutKey);
    if (ttl > 0) {
      return { locked: true, retryAfterSeconds: ttl };
    }
    // ioredis returns -2 if the key does not exist
    return { locked: false, retryAfterSeconds: 0 };
  }

  async recordFailedAttempt(ip: string): Promise<{ locked: boolean; retryAfterSeconds: number; attempts: number }> {
    const ipHash = this.hashIp(ip);
    const failedKey = `auth:failed:${ipHash}`;
    const lockoutKey = `auth:lockout:${ipHash}`;
    const levelKey = `auth:lockout-level:${ipHash}`;

    const attempts = await this.cacheService.incr(failedKey, 15 * 60);

    if (attempts >= 5) {
      const levelStr = await this.cacheService.get(levelKey);
      let level = levelStr ? parseInt(levelStr, 10) : 0;
      level = level + 1;
      await this.cacheService.set(levelKey, String(level), 24 * 60 * 60);

      const durationLevel = Math.min(level, 4);
      const duration = 60 * Math.pow(2, durationLevel - 1);
      await this.cacheService.set(lockoutKey, 'true', duration);

      return { locked: true, retryAfterSeconds: duration, attempts };
    }

    return { locked: false, retryAfterSeconds: 0, attempts };
  }

  async resetLockoutState(ip: string): Promise<void> {
    const ipHash = this.hashIp(ip);
    const failedKey = `auth:failed:${ipHash}`;
    const lockoutKey = `auth:lockout:${ipHash}`;
    const levelKey = `auth:lockout-level:${ipHash}`;

    await this.cacheService.del(failedKey);
    await this.cacheService.del(lockoutKey);
    await this.cacheService.del(levelKey);
  }

  async clearLockoutForIp(ip: string, keepEscalation: boolean): Promise<void> {
    const ipHash = this.hashIp(ip);
    const lockoutKey = `auth:lockout:${ipHash}`;
    await this.cacheService.del(lockoutKey);

    if (!keepEscalation) {
      const failedKey = `auth:failed:${ipHash}`;
      const levelKey = `auth:lockout-level:${ipHash}`;
      await this.cacheService.del(failedKey);
      await this.cacheService.del(levelKey);
    }
  }

  async clearAllLockouts(): Promise<void> {
    const failedKeys = await this.cacheService.keys('auth:failed:*');
    const lockoutKeys = await this.cacheService.keys('auth:lockout:*');
    const levelKeys = await this.cacheService.keys('auth:lockout-level:*');

    for (const key of [...failedKeys, ...lockoutKeys, ...levelKeys]) {
      await this.cacheService.del(key);
    }
  }
}
