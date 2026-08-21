import {
  PrismaClient,
  BookingStatus,
  RefundStatus,
  LedgerEntryType,
  Prisma,
} from '@prisma/client';
import {
  backfillCancellationRefundObligations,
  BackfillStats,
} from '../../prisma/scripts/backfill-cancellation-refund-obligations';

type MockPrisma = {
  booking: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
  refund: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    aggregate: jest.Mock;
  };
  cancellationRefundObligation: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  ledgerEntry: {
    findMany: jest.Mock;
    update: jest.Mock;
  };
  $transaction: jest.Mock;
  $disconnect: jest.Mock;
};

describe('backfillCancellationRefundObligations unit tests', () => {
  let mockPrisma: MockPrisma;
  let mockLogger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    mockPrisma = {
      booking: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      refund: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
      cancellationRefundObligation: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      ledgerEntry: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (actions: Promise<unknown>[]) => Promise.all(actions)),
      $disconnect: jest.fn(),
    };
  });

  it('creates obligation, links refund, and backfills ledger entries for a valid booking', async () => {
    const mockBooking = {
      id: 'booking-1',
      paymentId: 'payment-1',
      status: BookingStatus.CANCELLED_AND_REFUNDED,
      currency: 'GBP',
      totalAmount: new Prisma.Decimal('150.00'),
      customerRefundAmount: new Prisma.Decimal('150.00'),
      airlineRefundAmount: new Prisma.Decimal('140.00'),
      cancellationRefundObligation: null,
      payment: { id: 'payment-1', currency: 'GBP', amount: 15000 },
      cancellationRefund: {
        id: 'refund-1',
        paymentId: 'payment-1',
        amount: 15000,
        currency: 'GBP',
        cancellationRefundObligationId: null,
        airlineRefundAmount: 14000,
      },
    };

    const mockRefund = {
      id: 'refund-1',
      paymentId: 'payment-1',
      bookingId: 'booking-1',
      amount: 15000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: 'obligation-1',
      ledgerEntries: [],
    };

    const mockUnlinkedLedger = [
      {
        id: 'entry-1',
        paymentId: 'payment-1',
        transactionId: 'tx-1',
        accountId: 'PLATFORM_REVENUE',
        entryType: LedgerEntryType.DEBIT,
        amount: 15000,
        currency: 'GBP',
        refundTransactionId: null,
      },
      {
        id: 'entry-2',
        paymentId: 'payment-1',
        transactionId: 'tx-1',
        accountId: 'CUSTOMER_RECEIVABLE',
        entryType: LedgerEntryType.CREDIT,
        amount: 15000,
        currency: 'GBP',
        refundTransactionId: null,
      },
    ];

    mockPrisma.booking.findMany
      .mockResolvedValueOnce([mockBooking])
      .mockResolvedValueOnce([]);

    mockPrisma.refund.findMany
      .mockResolvedValueOnce([mockRefund])
      .mockResolvedValueOnce([]);

    mockPrisma.cancellationRefundObligation.create.mockResolvedValue({
      id: 'obligation-1',
    });

    mockPrisma.ledgerEntry.findMany
      .mockResolvedValueOnce([]) // linked check
      .mockResolvedValueOnce(mockUnlinkedLedger); // candidate search

    const stats: BackfillStats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.processedBookings).toBe(1);
    expect(stats.obligationsCreated).toBe(1);
    expect(stats.refundsLinked).toBe(1);
    expect(stats.ledgerEntriesLinked).toBe(2);
    expect(stats.quarantined).toBe(0);
    expect(stats.errors).toBe(0);

    expect(mockPrisma.cancellationRefundObligation.create).toHaveBeenCalledWith({
      data: {
        bookingId: 'booking-1',
        paymentId: 'payment-1',
        totalAmount: 15000,
        airlineRefundAmount: 14000,
        currency: 'GBP',
      },
    });

    expect(mockPrisma.refund.update).toHaveBeenCalledWith({
      where: { id: 'refund-1' },
      data: { cancellationRefundObligationId: 'obligation-1' },
    });
  });

  it('is idempotent when re-run on already backfilled data', async () => {
    const mockBooking = {
      id: 'booking-1',
      paymentId: 'payment-1',
      status: BookingStatus.CANCELLED_AND_REFUNDED,
      currency: 'GBP',
      totalAmount: new Prisma.Decimal('150.00'),
      customerRefundAmount: new Prisma.Decimal('150.00'),
      airlineRefundAmount: new Prisma.Decimal('140.00'),
      cancellationRefundObligation: {
        id: 'obligation-1',
        bookingId: 'booking-1',
        paymentId: 'payment-1',
        totalAmount: 15000,
        airlineRefundAmount: 14000,
        currency: 'GBP',
      },
      payment: { id: 'payment-1', currency: 'GBP', amount: 15000 },
      cancellationRefund: {
        id: 'refund-1',
        paymentId: 'payment-1',
        amount: 15000,
        currency: 'GBP',
        cancellationRefundObligationId: 'obligation-1',
        airlineRefundAmount: 14000,
      },
    };

    const mockRefund = {
      id: 'refund-1',
      paymentId: 'payment-1',
      bookingId: 'booking-1',
      amount: 15000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: 'obligation-1',
      ledgerEntries: [],
    };

    const mockLinkedLedger = [
      {
        id: 'entry-1',
        paymentId: 'payment-1',
        transactionId: 'tx-1',
        accountId: 'PLATFORM_REVENUE',
        entryType: LedgerEntryType.DEBIT,
        amount: 15000,
        currency: 'GBP',
        refundTransactionId: 'refund-1',
      },
      {
        id: 'entry-2',
        paymentId: 'payment-1',
        transactionId: 'tx-1',
        accountId: 'CUSTOMER_RECEIVABLE',
        entryType: LedgerEntryType.CREDIT,
        amount: 15000,
        currency: 'GBP',
        refundTransactionId: 'refund-1',
      },
    ];

    mockPrisma.booking.findMany
      .mockResolvedValueOnce([mockBooking])
      .mockResolvedValueOnce([]);

    mockPrisma.refund.findMany
      .mockResolvedValueOnce([mockRefund])
      .mockResolvedValueOnce([]);

    mockPrisma.ledgerEntry.findMany.mockResolvedValueOnce(mockLinkedLedger);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.processedBookings).toBe(1);
    expect(stats.obligationsCreated).toBe(0);
    expect(stats.obligationsUpdated).toBe(0);
    expect(stats.refundsLinked).toBe(0);
    expect(stats.ledgerEntriesLinked).toBe(0);
    expect(stats.quarantined).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('quarantines when currency mismatches between booking and payment', async () => {
    const mockBooking = {
      id: 'booking-curr-mismatch',
      paymentId: 'payment-1',
      status: BookingStatus.CANCELLED_AND_REFUNDED,
      currency: 'EUR',
      totalAmount: new Prisma.Decimal('100.00'),
      customerRefundAmount: new Prisma.Decimal('100.00'),
      airlineRefundAmount: new Prisma.Decimal('100.00'),
      cancellationRefundObligation: null,
      payment: { id: 'payment-1', currency: 'GBP', amount: 10000 },
      cancellationRefund: null,
    };

    mockPrisma.booking.findMany
      .mockResolvedValueOnce([mockBooking])
      .mockResolvedValueOnce([]);
    mockPrisma.refund.findMany.mockResolvedValueOnce([]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.obligationsCreated).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[QUARANTINE] Booking booking-curr-mismatch currency (EUR) does not match Payment currency (GBP)'),
    );
  });

  it('quarantines when paymentId is missing for cancelled booking', async () => {
    const mockBooking = {
      id: 'booking-no-payment',
      paymentId: null,
      status: BookingStatus.CANCELLED_AND_REFUNDED,
      currency: 'GBP',
      totalAmount: new Prisma.Decimal('100.00'),
      customerRefundAmount: new Prisma.Decimal('100.00'),
      airlineRefundAmount: new Prisma.Decimal('100.00'),
      cancellationRefundObligation: null,
      payment: null,
      cancellationRefund: null,
    };

    mockPrisma.booking.findMany
      .mockResolvedValueOnce([mockBooking])
      .mockResolvedValueOnce([]);
    mockPrisma.refund.findMany.mockResolvedValueOnce([]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.obligationsCreated).toBe(0);
  });

  it('quarantines when booking paymentId does not match Payment record id', async () => {
    const mockBooking = {
      id: 'booking-payment-mismatch',
      paymentId: 'payment-1',
      status: BookingStatus.CANCELLED_AND_REFUNDED,
      currency: 'GBP',
      totalAmount: new Prisma.Decimal('100.00'),
      customerRefundAmount: new Prisma.Decimal('100.00'),
      airlineRefundAmount: new Prisma.Decimal('100.00'),
      cancellationRefundObligation: null,
      payment: { id: 'payment-other', currency: 'GBP', amount: 10000 },
      cancellationRefund: null,
    };

    mockPrisma.booking.findMany
      .mockResolvedValueOnce([mockBooking])
      .mockResolvedValueOnce([]);
    mockPrisma.refund.findMany.mockResolvedValueOnce([]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.obligationsCreated).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[QUARANTINE] Booking booking-payment-mismatch paymentId (payment-1) does not match Payment record id (payment-other)'),
    );
  });

  it('quarantines when cumulative succeeded refunds exceed payment amount', async () => {
    const mockBooking = {
      id: 'booking-over-refund',
      paymentId: 'payment-1',
      status: BookingStatus.CANCELLED_AND_REFUNDED,
      currency: 'GBP',
      totalAmount: new Prisma.Decimal('100.00'),
      customerRefundAmount: new Prisma.Decimal('100.00'),
      airlineRefundAmount: new Prisma.Decimal('100.00'),
      cancellationRefundObligation: null,
      payment: { id: 'payment-1', currency: 'GBP', amount: 10000 },
      cancellationRefund: null,
    };

    mockPrisma.booking.findMany
      .mockResolvedValueOnce([mockBooking])
      .mockResolvedValueOnce([]);
    mockPrisma.refund.aggregate.mockResolvedValueOnce({
      _sum: { amount: 15000 },
    });
    mockPrisma.refund.findMany.mockResolvedValueOnce([]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.obligationsCreated).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[QUARANTINE] Payment payment-1 has cumulative succeeded refunds (15000) exceeding payment amount (10000)'),
    );
  });

  it('quarantines when SUCCEEDED refund lacks balanced ledger entries', async () => {
    const mockRefund = {
      id: 'refund-unbalanced',
      paymentId: 'payment-1',
      bookingId: null,
      amount: 10000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: null,
      ledgerEntries: [],
    };

    mockPrisma.booking.findMany.mockResolvedValueOnce([]);
    mockPrisma.refund.findMany
      .mockResolvedValueOnce([mockRefund])
      .mockResolvedValueOnce([]);

    mockPrisma.ledgerEntry.findMany
      .mockResolvedValueOnce([]) // linked
      .mockResolvedValueOnce([]); // no unlinked

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.ledgerEntriesLinked).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[QUARANTINE] SUCCEEDED refund refund-unbalanced'),
    );
  });

  it('quarantines when non-succeeded refund has linked ledger entries', async () => {
    const mockRefund = {
      id: 'refund-failed',
      paymentId: 'payment-1',
      bookingId: null,
      amount: 10000,
      currency: 'GBP',
      status: RefundStatus.FAILED,
      cancellationRefundObligationId: null,
      ledgerEntries: [],
    };

    mockPrisma.booking.findMany.mockResolvedValueOnce([]);
    mockPrisma.refund.findMany
      .mockResolvedValueOnce([mockRefund])
      .mockResolvedValueOnce([]);

    mockPrisma.ledgerEntry.findMany.mockResolvedValueOnce([
      { id: 'le-1', refundTransactionId: 'refund-failed' },
    ]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[QUARANTINE] Non-succeeded refund refund-failed (status: FAILED) has 1 linked ledger entries'),
    );
  });
});

