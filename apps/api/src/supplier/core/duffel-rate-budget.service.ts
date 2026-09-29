import { Injectable } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';

export type BudgetReservationResult =
  | { ok: true }
  | { ok: false; error: 'EXHAUSTED'; retryAfterSeconds: number; resetAt: string }
  | { ok: false; error: 'UNAVAILABLE'; retryAfterSeconds: number };

@Injectable()
export class DuffelRateBudgetService {
  private readonly defaultDailyLimit = 1500;

  constructor(private readonly cacheService: CacheService) {}

  private resolveDailyLimit(): number {
    const raw = process.env.DUFFEL_DAILY_BUDGET_LIMIT;
    if (raw) {
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return this.defaultDailyLimit;
  }

  async reserveAttempt(extraConstraint?: {
    key: string;
    limit: number;
  }): Promise<BudgetReservationResult> {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const dailyKey = `budget:duffel:daily:${yyyy}-${mm}-${dd}`;

    const nextMidnight = new Date(
      Date.UTC(yyyy, now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
    );
    const resetAt = nextMidnight.toISOString();
    const ttlSeconds = Math.max(1, Math.floor((nextMidnight.getTime() - now.getTime()) / 1000));

    const limit = this.resolveDailyLimit();

    const secondary = extraConstraint
      ? {
          key: extraConstraint.key,
          limit: extraConstraint.limit,
          ttlSeconds,
        }
      : undefined;

    const outcome = await this.cacheService.checkAndIncrement(
      {
        key: dailyKey,
        limit,
        ttlSeconds,
      },
      secondary,
    );

    if (outcome.storeError) {
      return {
        ok: false,
        error: 'UNAVAILABLE',
        retryAfterSeconds: Math.min(ttlSeconds, 60),
      };
    }

    if (!outcome.allowed) {
      return {
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: ttlSeconds,
        resetAt,
      };
    }

    return { ok: true };
  }
}
