import { Test, TestingModule } from '@nestjs/testing';
import {
  BookingProjectionReconciliationService,
  ReconciliationPassSummary,
} from './booking-projection-reconciliation.service';
import { BookingProjectionRepository } from './booking-projection.repository';
import {
  BookingProjectionService,
  MalformedRevisionError,
  SafeBookingProjectionData,
} from './booking-projection.service';
import {
  BookingEventHydratorService,
  CoherentBookingSnapshot,
} from '@/domain-events/booking-event-hydrator.service';
import { BookingProjectionMetrics } from './booking-projection.metrics';

describe('BookingProjectionReconciliationService', () => {
  let service: BookingProjectionReconciliationService;
  let metrics: BookingProjectionMetrics;
  let repository: {
    findStaleOrMissingBookingIds: jest.Mock;
    upsertGuarded: jest.Mock;
  };
  let projectionService: {
    extractProjectionData: jest.Mock;
  };
  let hydrator: {
    hydrate: jest.Mock;
  };

  const mockSafeData: SafeBookingProjectionData = {
    airline: 'Vietnam Airlines',
    origin: 'SGN',
    destination: 'HAN',
    departureAt: new Date('2026-10-01T10:00:00.000Z'),
    arrivalAt: new Date('2026-10-01T12:00:00.000Z'),
    durationMinutes: 120,
    stopCount: 0,
    flightNumber: 'VN 123',
    baggageSummary: '20kg checked',
    refundable: false,
    changeable: true,
  };

  const createMockSnapshot = (id: string, version = 1, status = 'CONFIRMED'): CoherentBookingSnapshot =>
    ({
      id,
      userId: 'usr_test',
      status,
      version,
      contactEmail: 'test@example.com',
      contactPhone: '+84901234567',
      flightOfferId: 'fo_123',
      totalAmount: 1500000,
      baseAmount: 1400000,
      taxAmount: 100000,
      currency: 'VND',
      flightSnapshot: null,
      paymentIntentId: 'pi_test',
      paymentStatus: 'PAID',
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: null,
      cancellationReason: null,
      cancellationRequestedAt: null,
      cancelledAt: null,
      refundStatus: null,
      refundAmount: null,
      itineraryRevisions: [],
    }) as unknown as CoherentBookingSnapshot;

  beforeEach(async () => {
    repository = {
      findStaleOrMissingBookingIds: jest.fn(),
      upsertGuarded: jest.fn(),
    };
    projectionService = {
      extractProjectionData: jest.fn(),
    };
    hydrator = {
      hydrate: jest.fn(),
    };
    metrics = new BookingProjectionMetrics();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingProjectionReconciliationService,
        { provide: BookingProjectionRepository, useValue: repository },
        { provide: BookingProjectionService, useValue: projectionService },
        { provide: BookingEventHydratorService, useValue: hydrator },
        { provide: BookingProjectionMetrics, useValue: metrics },
      ],
    }).compile();

    service = module.get<BookingProjectionReconciliationService>(
      BookingProjectionReconciliationService,
    );
  });

  describe('Single pass candidate processing', () => {
    it('processes candidate IDs using findStaleOrMissingBookingIds(100, this.cursor)', async () => {
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: ['booking-001', 'booking-002'],
        nextCursor: 'booking-002',
        reachedEnd: true,
      });

      const snapshot1 = createMockSnapshot('booking-001', 2, 'CONFIRMED');
      const snapshot2 = createMockSnapshot('booking-002', 3, 'CONFIRMED');

      hydrator.hydrate
        .mockResolvedValueOnce(snapshot1)
        .mockResolvedValueOnce(snapshot2);

      projectionService.extractProjectionData
        .mockReturnValueOnce(mockSafeData)
        .mockReturnValueOnce(mockSafeData);

      repository.upsertGuarded
        .mockResolvedValueOnce({ outcome: 'SUCCESS' })
        .mockResolvedValueOnce({ outcome: 'SUCCESS' });

      const summary = await service.reconcileBatch();

      expect(repository.findStaleOrMissingBookingIds).toHaveBeenCalledTimes(1);
      expect(repository.findStaleOrMissingBookingIds).toHaveBeenCalledWith(100, undefined);

      expect(hydrator.hydrate).toHaveBeenCalledWith('booking-001');
      expect(hydrator.hydrate).toHaveBeenCalledWith('booking-002');

      expect(projectionService.extractProjectionData).toHaveBeenCalledWith(snapshot1);
      expect(projectionService.extractProjectionData).toHaveBeenCalledWith(snapshot2);

      expect(repository.upsertGuarded).toHaveBeenCalledWith({
        bookingId: 'booking-001',
        status: 'CONFIRMED',
        sourceVersion: 2,
        data: mockSafeData,
      });
      expect(repository.upsertGuarded).toHaveBeenCalledWith({
        bookingId: 'booking-002',
        status: 'CONFIRMED',
        sourceVersion: 3,
        data: mockSafeData,
      });

      expect(summary).toEqual<ReconciliationPassSummary>({
        processed: 2,
        repaired: 2,
        current: 0,
        skipped: 0,
        failed: 0,
        nextCursor: 'booking-002',
        reachedEnd: true,
      });
    });

    it('returns summary with 0 processed when no candidates are found', async () => {
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: [],
        nextCursor: null,
        reachedEnd: true,
      });

      const summary = await service.reconcileBatch();

      expect(summary).toEqual<ReconciliationPassSummary>({
        processed: 0,
        repaired: 0,
        current: 0,
        skipped: 0,
        failed: 0,
        nextCursor: null,
        reachedEnd: true,
      });
      expect(hydrator.hydrate).not.toHaveBeenCalled();
    });
  });

  describe('Bounded concurrency (max 5 workers)', () => {
    it('strictly throttles candidate processing to max 5 workers running concurrently', async () => {
      const candidateIds = Array.from({ length: 15 }, (_, i) => `booking-${String(i).padStart(3, '0')}`);
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: candidateIds,
        nextCursor: candidateIds[candidateIds.length - 1],
        reachedEnd: true,
      });

      let activeWorkers = 0;
      let peakConcurrency = 0;

      hydrator.hydrate.mockImplementation(async (id: string) => {
        activeWorkers++;
        if (activeWorkers > peakConcurrency) {
          peakConcurrency = activeWorkers;
        }
        // Artificial async delay to allow concurrency saturation
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeWorkers--;
        return createMockSnapshot(id, 1, 'CONFIRMED');
      });

      projectionService.extractProjectionData.mockReturnValue(mockSafeData);
      repository.upsertGuarded.mockResolvedValue({ outcome: 'SUCCESS' });

      const summary = await service.reconcileBatch();

      expect(peakConcurrency).toBeLessThanOrEqual(5);
      expect(peakConcurrency).toBe(5);
      expect(summary?.processed).toBe(15);
      expect(summary?.repaired).toBe(15);
      expect(hydrator.hydrate).toHaveBeenCalledTimes(15);
    });
  });

  describe('Non-overlapping execution lock', () => {
    it('skips execution tick and returns null if isReconciling is true', async () => {
      let finishFirstPass: () => void = () => {};
      const firstPassBarrier = new Promise<void>((resolve) => {
        finishFirstPass = resolve;
      });

      repository.findStaleOrMissingBookingIds.mockImplementationOnce(async () => {
        await firstPassBarrier;
        return {
          bookingIds: ['booking-lock-1'],
          nextCursor: 'booking-lock-1',
          reachedEnd: true,
        };
      });

      hydrator.hydrate.mockResolvedValue(createMockSnapshot('booking-lock-1'));
      projectionService.extractProjectionData.mockReturnValue(mockSafeData);
      repository.upsertGuarded.mockResolvedValue({ outcome: 'SUCCESS' });

      // Start first pass (blocks on firstPassBarrier)
      const firstPassPromise = service.reconcileBatch();

      // Attempt second pass while first is active
      const secondPassPromise = service.reconcileBatch();
      const secondPassResult = await secondPassPromise;

      expect(secondPassResult).toBeNull();
      expect(repository.findStaleOrMissingBookingIds).toHaveBeenCalledTimes(1);

      // Release first pass and verify it completes
      finishFirstPass();
      const firstPassResult = await firstPassPromise;

      expect(firstPassResult).not.toBeNull();
      expect(firstPassResult?.repaired).toBe(1);

      // Subsequent pass after completion executes normally
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: [],
        nextCursor: null,
        reachedEnd: true,
      });

      const thirdPassResult = await service.reconcileBatch();
      expect(thirdPassResult).not.toBeNull();
      expect(thirdPassResult?.processed).toBe(0);
    });

    it('resets lock if findStaleOrMissingBookingIds throws an error', async () => {
      repository.findStaleOrMissingBookingIds.mockRejectedValueOnce(new Error('DB connection timeout'));

      await expect(service.reconcileBatch()).rejects.toThrow('DB connection timeout');

      // Next pass should not be locked
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: [],
        nextCursor: null,
        reachedEnd: true,
      });

      const result = await service.reconcileBatch();
      expect(result).not.toBeNull();
    });
  });

  describe('Outcome classification', () => {
    it('classifies repaired, current, skipped, and failed accurately', async () => {
      const candidateIds = [
        'b-repaired',
        'b-current',
        'b-skip-null-snapshot',
        'b-skip-null-projection',
        'b-fail-malformed',
        'b-fail-hydrator-throw',
        'b-fail-upsert-throw',
      ];

      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: candidateIds,
        nextCursor: 'b-fail-upsert-throw',
        reachedEnd: false,
      });

      // 1. Repaired: upsertGuarded returns SUCCESS
      hydrator.hydrate.mockResolvedValueOnce(createMockSnapshot('b-repaired', 2));
      projectionService.extractProjectionData.mockReturnValueOnce(mockSafeData);
      repository.upsertGuarded.mockResolvedValueOnce({ outcome: 'SUCCESS' });

      // 2. Current: upsertGuarded returns STALE_IGNORED
      hydrator.hydrate.mockResolvedValueOnce(createMockSnapshot('b-current', 1));
      projectionService.extractProjectionData.mockReturnValueOnce(mockSafeData);
      repository.upsertGuarded.mockResolvedValueOnce({ outcome: 'STALE_IGNORED' });

      // 3. Skipped: hydrator returns null
      hydrator.hydrate.mockResolvedValueOnce(null);

      // 4. Skipped: extractProjectionData returns null
      hydrator.hydrate.mockResolvedValueOnce(createMockSnapshot('b-skip-null-projection', 1));
      projectionService.extractProjectionData.mockReturnValueOnce(null);

      // 5. Failed: extractProjectionData throws MalformedRevisionError
      hydrator.hydrate.mockResolvedValueOnce(createMockSnapshot('b-fail-malformed', 1));
      projectionService.extractProjectionData.mockImplementationOnce(() => {
        throw new MalformedRevisionError('Missing departure airport');
      });

      // 6. Failed: hydrator throws
      hydrator.hydrate.mockRejectedValueOnce(new Error('Prisma read failure'));

      // 7. Failed: upsertGuarded throws
      hydrator.hydrate.mockResolvedValueOnce(createMockSnapshot('b-fail-upsert-throw', 1));
      projectionService.extractProjectionData.mockReturnValueOnce(mockSafeData);
      repository.upsertGuarded.mockRejectedValueOnce(new Error('Unique constraint error'));

      const summary = await service.reconcileBatch();

      expect(summary).toEqual<ReconciliationPassSummary>({
        processed: 7,
        repaired: 1,
        current: 1,
        skipped: 2,
        failed: 3,
        nextCursor: 'b-fail-upsert-throw',
        reachedEnd: false,
      });
    });
  });

  describe('Cursor progression', () => {
    it('sets this.cursor = nextCursor when reachedEnd is false', async () => {
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: ['b-001', 'b-002'],
        nextCursor: 'b-002',
        reachedEnd: false,
      });

      hydrator.hydrate.mockResolvedValue(createMockSnapshot('b-xxx'));
      projectionService.extractProjectionData.mockReturnValue(mockSafeData);
      repository.upsertGuarded.mockResolvedValue({ outcome: 'SUCCESS' });

      const summary = await service.reconcileBatch();

      expect(summary?.nextCursor).toBe('b-002');
      expect(summary?.reachedEnd).toBe(false);
      expect(service.getCursor()).toBe('b-002');

      // Second pass should pass the cursor forward
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: ['b-003'],
        nextCursor: 'b-003',
        reachedEnd: true,
      });

      await service.reconcileBatch();

      expect(repository.findStaleOrMissingBookingIds).toHaveBeenLastCalledWith(100, 'b-002');
    });

    it('resets this.cursor = undefined when reachedEnd is true without scanning extra empty page', async () => {
      // First pass ends with reachedEnd = true
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: ['b-001', 'b-002'],
        nextCursor: 'b-002',
        reachedEnd: true,
      });

      hydrator.hydrate.mockResolvedValue(createMockSnapshot('b-xxx'));
      projectionService.extractProjectionData.mockReturnValue(mockSafeData);
      repository.upsertGuarded.mockResolvedValue({ outcome: 'SUCCESS' });

      const summary = await service.reconcileBatch();

      expect(summary?.reachedEnd).toBe(true);
      expect(service.getCursor()).toBeUndefined();

      // Next pass immediately restarts from beginning with undefined cursor
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: [],
        nextCursor: null,
        reachedEnd: true,
      });

      await service.reconcileBatch();

      expect(repository.findStaleOrMissingBookingIds).toHaveBeenLastCalledWith(100, undefined);
    });
  });

  describe('Malformed row resilience', () => {
    it('malformed candidate does not stop execution of remaining batch and advances cursor', async () => {
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: ['b-good-1', 'b-malformed', 'b-good-2'],
        nextCursor: 'b-good-2',
        reachedEnd: false,
      });

      hydrator.hydrate
        .mockResolvedValueOnce(createMockSnapshot('b-good-1'))
        .mockResolvedValueOnce(createMockSnapshot('b-malformed'))
        .mockResolvedValueOnce(createMockSnapshot('b-good-2'));

      projectionService.extractProjectionData
        .mockReturnValueOnce(mockSafeData)
        .mockImplementationOnce(() => {
          throw new MalformedRevisionError('Corrupted segments array');
        })
        .mockReturnValueOnce(mockSafeData);

      repository.upsertGuarded
        .mockResolvedValueOnce({ outcome: 'SUCCESS' })
        .mockResolvedValueOnce({ outcome: 'SUCCESS' });

      const summary = await service.reconcileBatch();

      expect(summary).toEqual<ReconciliationPassSummary>({
        processed: 3,
        repaired: 2,
        current: 0,
        skipped: 0,
        failed: 1,
        nextCursor: 'b-good-2',
        reachedEnd: false,
      });

      expect(service.getCursor()).toBe('b-good-2');
    });
  });

  describe('Multi-batch 100-item reconciliation passes', () => {
    it('executes a complete pass across multiple 100-item batches until reachedEnd resets the cursor', async () => {
      const batch1Ids = Array.from({ length: 100 }, (_, i) => `batch1-booking-${String(i).padStart(3, '0')}`);
      const batch2Ids = Array.from({ length: 50 }, (_, i) => `batch2-booking-${String(i).padStart(3, '0')}`);

      repository.findStaleOrMissingBookingIds
        .mockResolvedValueOnce({
          bookingIds: batch1Ids,
          nextCursor: batch1Ids[99],
          reachedEnd: false,
        })
        .mockResolvedValueOnce({
          bookingIds: batch2Ids,
          nextCursor: batch2Ids[49],
          reachedEnd: true,
        });

      hydrator.hydrate.mockImplementation(async (id: string) => createMockSnapshot(id));
      projectionService.extractProjectionData.mockReturnValue(mockSafeData);
      repository.upsertGuarded.mockResolvedValue({ outcome: 'SUCCESS' });

      // Pass 1: first 100 items, cursor should advance to batch1-booking-099
      const pass1 = await service.reconcileBatch(100);
      expect(pass1?.processed).toBe(100);
      expect(pass1?.repaired).toBe(100);
      expect(pass1?.reachedEnd).toBe(false);
      expect(service.getCursor()).toBe(batch1Ids[99]);

      // Pass 2: remaining 50 items, reachedEnd is true, cursor resets to undefined
      const pass2 = await service.reconcileBatch(100);
      expect(pass2?.processed).toBe(50);
      expect(pass2?.repaired).toBe(50);
      expect(pass2?.reachedEnd).toBe(true);
      expect(service.getCursor()).toBeUndefined();

      expect(repository.findStaleOrMissingBookingIds).toHaveBeenCalledTimes(2);
      expect(repository.findStaleOrMissingBookingIds).toHaveBeenNthCalledWith(1, 100, undefined);
      expect(repository.findStaleOrMissingBookingIds).toHaveBeenNthCalledWith(2, 100, batch1Ids[99]);
    });
  });

  describe('Reconciliation Metrics & Telemetry', () => {
    it('records reconciliation pass success metrics, tallies, and pass duration on successful batch', async () => {
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: ['b-rep', 'b-cur', 'b-skip'],
        nextCursor: 'b-skip',
        reachedEnd: true,
      });

      // 1. Repaired
      hydrator.hydrate.mockResolvedValueOnce(createMockSnapshot('b-rep', 2));
      projectionService.extractProjectionData.mockReturnValueOnce(mockSafeData);
      repository.upsertGuarded.mockResolvedValueOnce({ outcome: 'SUCCESS' });

      // 2. Current
      hydrator.hydrate.mockResolvedValueOnce(createMockSnapshot('b-cur', 1));
      projectionService.extractProjectionData.mockReturnValueOnce(mockSafeData);
      repository.upsertGuarded.mockResolvedValueOnce({ outcome: 'STALE_IGNORED' });

      // 3. Skipped (snapshot null)
      hydrator.hydrate.mockResolvedValueOnce(null);

      const summary = await service.reconcileBatch();

      expect(summary?.processed).toBe(3);
      expect(metrics.getReconciliationPassTotal('SUCCESS')).toBe(1);
      expect(metrics.getReconciliationPassTotal('ERROR')).toBe(0);
      expect(metrics.getReconciliationStaleFoundTotal()).toBe(3);
      expect(metrics.getReconciliationRepairedTotal()).toBe(1);
      expect(metrics.getReconciliationCurrentTotal()).toBe(1);
      expect(metrics.getReconciliationSkippedTotal()).toBe(1);
      expect(metrics.getReconciliationFailedTotal()).toBe(0);

      const durations = metrics.getReconciliationDurations();
      expect(durations.length).toBe(1);
      expect(durations[0]).toBeGreaterThanOrEqual(0);

      const stats = metrics.getReconciliationDurationStats();
      expect(stats.count).toBe(1);
    });

    it('records reconciliation pass error outcome and duration when batch scanning throws', async () => {
      repository.findStaleOrMissingBookingIds.mockRejectedValueOnce(
        new Error('Prisma query failed'),
      );

      await expect(service.reconcileBatch()).rejects.toThrow('Prisma query failed');

      expect(metrics.getReconciliationPassTotal('ERROR')).toBe(1);
      expect(metrics.getReconciliationPassTotal('SUCCESS')).toBe(0);
      expect(metrics.getReconciliationDurations().length).toBe(1);
    });

    it('records HYDRATION_FAILED failure metric when candidate hydration throws', async () => {
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: ['b-hydrate-err'],
        nextCursor: 'b-hydrate-err',
        reachedEnd: true,
      });

      hydrator.hydrate.mockRejectedValueOnce(new Error('PostgreSQL hydration timeout'));

      const summary = await service.reconcileBatch();

      expect(summary?.failed).toBe(1);
      expect(metrics.getFailureTotal('HYDRATION_FAILED')).toBe(1);
      expect(metrics.getReconciliationFailedTotal()).toBe(1);
    });

    it('records EXTRACTION_FAILED failure metric when extractProjectionData throws', async () => {
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: ['b-extract-err'],
        nextCursor: 'b-extract-err',
        reachedEnd: true,
      });

      hydrator.hydrate.mockResolvedValueOnce(createMockSnapshot('b-extract-err'));
      projectionService.extractProjectionData.mockImplementationOnce(() => {
        throw new MalformedRevisionError('Corrupted segments');
      });

      const summary = await service.reconcileBatch();

      expect(summary?.failed).toBe(1);
      expect(metrics.getFailureTotal('EXTRACTION_FAILED')).toBe(1);
      expect(metrics.getReconciliationFailedTotal()).toBe(1);
    });

    it('records UNEXPECTED_ERROR failure metric when candidate processing throws unexpectedly', async () => {
      repository.findStaleOrMissingBookingIds.mockResolvedValueOnce({
        bookingIds: ['b-upsert-err'],
        nextCursor: 'b-upsert-err',
        reachedEnd: true,
      });

      hydrator.hydrate.mockResolvedValueOnce(createMockSnapshot('b-upsert-err'));
      projectionService.extractProjectionData.mockReturnValueOnce(mockSafeData);
      repository.upsertGuarded.mockRejectedValueOnce(new Error('Unexpected disk full'));

      const summary = await service.reconcileBatch();

      expect(summary?.failed).toBe(1);
      expect(metrics.getFailureTotal('UNEXPECTED_ERROR')).toBe(1);
      expect(metrics.getReconciliationFailedTotal()).toBe(1);
    });
  });
});

