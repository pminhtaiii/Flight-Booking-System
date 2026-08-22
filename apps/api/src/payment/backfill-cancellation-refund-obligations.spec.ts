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
    updateMany: jest.Mock;
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
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => Promise<unknown>)(mockPrisma)
          : Promise.all(arg as Promise<unknown>[]),
      ),
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

  it('skips quote-only confirmed bookings and does not create obligations', async () => {
    const mockBooking = {
      id: 'booking-quote-only',
      paymentId: 'payment-1',
      status: BookingStatus.CONFIRMED,
      currency: 'GBP',
      totalAmount: new Prisma.Decimal('150.00'),
      customerRefundAmount: new Prisma.Decimal('150.00'),
      airlineRefundAmount: new Prisma.Decimal('140.00'),
      cancellationRefundObligation: null,
      payment: { id: 'payment-1', currency: 'GBP', amount: 15000 },
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

    expect(stats.processedBookings).toBe(1);
    expect(stats.obligationsCreated).toBe(0);
    expect(stats.obligationsUpdated).toBe(0);
    expect(stats.quarantined).toBe(0);
    expect(stats.errors).toBe(0);
    expect(mockPrisma.cancellationRefundObligation.create).not.toHaveBeenCalled();
    expect(mockPrisma.cancellationRefundObligation.update).not.toHaveBeenCalled();
  });

  it('matches two refunds on the same payment with identical amount and currency to their closest chronological ledger entry pairs without cross-linking', async () => {
    const mockRefund1 = {
      id: 'refund-early',
      paymentId: 'payment-multi-refund',
      bookingId: null,
      amount: 5000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: 'obligation-1',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      updatedAt: new Date('2026-08-01T15:00:00.000Z'), // Later administrative update / retry must not alter chronological matching
      payment: { id: 'payment-multi-refund', amount: 20000 },
      ledgerEntries: [],
    };

    const mockRefund2 = {
      id: 'refund-late',
      paymentId: 'payment-multi-refund',
      bookingId: null,
      amount: 5000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: 'obligation-1',
      createdAt: new Date('2026-08-01T12:00:00.000Z'),
      updatedAt: new Date('2026-08-01T12:00:00.000Z'),
      payment: { id: 'payment-multi-refund', amount: 20000 },
      ledgerEntries: [],
    };

    const earlyDebit = {
      id: 'entry-early-debit',
      paymentId: 'payment-multi-refund',
      transactionId: 'tx-early',
      accountId: 'PLATFORM_REVENUE',
      entryType: LedgerEntryType.DEBIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:02.000Z'),
    };
    const earlyCredit = {
      id: 'entry-early-credit',
      paymentId: 'payment-multi-refund',
      transactionId: 'tx-early',
      accountId: 'CUSTOMER_RECEIVABLE',
      entryType: LedgerEntryType.CREDIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:02.000Z'),
    };

    const lateDebit = {
      id: 'entry-late-debit',
      paymentId: 'payment-multi-refund',
      transactionId: 'tx-late',
      accountId: 'PLATFORM_REVENUE',
      entryType: LedgerEntryType.DEBIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T12:00:04.000Z'),
    };
    const lateCredit = {
      id: 'entry-late-credit',
      paymentId: 'payment-multi-refund',
      transactionId: 'tx-late',
      accountId: 'CUSTOMER_RECEIVABLE',
      entryType: LedgerEntryType.CREDIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T12:00:04.000Z'),
    };

    mockPrisma.booking.findMany.mockResolvedValueOnce([]);
    mockPrisma.refund.findMany
      .mockResolvedValueOnce([mockRefund1, mockRefund2])
      .mockResolvedValueOnce([]);

    // For refund-early:
    // 1st ledger findMany: linked check -> returns []
    // 2nd ledger findMany: candidate unlinked entries (passed with late pair first to verify distance sorting)
    // For refund-late:
    // 3rd ledger findMany: linked check -> returns []
    // 4th ledger findMany: remaining candidate entries
    mockPrisma.ledgerEntry.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lateDebit, lateCredit, earlyDebit, earlyCredit])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lateDebit, lateCredit]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.ledgerEntriesLinked).toBe(4);
    expect(stats.quarantined).toBe(0);
    expect(stats.errors).toBe(0);

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);

    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-early-debit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-early' },
    });
    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-early-credit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-early' },
    });

    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-late-debit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-late' },
    });
    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-late-credit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-late' },
    });
  });

  it('quarantines when linking a refund would cause cumulative succeeded refunds to exceed obligation totalAmount', async () => {
    const mockRefund = {
      id: 'refund-over-obligation',
      paymentId: 'payment-1',
      bookingId: 'booking-1',
      amount: 6000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: null,
      ledgerEntries: [],
    };

    const mockObligation = {
      id: 'obligation-1',
      bookingId: 'booking-1',
      paymentId: 'payment-1',
      totalAmount: 10000,
      airlineRefundAmount: 10000,
      currency: 'GBP',
    };

    mockPrisma.booking.findMany.mockResolvedValueOnce([]);
    mockPrisma.refund.findMany
      .mockResolvedValueOnce([mockRefund])
      .mockResolvedValueOnce([]);
    mockPrisma.cancellationRefundObligation.findUnique.mockResolvedValueOnce(mockObligation);
    // Payment-level aggregate sum: 11000 (payment is 20000, so within payment amount)
    mockPrisma.refund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 11000 } }) // payment check
      .mockResolvedValueOnce({ _sum: { amount: 5000 } }); // obligation check: 5000 existing + 6000 prospective = 11000 > 10000

    mockPrisma.ledgerEntry.findMany.mockResolvedValueOnce([]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.refundsLinked).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[QUARANTINE] Linking refund refund-over-obligation (amount: 6000) to obligation obligation-1 (totalAmount: 10000) would exceed obligation debt'),
    );
  });

  it('matches refunds on the same payment with identical amounts and equal timestamps deterministically in chronological order without ties', async () => {
    const equalTime = new Date('2026-08-01T10:00:00.000Z');
    const mockRefund1 = {
      id: 'refund-a',
      paymentId: 'payment-equal',
      bookingId: null,
      amount: 5000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: 'obligation-1',
      createdAt: equalTime,
      payment: { id: 'payment-equal', amount: 20000 },
      ledgerEntries: [],
    };

    const mockRefund2 = {
      id: 'refund-b',
      paymentId: 'payment-equal',
      bookingId: null,
      amount: 5000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: 'obligation-1',
      createdAt: equalTime,
      payment: { id: 'payment-equal', amount: 20000 },
      ledgerEntries: [],
    };

    const pair1Debit = {
      id: 'entry-1-debit',
      paymentId: 'payment-equal',
      transactionId: 'tx-z-later-uuid',
      accountId: 'PLATFORM_REVENUE',
      entryType: LedgerEntryType.DEBIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: equalTime,
    };
    const pair1Credit = {
      id: 'entry-1-credit',
      paymentId: 'payment-equal',
      transactionId: 'tx-z-later-uuid',
      accountId: 'CUSTOMER_RECEIVABLE',
      entryType: LedgerEntryType.CREDIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: equalTime,
    };

    const pair2Debit = {
      id: 'entry-2-debit',
      paymentId: 'payment-equal',
      transactionId: 'tx-a-earlier-uuid',
      accountId: 'PLATFORM_REVENUE',
      entryType: LedgerEntryType.DEBIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: equalTime,
    };
    const pair2Credit = {
      id: 'entry-2-credit',
      paymentId: 'payment-equal',
      transactionId: 'tx-a-earlier-uuid',
      accountId: 'CUSTOMER_RECEIVABLE',
      entryType: LedgerEntryType.CREDIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: equalTime,
    };

    mockPrisma.booking.findMany.mockResolvedValueOnce([]);
    mockPrisma.refund.findMany
      .mockResolvedValueOnce([mockRefund1, mockRefund2])
      .mockResolvedValueOnce([]);

    mockPrisma.ledgerEntry.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pair2Debit, pair2Credit, pair1Debit, pair1Credit])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pair2Debit, pair2Credit]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.ledgerEntriesLinked).toBe(4);
    expect(stats.quarantined).toBe(0);

    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-1-debit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-a' },
    });
    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-2-debit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-b' },
    });
  });

  it('handles concurrent race conditions gracefully by claiming available alternatives via CAS updateMany', async () => {
    const mockRefund = {
      id: 'refund-race',
      paymentId: 'payment-race',
      bookingId: null,
      amount: 5000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: 'obligation-1',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      payment: { id: 'payment-race', amount: 20000 },
      ledgerEntries: [],
    };

    const pair1Debit = {
      id: 'race-1-debit',
      paymentId: 'payment-race',
      transactionId: 'tx-race-1',
      accountId: 'PLATFORM_REVENUE',
      entryType: LedgerEntryType.DEBIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    };
    const pair1Credit = {
      id: 'race-1-credit',
      paymentId: 'payment-race',
      transactionId: 'tx-race-1',
      accountId: 'CUSTOMER_RECEIVABLE',
      entryType: LedgerEntryType.CREDIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    };

    const pair2Debit = {
      id: 'race-2-debit',
      paymentId: 'payment-race',
      transactionId: 'tx-race-2',
      accountId: 'PLATFORM_REVENUE',
      entryType: LedgerEntryType.DEBIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:05.000Z'),
    };
    const pair2Credit = {
      id: 'race-2-credit',
      paymentId: 'payment-race',
      transactionId: 'tx-race-2',
      accountId: 'CUSTOMER_RECEIVABLE',
      entryType: LedgerEntryType.CREDIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:05.000Z'),
    };

    mockPrisma.booking.findMany.mockResolvedValueOnce([]);
    mockPrisma.refund.findMany
      .mockResolvedValueOnce([mockRefund])
      .mockResolvedValueOnce([]);

    mockPrisma.ledgerEntry.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pair1Debit, pair1Credit, pair2Debit, pair2Credit]);

    // First attempt on pair 1 fails CAS (count: 0 - already claimed by concurrent process)
    // Second attempt on pair 2 succeeds CAS (count: 1)
    mockPrisma.ledgerEntry.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.ledgerEntriesLinked).toBe(2);
    expect(stats.quarantined).toBe(0);

    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'race-1-debit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-race' },
    });
    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'race-2-debit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-race' },
    });
  });
});


