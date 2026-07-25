import { ReconciliationService } from './reconciliation.service';
import { BookingService, BookingWithRelations } from '@/booking/booking.service';
import { PrismaService } from '@/prisma/prisma.service';
import { SupplierSyncService } from './supplier-sync.service';
import { CacheService } from '@/cache/cache.service';
import { DisruptionStatus, DisruptionActorType } from '@prisma/client';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { PaymentRefundService } from '@/payment/payment-refund.service';

describe('ReconciliationService & Booking Completion', () => {
  describe('ReconciliationService', () => {
    let reconciliationService: ReconciliationService;
    let mockPrisma: {
      booking: {
        findMany: jest.Mock;
        updateMany: jest.Mock;
      };
    };
    let mockSupplierSyncService: {
      syncBooking: jest.Mock;
    };
    let mockCacheService: {
      get: jest.Mock;
      set: jest.Mock;
      incr: jest.Mock;
      decr: jest.Mock;
      del: jest.Mock;
    };
    let mockBookingService: {
      checkAndCompleteBooking: jest.Mock;
    };

    beforeEach(() => {
      mockPrisma = {
        booking: {
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockSupplierSyncService = {
        syncBooking: jest.fn().mockResolvedValue({ status: 'NO_CHANGE' }),
      };
      mockCacheService = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(null),
        incr: jest.fn().mockResolvedValue(1),
        decr: jest.fn().mockResolvedValue(0),
        del: jest.fn().mockResolvedValue(null),
      };
      mockBookingService = {
        checkAndCompleteBooking: jest.fn().mockImplementation((booking: BookingWithRelations) => {
          return Promise.resolve({ ...booking, status: 'COMPLETED' });
        }),
      };

      reconciliationService = new ReconciliationService(
        mockPrisma as unknown as PrismaService,
        mockSupplierSyncService as unknown as SupplierSyncService,
        mockCacheService as unknown as CacheService,
        mockBookingService as unknown as BookingService,
      );
    });

    it('should query bookings using correct boundaries and stable ordering', async () => {
      mockPrisma.booking.findMany
        .mockResolvedValueOnce([]) // stale sweep
        .mockResolvedValueOnce([
          { id: 'b-1', status: 'CONFIRMED', duffelOrderId: 'ord-1' },
        ]); // eligible query

      const result = await reconciliationService.reconcile();

      expect(mockPrisma.booking.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'CONFIRMED',
            duffelOrderId: { not: null },
            nextUnflownDepartureAt: expect.any(Object),
            AND: expect.any(Array),
          }),
          take: 20,
          orderBy: [
            { lastDuffelSyncedAt: { sort: 'asc', nulls: 'first' } },
            { nextUnflownDepartureAt: 'asc' },
            { id: 'asc' },
          ],
        })
      );

      expect(mockSupplierSyncService.syncBooking).toHaveBeenCalledWith('b-1', 'RECONCILIATION');
      expect(result).toEqual({
        selected: 1,
        processed: 1,
        unchanged: 1,
        changed: 0,
        failed: 0,
        deferred: 0,
        stale: 0,
        budgetBlocked: 0,
      });
    });

    it('should complete stale bookings that passed final arrival', async () => {
      mockPrisma.booking.findMany
        .mockResolvedValueOnce([
          { id: 'b-stale', status: 'CONFIRMED', currentFinalArrivalAt: new Date(Date.now() - 3600000) },
        ]) // stale sweep
        .mockResolvedValueOnce([]); // eligible query

      const result = await reconciliationService.reconcile();

      expect(mockPrisma.booking.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'CONFIRMED',
            OR: [
              { currentFinalArrivalAt: expect.any(Object) },
              { AND: expect.any(Array), },
            ],
          }),
        })
      );

      expect(mockBookingService.checkAndCompleteBooking).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'b-stale' })
      );
      expect(result.stale).toBe(1);
    });

    it('should respect env var batch size limit', async () => {
      process.env.DUFFEL_RECONCILIATION_BATCH_SIZE = '10';
      mockPrisma.booking.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await reconciliationService.reconcile();

      expect(mockPrisma.booking.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          take: 10,
        })
      );

      delete process.env.DUFFEL_RECONCILIATION_BATCH_SIZE;
    });

    it('should defer processing and log metrics if budget is exhausted before start', async () => {
      mockPrisma.booking.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'b-1', status: 'CONFIRMED', duffelOrderId: 'ord-1' },
        ]);
      // Budget limit is 2000, mock CacheService to return 2000 (fully exhausted)
      mockCacheService.get.mockResolvedValue('2000');

      const result = await reconciliationService.reconcile();

      expect(mockSupplierSyncService.syncBooking).not.toHaveBeenCalled();
      expect(mockCacheService.incr).not.toHaveBeenCalled();
      expect(result.budgetBlocked).toBe(1);
      expect(result.processed).toBe(0);
    });

    it('should defer processing if budget is exhausted during increment', async () => {
      mockPrisma.booking.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'b-1', status: 'CONFIRMED', duffelOrderId: 'ord-1' },
        ]);
      mockCacheService.get.mockResolvedValue('1999');
      // Incremented value exceeds the limit (e.g. 2001)
      mockCacheService.incr.mockResolvedValue(2001);

      const result = await reconciliationService.reconcile();

      expect(mockSupplierSyncService.syncBooking).not.toHaveBeenCalled();
      expect(mockCacheService.decr).toHaveBeenCalled();
      expect(result.budgetBlocked).toBe(1);
      expect(result.processed).toBe(0);
    });

    it('should increment unchanged count for NO_CHANGE or duplicate status', async () => {
      mockPrisma.booking.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'b-1', status: 'CONFIRMED', duffelOrderId: 'ord-1' },
        ]);
      mockSupplierSyncService.syncBooking.mockResolvedValue({ status: 'CONVERGED_DUPLICATE' });

      const result = await reconciliationService.reconcile();

      expect(result.changed).toBe(0);
      expect(result.unchanged).toBe(1);
      expect(result.processed).toBe(1);
    });

    it('should increment changed count if revision was created', async () => {
      mockPrisma.booking.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'b-1', status: 'CONFIRMED', duffelOrderId: 'ord-1' },
        ]);
      mockSupplierSyncService.syncBooking.mockResolvedValue({
        status: 'REVISION_CREATED',
        revisionId: 'rev-1',
      });

      const result = await reconciliationService.reconcile();

      expect(result.changed).toBe(1);
      expect(result.unchanged).toBe(0);
      expect(result.processed).toBe(1);
    });

    it('should decrement budget back if sync result is SKIPPED_LOCKED or SKIPPED_INELIGIBLE', async () => {
      mockPrisma.booking.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'b-1', status: 'CONFIRMED', duffelOrderId: 'ord-1' },
        ]);
      mockSupplierSyncService.syncBooking.mockResolvedValue({ status: 'SKIPPED_LOCKED' });

      const result = await reconciliationService.reconcile();

      expect(mockCacheService.decr).toHaveBeenCalled();
      expect(result.deferred).toBe(1);
      expect(result.processed).toBe(0);
    });

    it('should handle failures gracefully, update retry metadata with exponential backoff and release claim', async () => {
      mockPrisma.booking.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'b-1', status: 'CONFIRMED', duffelOrderId: 'ord-1' },
        ]);
      mockSupplierSyncService.syncBooking.mockRejectedValue(new Error('Upstream error'));

      // First failure
      mockCacheService.get.mockResolvedValue(null);

      const result = await reconciliationService.reconcile();

      expect(result.failed).toBe(1);
      expect(mockCacheService.set).toHaveBeenCalledWith(
        'reconciliation:failures:b-1',
        '1',
        172800
      );

      // Verify that nextDuffelSyncAt is updated (15 mins backoff)
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'b-1' },
          data: expect.objectContaining({
            nextDuffelSyncAt: expect.any(Date),
            syncLockedAt: null,
            syncLockToken: null,
          }),
        })
      );
    });

    it('should compute longer backoff for subsequent failures', async () => {
      mockPrisma.booking.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'b-1', status: 'CONFIRMED', duffelOrderId: 'ord-1' },
        ]);
      mockSupplierSyncService.syncBooking.mockRejectedValue(new Error('Upstream error'));

      // Mocking 2 previous failures
      mockCacheService.get.mockResolvedValue('2');

      await reconciliationService.reconcile();

      // Third failure -> new failures count = 3 -> backoff = 15 * 2^(3-1) = 60 minutes
      expect(mockCacheService.set).toHaveBeenCalledWith(
        'reconciliation:failures:b-1',
        '3',
        172800
      );
    });
  });

  describe('BookingCompletion & Disruption Resolution', () => {
    let bookingService: BookingService;
    let mockPrisma: {
      booking: {
        findUnique: jest.Mock;
        update: jest.Mock;
        updateMany: jest.Mock;
      };
      disruptionAuditEvent: {
        create: jest.Mock;
      };
      $transaction: jest.Mock;
    };

    beforeEach(() => {
      mockPrisma = {
        booking: {
          findUnique: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        disruptionAuditEvent: {
          create: jest.fn(),
        },
        $transaction: jest.fn((callback) => callback(mockPrisma)),
      };

      bookingService = new BookingService(
        mockPrisma as unknown as PrismaService,
        {} as unknown as StripeService,
        {} as unknown as DuffelService,
        {} as unknown as PaymentRefundService,
      );
    });

    it('should complete booking and resolve detected disruption if departure/arrival has passed', async () => {
      const departureTime = new Date(Date.now() - 3600000); // 1 hour ago
      const booking = {
        id: 'booking-passed',
        status: 'CONFIRMED',
        departureAt: departureTime,
        currentFinalArrivalAt: null,
        disruptionStatus: DisruptionStatus.DETECTED,
        activeDisruptionRevisionId: 'rev-abc',
      } as unknown as BookingWithRelations;

      mockPrisma.booking.findUnique.mockResolvedValue({
        status: 'CONFIRMED',
        disruptionStatus: DisruptionStatus.DETECTED,
        activeDisruptionRevisionId: 'rev-abc',
        departureAt: departureTime,
        currentFinalArrivalAt: null,
      });

      const result = await bookingService.checkAndCompleteBooking(booking);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: 'booking-passed', status: 'CONFIRMED' },
        data: {
          status: 'COMPLETED',
          disruptionStatus: DisruptionStatus.RESOLVED,
          disruptionResolvedReason: 'DEPARTURE_PASSED',
          disruptionResolvedAt: expect.any(Date),
          disruptionResolvedByType: DisruptionActorType.SYSTEM,
        },
      });

      expect(mockPrisma.disruptionAuditEvent.create).toHaveBeenCalledWith({
        data: {
          bookingId: 'booking-passed',
          revisionId: 'rev-abc',
          action: 'DEPARTURE_RESOLVED',
          fromStatus: DisruptionStatus.DETECTED,
          toStatus: DisruptionStatus.RESOLVED,
          actorType: 'SYSTEM',
          actorId: null,
          correlationId: expect.any(String),
          traceId: expect.any(String),
          createdAt: expect.any(Date),
        },
      });

      expect(result.status).toBe('COMPLETED');
      expect(result.disruptionStatus).toBe(DisruptionStatus.RESOLVED);
    });

    it('should not modify booking status if time has not passed', async () => {
      const departureTime = new Date(Date.now() + 3600000); // 1 hour in future
      const booking = {
        id: 'booking-future',
        status: 'CONFIRMED',
        departureAt: departureTime,
        currentFinalArrivalAt: null,
        disruptionStatus: DisruptionStatus.DETECTED,
      } as unknown as BookingWithRelations;

      const result = await bookingService.checkAndCompleteBooking(booking);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(result.status).toBe('CONFIRMED');
    });

    it('should prioritize currentFinalArrivalAt over departureAt', async () => {
      const departureTime = new Date(Date.now() - 7200000); // 2 hours ago
      const finalArrivalTime = new Date(Date.now() + 3600000); // 1 hour in future
      const booking = {
        id: 'booking-final-future',
        status: 'CONFIRMED',
        departureAt: departureTime,
        currentFinalArrivalAt: finalArrivalTime,
        disruptionStatus: DisruptionStatus.NONE,
      } as unknown as BookingWithRelations;

      const result = await bookingService.checkAndCompleteBooking(booking);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(result.status).toBe('CONFIRMED');
    });

    it('should complete booking even if disruptionStatus is NONE', async () => {
      const departureTime = new Date(Date.now() - 3600000); // 1 hour ago
      const booking = {
        id: 'booking-none-disruption',
        status: 'CONFIRMED',
        departureAt: departureTime,
        currentFinalArrivalAt: null,
        disruptionStatus: DisruptionStatus.NONE,
      } as unknown as BookingWithRelations;

      mockPrisma.booking.findUnique.mockResolvedValue({
        status: 'CONFIRMED',
        disruptionStatus: DisruptionStatus.NONE,
        activeDisruptionRevisionId: null,
        departureAt: departureTime,
        currentFinalArrivalAt: null,
      });

      const result = await bookingService.checkAndCompleteBooking(booking);

      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: 'booking-none-disruption', status: 'CONFIRMED' },
        data: {
          status: 'COMPLETED',
        },
      });
      expect(mockPrisma.disruptionAuditEvent.create).not.toHaveBeenCalled();
      expect(result.status).toBe('COMPLETED');
    });

    it('should abort completion if target time was rescheduled to the future concurrently', async () => {
      const departureTime = new Date(Date.now() - 3600000); // 1 hour ago
      const booking = {
        id: 'booking-rescheduled',
        status: 'CONFIRMED',
        departureAt: departureTime,
        currentFinalArrivalAt: null,
        disruptionStatus: DisruptionStatus.NONE,
      } as unknown as BookingWithRelations;

      mockPrisma.booking.findUnique.mockResolvedValue({
        status: 'CONFIRMED',
        disruptionStatus: DisruptionStatus.NONE,
        activeDisruptionRevisionId: null,
        currentFinalArrivalAt: new Date(Date.now() + 3600000), // Rescheduled 1 hr in future
        departureAt: departureTime,
      });

      const result = await bookingService.checkAndCompleteBooking(booking);

      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(result.status).toBe('CONFIRMED');
    });
  });
});
