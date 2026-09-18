import {
  BookingProjectionMetrics,
  BOOKING_PROJECTION_METRIC_NAMES,
  REDIS_LATEST_PASS_STATE_KEY,
  REDIS_CONSECUTIVE_ERRORS_KEY,
} from './booking-projection.metrics';

describe('BookingProjectionMetrics', () => {
  let metrics: BookingProjectionMetrics;

  beforeEach(() => {
    metrics = new BookingProjectionMetrics();
  });

  describe('Metric constants', () => {
    it('defines all required metric name constants', () => {
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_PASS_TOTAL).toBe(
        'booking_projection_reconciliation_pass_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_STALE_FOUND_TOTAL).toBe(
        'booking_projection_reconciliation_stale_found_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_REPAIRED_TOTAL).toBe(
        'booking_projection_reconciliation_repaired_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_FAILED_TOTAL).toBe(
        'booking_projection_reconciliation_failed_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_SKIPPED_TOTAL).toBe(
        'booking_projection_reconciliation_skipped_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_CURRENT_TOTAL).toBe(
        'booking_projection_reconciliation_current_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.RECONCILIATION_DURATION_MS).toBe(
        'booking_projection_reconciliation_duration_ms',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.FAILURE_TOTAL).toBe(
        'booking_projection_failure_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.EVENTS_TOTAL).toBe(
        'booking_projection_events_total',
      );
      expect(BOOKING_PROJECTION_METRIC_NAMES.DURATION_MS).toBe(
        'booking_projection_duration_ms',
      );
    });
  });

  describe('Counter: booking_projection_events_total', () => {
    it('tracks event outcomes by eventName and status', () => {
      metrics.incrementEventsTotal('booking.created', 'SUCCESS');
      metrics.incrementEventsTotal('booking.created', 'SUCCESS');
      metrics.incrementEventsTotal('booking.confirmed', 'SUCCESS');
      metrics.incrementEventsTotal('booking.failed', 'ERROR');
      metrics.incrementEventsTotal('booking.disruption.synced', 'STALE_IGNORED');

      expect(metrics.getEventsTotal('booking.created', 'SUCCESS')).toBe(2);
      expect(metrics.getEventsTotal('booking.confirmed', 'SUCCESS')).toBe(1);
      expect(metrics.getEventsTotal('booking.failed', 'ERROR')).toBe(1);
      expect(metrics.getEventsTotal('booking.disruption.synced', 'STALE_IGNORED')).toBe(1);
      expect(metrics.getEventsTotal('booking.created', 'ERROR')).toBe(0);
    });

    it('supports retrieving total count across all statuses or all events', () => {
      metrics.incrementEventsTotal('booking.created', 'SUCCESS', 3);
      metrics.incrementEventsTotal('booking.created', 'ERROR', 1);

      expect(metrics.getEventsTotal('booking.created')).toBe(4);
    });

    it('enforces safe bounded labels with NO PII, NO booking IDs, NO user IDs', () => {
      // If a dynamic or unsafe label is provided, it should be sanitized/normalized
      metrics.incrementEventsTotal('booking_id_bk_1234567890abcdef', 'SUCCESS');
      metrics.incrementEventsTotal('user_id_usr_1234567890abcdef', 'SUCCESS');
      metrics.incrementEventsTotal('traveler@example.com', 'ERROR');

      const allTotals = metrics.getAllEventTotals();
      // Ensure raw booking IDs or emails are not keys in metrics
      const keys = Object.keys(allTotals);
      for (const key of keys) {
        expect(key).not.toContain('bk_1234567890abcdef');
        expect(key).not.toContain('usr_1234567890abcdef');
        expect(key).not.toContain('traveler@example.com');
      }
    });

    it('enforces bounded storage on total distinct label pairs', () => {
      // Push 500 distinct event names
      for (let i = 0; i < 500; i++) {
        metrics.incrementEventsTotal(`booking.event_${i}`, 'SUCCESS');
      }

      const allTotals = metrics.getAllEventTotals();
      expect(Object.keys(allTotals).length).toBeLessThanOrEqual(100);
    });
  });

  describe('Latency timer: booking_projection_duration_ms', () => {
    it('records duration and tracks samples', () => {
      metrics.recordDuration(15);
      metrics.recordDuration(25);
      metrics.recordDuration(50);

      const durations = metrics.getDurations();
      expect(durations).toEqual([15, 25, 50]);

      const stats = metrics.getDurationStats();
      expect(stats.count).toBe(3);
      expect(stats.min).toBe(15);
      expect(stats.max).toBe(50);
      expect(stats.avg).toBeCloseTo(30, 0);
      expect(stats.p50).toBe(25);
    });

    it('enforces bounded storage for duration samples', () => {
      for (let i = 0; i < 2500; i++) {
        metrics.recordDuration(i % 100);
      }

      const durations = metrics.getDurations();
      expect(durations.length).toBeLessThanOrEqual(1000);
    });

    it('returns zeroes when stats computed on empty samples', () => {
      const stats = metrics.getDurationStats();
      expect(stats).toEqual({
        count: 0,
        p50: 0,
        p90: 0,
        p95: 0,
        p99: 0,
        min: 0,
        max: 0,
        avg: 0,
      });
    });
  });

  describe('Reset', () => {
    it('clears all counters and samples', async () => {
      metrics.incrementEventsTotal('booking.created', 'SUCCESS');
      metrics.recordDuration(42);
      await metrics.incrementReconciliationPassTotal('SUCCESS');
      metrics.incrementReconciliationStaleFoundTotal(5);
      metrics.incrementReconciliationRepairedTotal(3);
      metrics.incrementReconciliationFailedTotal(1);
      metrics.incrementReconciliationSkippedTotal(1);
      metrics.incrementReconciliationCurrentTotal(2);
      metrics.recordReconciliationDuration(120);
      metrics.incrementFailureTotal('HYDRATION_FAILED', 2);

      await metrics.reset();

      expect(metrics.getEventsTotal('booking.created', 'SUCCESS')).toBe(0);
      expect(metrics.getDurations()).toHaveLength(0);
      expect(Object.keys(metrics.getAllEventTotals())).toHaveLength(0);
      expect(metrics.getReconciliationPassTotal()).toBe(0);
      expect(metrics.getReconciliationStaleFoundTotal()).toBe(0);
      expect(metrics.getReconciliationRepairedTotal()).toBe(0);
      expect(metrics.getReconciliationFailedTotal()).toBe(0);
      expect(metrics.getReconciliationSkippedTotal()).toBe(0);
      expect(metrics.getReconciliationCurrentTotal()).toBe(0);
      expect(metrics.getReconciliationDurations()).toHaveLength(0);
      expect(metrics.getFailureTotal()).toBe(0);
    });
  });

  describe('Reconciliation Metrics', () => {
    it('tracks reconciliation pass outcomes (SUCCESS / ERROR)', async () => {
      await metrics.incrementReconciliationPassTotal('SUCCESS');
      await metrics.incrementReconciliationPassTotal('SUCCESS');
      await metrics.incrementReconciliationPassTotal('ERROR');

      expect(metrics.getReconciliationPassTotal('SUCCESS')).toBe(2);
      expect(metrics.getReconciliationPassTotal('ERROR')).toBe(1);
      expect(metrics.getReconciliationPassTotal()).toBe(3);
    });

    it('sanitizes invalid or unsafe reconciliation pass outcomes to ERROR', async () => {
      await metrics.incrementReconciliationPassTotal('INVALID_OUTCOME');
      await metrics.incrementReconciliationPassTotal('bk_1234567890abcdef');
      await metrics.incrementReconciliationPassTotal('admin@booking.com');

      expect(metrics.getReconciliationPassTotal('SUCCESS')).toBe(0);
      expect(metrics.getReconciliationPassTotal('ERROR')).toBe(3);
      expect(metrics.getReconciliationPassTotal()).toBe(3);
    });

    it('tracks reconciliation candidate tallies correctly', () => {
      metrics.incrementReconciliationStaleFoundTotal(10);
      metrics.incrementReconciliationRepairedTotal(4);
      metrics.incrementReconciliationFailedTotal(2);
      metrics.incrementReconciliationSkippedTotal(1);
      metrics.incrementReconciliationCurrentTotal(3);

      expect(metrics.getReconciliationStaleFoundTotal()).toBe(10);
      expect(metrics.getReconciliationRepairedTotal()).toBe(4);
      expect(metrics.getReconciliationFailedTotal()).toBe(2);
      expect(metrics.getReconciliationSkippedTotal()).toBe(1);
      expect(metrics.getReconciliationCurrentTotal()).toBe(3);

      // Default increment amount is 1
      metrics.incrementReconciliationRepairedTotal();
      expect(metrics.getReconciliationRepairedTotal()).toBe(5);
    });

    it('records reconciliation durations and computes duration statistics', () => {
      metrics.recordReconciliationDuration(100);
      metrics.recordReconciliationDuration(200);
      metrics.recordReconciliationDuration(300);

      const durations = metrics.getReconciliationDurations();
      expect(durations).toEqual([100, 200, 300]);

      const stats = metrics.getReconciliationDurationStats();
      expect(stats.count).toBe(3);
      expect(stats.min).toBe(100);
      expect(stats.max).toBe(300);
      expect(stats.avg).toBe(200);
      expect(stats.p50).toBe(200);
    });

    it('enforces bounded storage for reconciliation duration samples (max 1000)', () => {
      for (let i = 0; i < 1500; i++) {
        metrics.recordReconciliationDuration(i % 50);
      }
      expect(metrics.getReconciliationDurations().length).toBeLessThanOrEqual(1000);
    });

    it('returns zeroes when reconciliation stats are computed on empty samples', () => {
      const stats = metrics.getReconciliationDurationStats();
      expect(stats).toEqual({
        count: 0,
        p50: 0,
        p90: 0,
        p95: 0,
        p99: 0,
        min: 0,
        max: 0,
        avg: 0,
      });
    });
  });

  describe('Failure Metrics: booking_projection_failure_total', () => {
    it('tracks failure totals across bounded error types', () => {
      metrics.incrementFailureTotal('HYDRATION_FAILED', 2);
      metrics.incrementFailureTotal('EXTRACTION_FAILED', 1);
      metrics.incrementFailureTotal('UNEXPECTED_ERROR', 1);
      metrics.incrementFailureTotal('INVALID_EVENT', 3);
      metrics.incrementFailureTotal('DATABASE_ERROR', 2);

      expect(metrics.getFailureTotal('HYDRATION_FAILED')).toBe(2);
      expect(metrics.getFailureTotal('EXTRACTION_FAILED')).toBe(1);
      expect(metrics.getFailureTotal('UNEXPECTED_ERROR')).toBe(1);
      expect(metrics.getFailureTotal('INVALID_EVENT')).toBe(3);
      expect(metrics.getFailureTotal('DATABASE_ERROR')).toBe(2);
      expect(metrics.getFailureTotal('UNKNOWN')).toBe(0);
      expect(metrics.getFailureTotal()).toBe(9);
    });

    it('sanitizes unsafe strings, booking IDs, user IDs, emails, UUIDs into UNKNOWN', () => {
      metrics.incrementFailureTotal('bk_1234567890abcdef');
      metrics.incrementFailureTotal('usr_1234567890abcdef');
      metrics.incrementFailureTotal('error@example.com');
      metrics.incrementFailureTotal('550e8400-e29b-41d4-a716-446655440000');
      metrics.incrementFailureTotal('RANDOM_ARBITRARY_EXCEPTION');

      expect(metrics.getFailureTotal('UNKNOWN')).toBe(5);
      expect(metrics.getFailureTotal('HYDRATION_FAILED')).toBe(0);
      expect(metrics.getFailureTotal()).toBe(5);
    });
  });

  describe('Health snapshot: getHealthSnapshot()', () => {
    it('returns status ok with empty/zero metrics on initial state', async () => {
      const snapshot = await metrics.getHealthSnapshot();
      expect(snapshot.status).toBe('ok');
      expect(snapshot.dependencies).toEqual({
        database: 'up',
        redis: 'up',
      });
      expect(snapshot.metrics.reconciliation.passes).toEqual({
        success: 0,
        error: 0,
      });
      expect(snapshot.metrics.reconciliation.candidates).toEqual({
        staleFound: 0,
        repaired: 0,
        failed: 0,
        skipped: 0,
        current: 0,
      });
      expect(snapshot.metrics.failures).toEqual({});
      expect(snapshot.metrics.events).toEqual({});
      expect(snapshot.metrics.reconciliation.duration.count).toBe(0);
    });

    it('returns status ok with populated metrics when no failures or pass errors exist', async () => {
      metrics.incrementEventsTotal('booking.created', 'SUCCESS');
      await metrics.incrementReconciliationPassTotal('SUCCESS');
      metrics.incrementReconciliationStaleFoundTotal(2);
      metrics.incrementReconciliationRepairedTotal(2);
      metrics.recordReconciliationDuration(150);

      const snapshot = await metrics.getHealthSnapshot();
      expect(snapshot.status).toBe('ok');
      expect(snapshot.metrics.reconciliation.passes.success).toBe(1);
      expect(snapshot.metrics.reconciliation.passes.error).toBe(0);
      expect(snapshot.metrics.reconciliation.candidates.staleFound).toBe(2);
      expect(snapshot.metrics.reconciliation.candidates.repaired).toBe(2);
      expect(snapshot.metrics.reconciliation.duration.count).toBe(1);
      expect(snapshot.metrics.events['booking.created:SUCCESS']).toBe(1);
      expect(snapshot.metrics.failures).toEqual({});
    });

    it('preserves failure counters without marking status degraded when no pass errors exist', async () => {
      metrics.incrementFailureTotal('HYDRATION_FAILED', 1);

      const snapshot = await metrics.getHealthSnapshot();
      expect(snapshot.status).toBe('ok');
      expect(snapshot.metrics.failures['HYDRATION_FAILED']).toBe(1);
    });

    it('returns status degraded when reconciliation pass has errors', async () => {
      await metrics.incrementReconciliationPassTotal('ERROR', 1);

      const snapshot = await metrics.getHealthSnapshot();
      expect(snapshot.status).toBe('degraded');
      expect(snapshot.metrics.reconciliation.passes.error).toBe(1);
    });

    it('recovers status from degraded back to ok when transient failure is followed by successful reconciliation pass', async () => {
      // 1. Initial state is ok
      let snapshot = await metrics.getHealthSnapshot();
      expect(snapshot.status).toBe('ok');

      // 2. Reconciliation error occurs -> status degraded
      await metrics.incrementReconciliationPassTotal('ERROR', 1);
      metrics.incrementFailureTotal('HYDRATION_FAILED', 1);
      snapshot = await metrics.getHealthSnapshot();
      expect(snapshot.status).toBe('degraded');
      expect(snapshot.metrics.failures['HYDRATION_FAILED']).toBe(1);
      expect(snapshot.metrics.reconciliation.passes.error).toBe(1);

      // 3. Successful reconciliation pass occurs -> status recovers to ok even though failure counters remain
      await metrics.incrementReconciliationPassTotal('SUCCESS', 1);
      snapshot = await metrics.getHealthSnapshot();
      expect(snapshot.status).toBe('ok');
      expect(snapshot.metrics.failures['HYDRATION_FAILED']).toBe(1);
      expect(snapshot.metrics.reconciliation.passes.success).toBe(1);
      expect(snapshot.metrics.reconciliation.passes.error).toBe(1);

      // 4. Reconciliation error occurs -> status degraded again
      await metrics.incrementReconciliationPassTotal('ERROR', 1);
      snapshot = await metrics.getHealthSnapshot();
      expect(snapshot.status).toBe('degraded');

      // 5. Subsequent successful pass recovers back to ok
      await metrics.incrementReconciliationPassTotal('SUCCESS', 1);
      snapshot = await metrics.getHealthSnapshot();
      expect(snapshot.status).toBe('ok');
      expect(snapshot.metrics.reconciliation.passes.error).toBe(2);
    });

    it('degrades status when consecutive pass errors reach threshold of 3', async () => {
      await metrics.incrementReconciliationPassTotal('ERROR', 1);
      await metrics.incrementReconciliationPassTotal('ERROR', 1);
      expect(metrics.getConsecutivePassErrors()).toBe(2);

      await metrics.incrementReconciliationPassTotal('ERROR', 1);
      expect(metrics.getConsecutivePassErrors()).toBe(3);

      const snapshot = await metrics.getHealthSnapshot();
      expect(snapshot.status).toBe('degraded');
    });
  });

  describe('Redis persistence and dependencies', () => {
    let mockCacheService: {
      incrby: jest.Mock;
      lpush: jest.Mock;
      ltrim: jest.Mock;
      lrange: jest.Mock;
      keys: jest.Mock;
      get: jest.Mock;
      set: jest.Mock;
      checkHealth: jest.Mock;
      del: jest.Mock;
    };
    let mockPrisma: {
      $transaction: jest.Mock;
    };
    let distributedMetrics: BookingProjectionMetrics;

    beforeEach(() => {
      mockCacheService = {
        incrby: jest.fn().mockResolvedValue(1),
        lpush: jest.fn().mockResolvedValue(1),
        ltrim: jest.fn().mockResolvedValue(undefined),
        lrange: jest.fn().mockResolvedValue([]),
        keys: jest.fn().mockResolvedValue([]),
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        checkHealth: jest.fn().mockResolvedValue('up'),
        del: jest.fn().mockResolvedValue(undefined),
      };
      mockPrisma = {
        $transaction: jest.fn().mockImplementation(async (cb) => {
          const tx = {
            $executeRawUnsafe: jest.fn().mockResolvedValue(1),
            $queryRaw: jest.fn().mockResolvedValue([1]),
          };
          return cb(tx);
        }),
      };
      distributedMetrics = new BookingProjectionMetrics(
        mockCacheService as any,
        mockPrisma as any,
      );
    });

    it('persists counter increments to Redis asynchronously', async () => {
      distributedMetrics.incrementEventsTotal('booking.created', 'SUCCESS', 2);
      expect(mockCacheService.incrby).toHaveBeenCalledWith(
        'metrics:booking_projection:counter:events:booking.created:SUCCESS',
        2,
      );

      await distributedMetrics.incrementReconciliationPassTotal('SUCCESS', 1);
      expect(mockCacheService.incrby).toHaveBeenCalledWith(
        'metrics:booking_projection:counter:reconciliation:pass:success',
        1,
      );

      await distributedMetrics.incrementReconciliationPassTotal('ERROR', 1);
      expect(mockCacheService.incrby).toHaveBeenCalledWith(
        'metrics:booking_projection:counter:reconciliation:pass:error',
        1,
      );

      distributedMetrics.incrementReconciliationStaleFoundTotal(5);
      expect(mockCacheService.incrby).toHaveBeenCalledWith(
        'metrics:booking_projection:counter:reconciliation:stale_found',
        5,
      );

      distributedMetrics.incrementReconciliationRepairedTotal(3);
      expect(mockCacheService.incrby).toHaveBeenCalledWith(
        'metrics:booking_projection:counter:reconciliation:repaired',
        3,
      );

      distributedMetrics.incrementReconciliationFailedTotal(2);
      expect(mockCacheService.incrby).toHaveBeenCalledWith(
        'metrics:booking_projection:counter:reconciliation:failed',
        2,
      );

      distributedMetrics.incrementReconciliationSkippedTotal(1);
      expect(mockCacheService.incrby).toHaveBeenCalledWith(
        'metrics:booking_projection:counter:reconciliation:skipped',
        1,
      );

      distributedMetrics.incrementReconciliationCurrentTotal(4);
      expect(mockCacheService.incrby).toHaveBeenCalledWith(
        'metrics:booking_projection:counter:reconciliation:current',
        4,
      );

      distributedMetrics.incrementFailureTotal('HYDRATION_FAILED', 2);
      expect(mockCacheService.incrby).toHaveBeenCalledWith(
        'metrics:booking_projection:counter:failure:HYDRATION_FAILED',
        2,
      );
    });

    it('persists duration samples to Redis list', () => {
      distributedMetrics.recordDuration(45);
      expect(mockCacheService.lpush).toHaveBeenCalledWith(
        'metrics:booking_projection:latency:duration_ms',
        '45',
      );
      expect(mockCacheService.ltrim).toHaveBeenCalledWith(
        'metrics:booking_projection:latency:duration_ms',
        0,
        999,
      );

      distributedMetrics.recordReconciliationDuration(120);
      expect(mockCacheService.lpush).toHaveBeenCalledWith(
        'metrics:booking_projection:latency:reconciliation_duration_ms',
        '120',
      );
      expect(mockCacheService.ltrim).toHaveBeenCalledWith(
        'metrics:booking_projection:latency:reconciliation_duration_ms',
        0,
        999,
      );
    });

    it('merges distributed counters from Redis in getHealthSnapshot', async () => {
      mockCacheService.keys.mockResolvedValueOnce([
        'metrics:booking_projection:counter:reconciliation:pass:success',
        'metrics:booking_projection:counter:reconciliation:stale_found',
        'metrics:booking_projection:counter:reconciliation:repaired',
        'metrics:booking_projection:counter:events:booking.created:SUCCESS',
        'metrics:booking_projection:counter:failure:DATABASE_ERROR',
      ]);
      mockCacheService.get.mockImplementation(async (key: string) => {
        if (key.endsWith('pass:success')) return '10';
        if (key.endsWith('stale_found')) return '5';
        if (key.endsWith('repaired')) return '4';
        if (key.endsWith('booking.created:SUCCESS')) return '25';
        if (key.endsWith('DATABASE_ERROR')) return '2';
        return null;
      });

      const snapshot = await distributedMetrics.getHealthSnapshot();
      expect(snapshot.dependencies).toEqual({ database: 'up', redis: 'up' });
      expect(snapshot.metrics.reconciliation.passes.success).toBe(10);
      expect(snapshot.metrics.reconciliation.candidates.staleFound).toBe(5);
      expect(snapshot.metrics.reconciliation.candidates.repaired).toBe(4);
      expect(snapshot.metrics.events['booking.created:SUCCESS']).toBe(25);
      expect(snapshot.metrics.failures['DATABASE_ERROR']).toBe(2);
    });

    it('reports database down and degraded status when prisma check throws', async () => {
      mockPrisma.$transaction.mockRejectedValueOnce(new Error('Connection lost'));

      const snapshot = await distributedMetrics.getHealthSnapshot();
      expect(snapshot.dependencies.database).toBe('down');
      expect(snapshot.status).toBe('degraded');
    });

    it('reports redis down and degraded status when cacheService checkHealth fails', async () => {
      mockCacheService.checkHealth.mockResolvedValueOnce('down');

      const snapshot = await distributedMetrics.getHealthSnapshot();
      expect(snapshot.dependencies.redis).toBe('down');
      expect(snapshot.status).toBe('degraded');
    });

    it('persists cluster pass state to Redis on reconciliation pass increment', async () => {
      await distributedMetrics.incrementReconciliationPassTotal('ERROR', 1);

      expect(mockCacheService.set).toHaveBeenCalledWith(
        REDIS_LATEST_PASS_STATE_KEY,
        expect.stringContaining('"outcome":"ERROR"'),
      );
    });

    it('overrides local pass state with cluster pass state stored in Redis when available', async () => {
      // Local state has no error (outcome undefined)
      // Redis cluster pass state has ERROR
      mockCacheService.get.mockImplementation(async (key: string) => {
        if (key === REDIS_LATEST_PASS_STATE_KEY) {
          return JSON.stringify({
            outcome: 'ERROR',
            consecutiveErrors: 1,
            timestamp: Date.now(),
          });
        }
        return null;
      });

      const snapshot = await distributedMetrics.getHealthSnapshot();
      expect(snapshot.status).toBe('degraded');
    });

    it('clears degraded status across replicas when a successful pass is recorded in Redis', async () => {
      // Local state has an error
      await distributedMetrics.incrementReconciliationPassTotal('ERROR', 1);

      // But another replica succeeded and updated Redis cluster pass state
      mockCacheService.get.mockImplementation(async (key: string) => {
        if (key === REDIS_LATEST_PASS_STATE_KEY) {
          return JSON.stringify({
            outcome: 'SUCCESS',
            consecutiveErrors: 0,
            timestamp: Date.now(),
          });
        }
        return null;
      });

      const snapshot = await distributedMetrics.getHealthSnapshot();
      expect(snapshot.status).toBe('ok');
    });

    it('clears latest cluster pass state from Redis on reset', async () => {
      await distributedMetrics.reset();
      expect(mockCacheService.del).toHaveBeenCalledWith(
        REDIS_LATEST_PASS_STATE_KEY,
      );
      expect(mockCacheService.del).toHaveBeenCalledWith(
        REDIS_CONSECUTIVE_ERRORS_KEY,
      );
    });

    it('does not overwrite Redis pass state when pass has older timestamp than existing state (monotonic ordering)', async () => {
      const t1Older = 1000;
      const t2Newer = 2000;

      // Redis already holds newer pass state at t2Newer
      mockCacheService.get.mockImplementation(async (key: string) => {
        if (key === REDIS_LATEST_PASS_STATE_KEY) {
          return JSON.stringify({
            outcome: 'SUCCESS',
            consecutiveErrors: 0,
            timestamp: t2Newer,
          });
        }
        return null;
      });

      // Pass with older timestamp t1Older completes later
      await distributedMetrics.incrementReconciliationPassTotal('ERROR', 1, t1Older);

      // Verify that Redis latest_pass_state was NOT overwritten
      expect(mockCacheService.set).not.toHaveBeenCalled();
    });

    it('overwrites Redis pass state when incoming pass has newer timestamp', async () => {
      const t1Older = 1000;
      const t2Newer = 2000;

      mockCacheService.get.mockImplementation(async (key: string) => {
        if (key === REDIS_LATEST_PASS_STATE_KEY) {
          return JSON.stringify({
            outcome: 'ERROR',
            consecutiveErrors: 1,
            timestamp: t1Older,
          });
        }
        return null;
      });

      await distributedMetrics.incrementReconciliationPassTotal('SUCCESS', 1, t2Newer);

      expect(mockCacheService.set).toHaveBeenCalledWith(
        REDIS_LATEST_PASS_STATE_KEY,
        JSON.stringify({
          outcome: 'SUCCESS',
          consecutiveErrors: 0,
          timestamp: t2Newer,
        }),
      );
    });

    it('atomically tracks consecutive errors in Redis across multiple error passes', async () => {
      let redisErrors = 0;
      mockCacheService.incrby.mockImplementation(async (key: string, amount: number) => {
        if (key === REDIS_CONSECUTIVE_ERRORS_KEY) {
          redisErrors += amount;
          return redisErrors;
        }
        return 1;
      });
      mockCacheService.del.mockImplementation(async (key: string) => {
        if (key === REDIS_CONSECUTIVE_ERRORS_KEY) {
          redisErrors = 0;
        }
      });

      // Pass 1 fails
      await distributedMetrics.incrementReconciliationPassTotal('ERROR', 1, 100);
      expect(mockCacheService.incrby).toHaveBeenCalledWith(REDIS_CONSECUTIVE_ERRORS_KEY, 1);
      expect(redisErrors).toBe(1);

      // Pass 2 fails
      await distributedMetrics.incrementReconciliationPassTotal('ERROR', 1, 200);
      expect(redisErrors).toBe(2);

      // Pass 3 fails
      await distributedMetrics.incrementReconciliationPassTotal('ERROR', 1, 300);
      expect(redisErrors).toBe(3);

      // Health snapshot reflects consecutive errors
      mockCacheService.get.mockImplementation(async (key: string) => {
        if (key === REDIS_CONSECUTIVE_ERRORS_KEY) {
          return String(redisErrors);
        }
        if (key === REDIS_LATEST_PASS_STATE_KEY) {
          return JSON.stringify({
            outcome: 'ERROR',
            consecutiveErrors: redisErrors,
            timestamp: 300,
          });
        }
        return null;
      });

      const snapshot = await distributedMetrics.getHealthSnapshot();
      expect(snapshot.status).toBe('degraded');

      // Pass 4 succeeds -> resets consecutive errors key in Redis
      await distributedMetrics.incrementReconciliationPassTotal('SUCCESS', 1, 400);
      expect(mockCacheService.del).toHaveBeenCalledWith(REDIS_CONSECUTIVE_ERRORS_KEY);
      expect(redisErrors).toBe(0);
    });
  });
});


