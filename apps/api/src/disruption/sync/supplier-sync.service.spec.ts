process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '@/app.module';

jest.setTimeout(30000);
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelService } from '@/duffel/duffel.service';
import { SyncClaimService } from './sync-claim.service';
import { SupplierSyncService } from './supplier-sync.service';
import { DisruptionStatus, Prisma } from '@prisma/client';
import * as crypto from 'crypto';

describe('SupplierSyncService unit/integration tests', () => {
  let prisma: PrismaService;
  let syncClaimService: SyncClaimService;
  let supplierSyncService: SupplierSyncService;
  let mockDuffelService: { retrieveCompleteOrder: jest.Mock };

  let userId: string;
  let bookingIntentId: string;
  let bookingId: string;
  let suffix: string;

  beforeAll(async () => {
    mockDuffelService = {
      retrieveCompleteOrder: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DuffelService)
      .useValue(mockDuffelService)
      .compile();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    syncClaimService = moduleFixture.get<SyncClaimService>(SyncClaimService);
    supplierSyncService = moduleFixture.get<SupplierSyncService>(SupplierSyncService);
  });

  beforeEach(async () => {
    suffix = crypto.randomUUID();
    jest.clearAllMocks();

    const user = await prisma.user.create({
      data: {
        email: `test-sync-user-${suffix}@example.com`,
        password: 'Password123!',
        role: 'USER',
        status: 'ACTIVE',
      },
    });
    userId = user.id;

    const intent = await prisma.bookingIntent.create({
      data: {
        userId,
        duffelOfferId: `off_fake_${suffix}`,
        originalPrice: new Prisma.Decimal('100.00'),
        confirmedPrice: new Prisma.Decimal('100.00'),
        currency: 'USD',
        pricedAt: new Date(),
        origin: 'HAN',
        destination: 'NRT',
        departureDate: new Date(),
        adults: 1,
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(Date.now() + 3600000),
      },
    });
    bookingIntentId = intent.id;

    const booking = await prisma.booking.create({
      data: {
        userId,
        bookingIntentId,
        totalAmount: new Prisma.Decimal('100.00'),
        currency: 'USD',
        status: 'CONFIRMED',
        duffelOrderId: `ord_fake_${suffix}`,
        flightSnapshot: {
          stops: 0,
          cabinClass: 'economy',
          totalDuration: 'PT2H',
          segments: [
            {
              airline: { name: 'Japan Airlines', iataCode: 'JL' },
              flightNumber: '752',
              departureAirport: { name: 'Noi Bai', iataCode: 'HAN', city: 'Hanoi', terminal: 'T2' },
              arrivalAirport: { name: 'Narita', iataCode: 'NRT', city: 'Tokyo', terminal: 'T2' },
              departureAt: '2026-08-01T12:00:00Z',
              arrivalAt: '2026-08-01T19:00:00Z',
              duration: 'PT7H',
              aircraftType: 'Boeing 787',
              duffelSegmentId: `seg_orig_${suffix}`,
              sliceOrder: 0,
              segmentOrder: 0,
              globalOrder: 0,
            },
          ],
        },
      },
    });
    bookingId = booking.id;
  });

  afterEach(async () => {
    await prisma.notificationOutbox.deleteMany({ where: { bookingId } });
    await prisma.disruptionAuditEvent.deleteMany({ where: { bookingId } });
    await prisma.itineraryRevisionSegment.deleteMany({ where: { revision: { bookingId } } });
    await prisma.itineraryRevision.deleteMany({ where: { bookingId } });
    await prisma.booking.deleteMany({ where: { id: bookingId } });
    await prisma.bookingIntent.deleteMany({ where: { id: bookingIntentId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  describe('SyncClaimService Concurrency Locks', () => {
    it('should acquire a claim, block concurrent acquisitions, and release conditionally', async () => {
      const token1 = await syncClaimService.acquireClaim(bookingId);
      expect(token1).toBeDefined();
      expect(typeof token1).toBe('string');

      // Second acquisition attempt should fail/return null
      const token2 = await syncClaimService.acquireClaim(bookingId);
      expect(token2).toBeNull();

      // Release with wrong token should fail
      const releasedWrong = await syncClaimService.releaseClaim(bookingId, 'wrong-token');
      expect(releasedWrong).toBe(false);

      // Release with correct token should succeed
      const releasedCorrect = await syncClaimService.releaseClaim(bookingId, token1!);
      expect(releasedCorrect).toBe(true);

      // Acquisition should succeed again
      const token3 = await syncClaimService.acquireClaim(bookingId);
      expect(token3).toBeDefined();
      expect(token3).not.toBeNull();
      await syncClaimService.releaseClaim(bookingId, token3!);
    });

    it('should allow acquisition if the lock is stale (older than 5 minutes)', async () => {
      const staleTime = new Date(Date.now() - 6 * 60 * 1000); // 6 mins ago
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          syncLockedAt: staleTime,
          syncLockToken: 'stale-token',
        },
      });

      const token = await syncClaimService.acquireClaim(bookingId);
      expect(token).toBeDefined();
      expect(token).not.toBeNull();
      expect(token).not.toBe('stale-token');
      await syncClaimService.releaseClaim(bookingId, token!);
    });
  });

  describe('SupplierSyncService Core Synchronization', () => {
    it('should return NO_CHANGE and update lastDuffelSyncedAt if itinerary is unchanged', async () => {
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        cancelled_at: null,
        slices: [
          {
            id: 'sli_1',
            duration: 'PT7H',
            origin: { name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
            destination: { name: 'Narita', iata_code: 'NRT', type: 'airport' },
            segments: [
              {
                id: `seg_orig_${suffix}`,
                duration: 'PT7H',
                departing_at: '2026-08-01T12:00:00Z',
                arriving_at: '2026-08-01T19:00:00Z',
                origin: { name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                destination: { name: 'Narita', iata_code: 'NRT', type: 'airport' },
                origin_terminal: 'T2',
                destination_terminal: 'T2',
                operating_carrier: { name: 'Japan Airlines', iata_code: 'JL' },
                marketing_carrier: { name: 'Japan Airlines', iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
                aircraft: { name: 'Boeing 787' },
              },
            ],
          },
        ],
        passengers: [],
      });

      const result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('NO_CHANGE');

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.lastDuffelSyncedAt).toBeDefined();
      expect(dbBooking?.syncLockedAt).toBeNull();
      expect(dbBooking?.syncLockToken).toBeNull();
    });

    it('should create a non-material revision for minor changes (<120m later)', async () => {
      // Move departure by 30 mins later
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        cancelled_at: null,
        slices: [
          {
            id: 'sli_1',
            duration: 'PT7H',
            origin: { name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
            destination: { name: 'Narita', iata_code: 'NRT', type: 'airport' },
            segments: [
              {
                id: `seg_orig_${suffix}`,
                duration: 'PT7H',
                departing_at: '2026-08-01T12:30:00Z', // +30 mins (same day)
                arriving_at: '2026-08-01T19:30:00Z',
                origin: { name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                destination: { name: 'Narita', iata_code: 'NRT', type: 'airport' },
                origin_terminal: 'T2',
                destination_terminal: 'T2',
                operating_carrier: { name: 'Japan Airlines', iata_code: 'JL' },
                marketing_carrier: { name: 'Japan Airlines', iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
                aircraft: { name: 'Boeing 787' },
              },
            ],
          },
        ],
        passengers: [],
      });

      const result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('REVISION_CREATED');

      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { itineraryRevisions: true, notificationOutbox: true },
      });

      expect(dbBooking?.disruptionStatus).toBe(DisruptionStatus.NONE);
      expect(dbBooking?.itineraryRevisions.length).toBe(1);
      expect(dbBooking?.itineraryRevisions[0].isMaterial).toBe(false);
      expect(dbBooking?.notificationOutbox.length).toBe(0);
    });

    it('should create a material revision and transition disruption status for material changes (>120m later)', async () => {
      // Move departure by 150 mins later
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        cancelled_at: null,
        slices: [
          {
            id: 'sli_1',
            duration: 'PT7H',
            origin: { name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
            destination: { name: 'Narita', iata_code: 'NRT', type: 'airport' },
            segments: [
              {
                id: `seg_orig_${suffix}`,
                duration: 'PT7H',
                departing_at: '2026-08-01T14:30:00Z', // +150 mins
                arriving_at: '2026-08-01T21:30:00Z',
                origin: { name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                destination: { name: 'Narita', iata_code: 'NRT', type: 'airport' },
                origin_terminal: 'T2',
                destination_terminal: 'T2',
                operating_carrier: { name: 'Japan Airlines', iata_code: 'JL' },
                marketing_carrier: { name: 'Japan Airlines', iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
                aircraft: { name: 'Boeing 787' },
              },
            ],
          },
        ],
        passengers: [],
      });

      const result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('REVISION_CREATED');

      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { itineraryRevisions: true, notificationOutbox: true },
      });

      expect(dbBooking?.disruptionStatus).toBe(DisruptionStatus.DETECTED);
      expect(dbBooking?.activeDisruptionRevisionId).toBe(dbBooking?.itineraryRevisions[0].id);
      expect(dbBooking?.itineraryRevisions.length).toBe(1);
      expect(dbBooking?.itineraryRevisions[0].isMaterial).toBe(true);
      expect(dbBooking?.itineraryRevisions[0].materialReasons).toContain('DEPARTURE_MOVED_LATER');
      expect(dbBooking?.notificationOutbox.length).toBe(1);
      expect(dbBooking?.notificationOutbox[0].stabilizationWarning).toBe(false);
    });

    it('should detect material changes cumulatively from multiple minor shifts', async () => {
      // 1. Shift 1: +40 mins (minor)
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        cancelled_at: null,
        slices: [
          {
            id: 'sli_1',
            duration: 'PT7H',
            origin: { name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
            destination: { name: 'Narita', iata_code: 'NRT', type: 'airport' },
            segments: [
              {
                id: `seg_orig_${suffix}`,
                duration: 'PT7H',
                departing_at: '2026-08-01T12:40:00Z', // +40 mins
                arriving_at: '2026-08-01T19:40:00Z',
                origin: { name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                destination: { name: 'Narita', iata_code: 'NRT', type: 'airport' },
                origin_terminal: 'T2',
                destination_terminal: 'T2',
                operating_carrier: { name: 'Japan Airlines', iata_code: 'JL' },
                marketing_carrier: { name: 'Japan Airlines', iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
                aircraft: { name: 'Boeing 787' },
              },
            ],
          },
        ],
        passengers: [],
      });

      await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');

      // 2. Shift 2: Move earlier by 40 mins relative to Shift 1 (meaning 80 mins earlier than original!)
      // Original: 2026-08-01T12:00:00Z
      // Shift 1: 2026-08-01T12:40:00Z
      // Shift 2: 2026-08-01T10:40:00Z (-80 mins cumulative)
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        cancelled_at: null,
        slices: [
          {
            id: 'sli_1',
            duration: 'PT7H',
            origin: { name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
            destination: { name: 'Narita', iata_code: 'NRT', type: 'airport' },
            segments: [
              {
                id: `seg_orig_${suffix}`,
                duration: 'PT7H',
                departing_at: '2026-08-01T10:40:00Z',
                arriving_at: '2026-08-01T17:40:00Z',
                origin: { name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                destination: { name: 'Narita', iata_code: 'NRT', type: 'airport' },
                origin_terminal: 'T2',
                destination_terminal: 'T2',
                operating_carrier: { name: 'Japan Airlines', iata_code: 'JL' },
                marketing_carrier: { name: 'Japan Airlines', iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
                aircraft: { name: 'Boeing 787' },
              },
            ],
          },
        ],
        passengers: [],
      });

      const result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('REVISION_CREATED');

      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { itineraryRevisions: { orderBy: { version: 'desc' } } },
      });

      expect(dbBooking?.disruptionStatus).toBe(DisruptionStatus.DETECTED);
      expect(dbBooking?.itineraryRevisions[0].isMaterial).toBe(true);
      expect(dbBooking?.itineraryRevisions[0].materialReasons).toContain('DEPARTURE_MOVED_EARLIER');
      expect(dbBooking?.itineraryRevisions[0].materialBaselines).toContain('CUMULATIVE');
    });

    it('should rollback transaction atomically on write failures', async () => {
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        slices: [
          {
            id: 'sli_1',
            segments: [
              {
                id: `seg_orig_${suffix}`,
                departing_at: '2026-08-01T14:30:00Z', // material change
                arriving_at: '2026-08-01T21:30:00Z',
                origin: { iata_code: 'HAN' },
                destination: { iata_code: 'NRT' },
                operating_carrier: { iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
              },
            ],
          },
        ],
        passengers: [],
      });

      const originalTransaction = prisma.$transaction;
      prisma.$transaction = jest.fn().mockRejectedValue(new Error('Atomic database rollback test error'));

      await expect(
        supplierSyncService.syncBooking(bookingId, 'WEBHOOK'),
      ).rejects.toThrow('Atomic database rollback test error');

      prisma.$transaction = originalTransaction;

      // Ensure no revision or outbox is created and lock is conditionally released
      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { itineraryRevisions: true, notificationOutbox: true },
      });
      expect(dbBooking?.itineraryRevisions.length).toBe(0);
      expect(dbBooking?.notificationOutbox.length).toBe(0);
      expect(dbBooking?.syncLockedAt).toBeNull();
    });
  });

  describe('SupplierSyncService Concurrency & Version Collision', () => {
    it('should converge if version unique violation is thrown but fingerprints match', async () => {
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        slices: [
          {
            id: 'sli_1',
            segments: [
              {
                id: `seg_orig_${suffix}`,
                departing_at: '2026-08-01T14:30:00Z', // material change
                arriving_at: '2026-08-01T21:30:00Z',
                origin: { iata_code: 'HAN' },
                destination: { iata_code: 'NRT' },
                operating_carrier: { iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
              },
            ],
          },
        ],
        passengers: [],
      });

      const originalTransaction = prisma.$transaction;
      const originalCreate = prisma.itineraryRevision.create;

      let count = 0;
      interface PrismaError extends Error {
        code?: string;
        meta?: Record<string, unknown>;
      }

      const transactionSpy = jest.spyOn(prisma, '$transaction').mockImplementation(async (callback) => {
        return originalTransaction.call(prisma, async (tx) => {
          const originalTxCreate = tx.itineraryRevision.create;
          tx.itineraryRevision.create = jest.fn().mockImplementation(async (args) => {
            if (count === 0) {
              count++;
              // Simulate that in parallel, another thread inserted version 1 with the SAME fingerprint
              await originalCreate.call(prisma.itineraryRevision, {
                data: {
                  bookingId: args.data.bookingId,
                  version: args.data.version,
                  source: args.data.source,
                  fingerprint: args.data.fingerprint,
                  isMaterial: args.data.isMaterial,
                  materialReasons: args.data.materialReasons,
                  materialBaselines: args.data.materialBaselines,
                  incrementalDiff: args.data.incrementalDiff,
                  cumulativeDiff: args.data.cumulativeDiff,
                },
              });
              // Throw unique constraint violation error
              const error = new Error('Unique constraint failed on version') as PrismaError;
              error.code = 'P2002';
              error.meta = { target: ['bookingId', 'version'] };
              throw error;
            }
            return originalTxCreate.call(tx.itineraryRevision, args);
          });
          return callback(tx);
        });
      });

      const result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('CONVERGED_DUPLICATE');

      transactionSpy.mockRestore();
    });

    it('should retry transaction with version incremented if version unique violation is thrown and fingerprints differ', async () => {
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        slices: [
          {
            id: 'sli_1',
            segments: [
              {
                id: `seg_orig_${suffix}`,
                departing_at: '2026-08-01T14:30:00Z', // material change
                arriving_at: '2026-08-01T21:30:00Z',
                origin: { iata_code: 'HAN' },
                destination: { iata_code: 'NRT' },
                operating_carrier: { iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
              },
            ],
          },
        ],
        passengers: [],
      });

      const originalTransaction = prisma.$transaction;
      const originalCreate = prisma.itineraryRevision.create;

      let count = 0;
      interface PrismaError extends Error {
        code?: string;
        meta?: Record<string, unknown>;
      }

      const transactionSpy = jest.spyOn(prisma, '$transaction').mockImplementation(async (callback) => {
        return originalTransaction.call(prisma, async (tx) => {
          const originalTxCreate = tx.itineraryRevision.create;
          tx.itineraryRevision.create = jest.fn().mockImplementation(async (args) => {
            if (count === 0) {
              count++;
              // Simulate that in parallel, another thread inserted version 1 with a DIFFERENT fingerprint
              await originalCreate.call(prisma.itineraryRevision, {
                data: {
                  bookingId: args.data.bookingId,
                  version: args.data.version,
                  source: args.data.source,
                  fingerprint: 'different-fingerprint',
                  isMaterial: args.data.isMaterial,
                  materialReasons: args.data.materialReasons,
                  materialBaselines: args.data.materialBaselines,
                  incrementalDiff: args.data.incrementalDiff,
                  cumulativeDiff: args.data.cumulativeDiff,
                },
              });
              // Throw unique constraint violation error
              const error = new Error('Unique constraint failed on version') as PrismaError;
              error.code = 'P2002';
              error.meta = { target: ['bookingId', 'version'] };
              throw error;
            }
            return originalTxCreate.call(tx.itineraryRevision, args);
          });
          return callback(tx);
        });
      });

      const result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('REVISION_CREATED');

      const revisions = await prisma.itineraryRevision.findMany({
        where: { bookingId },
        orderBy: { version: 'asc' },
      });

      // We should have version 1 (different-fingerprint) and version 2 (our actual change)
      expect(revisions.length).toBe(2);
      expect(revisions[0].version).toBe(1);
      expect(revisions[0].fingerprint).toBe('different-fingerprint');
      expect(revisions[1].version).toBe(2);

      transactionSpy.mockRestore();
    });
  });

  describe('SupplierSyncService Cancellation Races & States', () => {
    it('should abort sync transaction cleanly if booking is concurrently cancelled', async () => {
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        slices: [
          {
            id: 'sli_1',
            segments: [
              {
                id: `seg_orig_${suffix}`,
                departing_at: '2026-08-01T14:30:00Z',
                arriving_at: '2026-08-01T21:30:00Z',
                origin: { iata_code: 'HAN' },
                destination: { iata_code: 'NRT' },
                operating_carrier: { iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
              },
            ],
          },
        ],
        passengers: [],
      });

      // Intercept the execution and cancel the booking before database writes
      const originalRetrieve = mockDuffelService.retrieveCompleteOrder;
      mockDuffelService.retrieveCompleteOrder = jest.fn().mockImplementation(async (orderId) => {
        // Change booking status to CANCELLED_PENDING_REFUND
        await prisma.booking.update({
          where: { id: bookingId },
          data: { status: 'CANCELLED_PENDING_REFUND' },
        });
        return originalRetrieve(orderId);
      });

      const result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('SKIPPED_INELIGIBLE');

      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { itineraryRevisions: true, notificationOutbox: true },
      });
      expect(dbBooking?.itineraryRevisions.length).toBe(0);
      expect(dbBooking?.notificationOutbox.length).toBe(0);
      expect(dbBooking?.disruptionStatus).toBe(DisruptionStatus.NONE);

      mockDuffelService.retrieveCompleteOrder = originalRetrieve;
    });
  });

  describe('SupplierSyncService Notification Outbox Throttling', () => {
    it('should handle daily outbox throttling levels (1st/2nd/3rd with warning/4th suppressed)', async () => {
      const mockDuffelWithDeparture = (depTime: string) => {
        mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
          id: `ord_fake_${suffix}`,
          slices: [
            {
              id: 'sli_1',
              segments: [
                {
                  id: `seg_orig_${suffix}`,
                  departing_at: depTime,
                  arriving_at: '2026-08-01T23:00:00Z',
                  origin: { iata_code: 'HAN' },
                  destination: { iata_code: 'NRT' },
                  operating_carrier: { iata_code: 'JL' },
                  marketing_carrier_flight_number: '752',
                },
              ],
            },
          ],
          passengers: [],
        });
      };

      // 1st material disruption
      mockDuffelWithDeparture('2026-08-01T14:30:00Z'); // Shifted by >120m
      let result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('REVISION_CREATED');
      let outbox = await prisma.notificationOutbox.findMany({ where: { bookingId } });
      expect(outbox.length).toBe(1);
      expect(outbox[0].stabilizationWarning).toBe(false);

      // Acknowledge disruption so we can trigger a new one
      await prisma.booking.update({
        where: { id: bookingId },
        data: { disruptionStatus: 'ACKNOWLEDGED' },
      });

      // 2nd material disruption
      mockDuffelWithDeparture('2026-08-01T17:00:00Z');
      result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('REVISION_CREATED');
      outbox = await prisma.notificationOutbox.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
      expect(outbox.length).toBe(2);
      expect(outbox[1].stabilizationWarning).toBe(false);

      await prisma.booking.update({
        where: { id: bookingId },
        data: { disruptionStatus: 'ACKNOWLEDGED' },
      });

      // 3rd material disruption
      mockDuffelWithDeparture('2026-08-01T19:30:00Z');
      result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('REVISION_CREATED');
      outbox = await prisma.notificationOutbox.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
      expect(outbox.length).toBe(3);
      expect(outbox[2].stabilizationWarning).toBe(true); // Warning enabled

      await prisma.booking.update({
        where: { id: bookingId },
        data: { disruptionStatus: 'ACKNOWLEDGED' },
      });

      // 4th material disruption (should be throttled)
      mockDuffelWithDeparture('2026-08-01T21:50:00Z');
      result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('REVISION_CREATED');
      outbox = await prisma.notificationOutbox.findMany({ where: { bookingId } });
      expect(outbox.length).toBe(3); // Staged at 3 rows (4th suppressed)

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.disruptionNeedsAttention).toBe(true);
      expect(dbBooking?.disruptionAttentionReason).toBe('NOTIFICATION_THROTTLED');
      expect(dbBooking?.disruptionAttentionAt).toBeDefined();
    });
  });

  describe('SupplierSyncService Legacy Snapshot Support', () => {
    it('should correctly pair segments from legacy snapshots lacking duffelSegmentId', async () => {
      // Update original booking flightSnapshot to remove duffelSegmentId (to simulate legacy data)
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          flightSnapshot: {
            stops: 0,
            cabinClass: 'economy',
            totalDuration: 'PT2H',
            segments: [
              {
                airline: { name: 'Japan Airlines', iataCode: 'JL' },
                flightNumber: '752',
                departureAirport: { name: 'Noi Bai', iataCode: 'HAN', city: 'Hanoi', terminal: 'T2' },
                departureAt: '2026-08-01T12:00:00Z',
                arrivalAirport: { name: 'Narita', iataCode: 'NRT', city: 'Tokyo', terminal: 'T2' },
                arrivalAt: '2026-08-01T19:00:00Z',
                duration: 'PT7H',
                aircraftType: 'Boeing 787',
                // duffelSegmentId is absent
                sliceOrder: 0,
                segmentOrder: 0,
                globalOrder: 0,
              },
            ],
          },
        },
      });

      // Shift departure by 30 mins (minor change)
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        slices: [
          {
            id: 'sli_1',
            segments: [
              {
                id: `seg_new_${suffix}`, // Has duffelSegmentId
                departing_at: '2026-08-01T12:30:00Z', // +30m
                arriving_at: '2026-08-01T19:30:00Z',
                origin: { iata_code: 'HAN' },
                destination: { iata_code: 'NRT' },
                operating_carrier: { iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
              },
            ],
          },
        ],
        passengers: [],
      });

      const result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('REVISION_CREATED');

      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { itineraryRevisions: true },
      });

      const revision = dbBooking?.itineraryRevisions[0];
      expect(revision?.isMaterial).toBe(false); // correctly paired as minor change, rather than deleted/added mismatch which would be material
    });
  });

  describe('SupplierSyncService Cancellation Masking Prevention', () => {
    it('should create a cancellation revision even if segments fingerprint matches previous material revision', async () => {
      // 1. First sync: material schedule change (shifted by 180 mins)
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        slices: [
          {
            id: 'sli_1',
            segments: [
              {
                id: `seg_orig_${suffix}`,
                departing_at: '2026-08-01T15:00:00Z', // +180m
                arriving_at: '2026-08-01T22:00:00Z',
                origin: { iata_code: 'HAN' },
                destination: { iata_code: 'NRT' },
                operating_carrier: { iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
              },
            ],
          },
        ],
        passengers: [],
      });

      let result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('REVISION_CREATED');

      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { itineraryRevisions: true },
      });
      expect(dbBooking?.itineraryRevisions.length).toBe(1);
      expect(dbBooking?.itineraryRevisions[0].isMaterial).toBe(true);

      // Acknowledge the disruption so we are eligible for further processing
      await prisma.booking.update({
        where: { id: bookingId },
        data: { disruptionStatus: 'ACKNOWLEDGED' },
      });

      // 2. Second sync: order is cancelled but retains same segment times (masking scenario)
      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        cancelled_at: '2026-08-01T16:00:00Z', // Cancelled!
        slices: [
          {
            id: 'sli_1',
            segments: [
              {
                id: `seg_orig_${suffix}`,
                departing_at: '2026-08-01T15:00:00Z', // Same fingerprint!
                arriving_at: '2026-08-01T22:00:00Z',
                origin: { iata_code: 'HAN' },
                destination: { iata_code: 'NRT' },
                operating_carrier: { iata_code: 'JL' },
                marketing_carrier_flight_number: '752',
              },
            ],
          },
        ],
        passengers: [],
      });

      result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(result.status).toBe('REVISION_CREATED'); // Should NOT converge as duplicate!

      const dbBookingAfter = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { itineraryRevisions: { orderBy: { version: 'desc' } }, notificationOutbox: true },
      });
      expect(dbBookingAfter?.itineraryRevisions.length).toBe(2);
      expect(dbBookingAfter?.itineraryRevisions[0].sourceEventId).toBe('supplier-cancellation');
      expect(dbBookingAfter?.disruptionStatus).toBe(DisruptionStatus.DETECTED);
      expect(dbBookingAfter?.notificationOutbox.length).toBe(2); // One from schedule change, one from cancellation
    });
  });
});
