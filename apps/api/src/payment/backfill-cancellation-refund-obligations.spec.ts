import { PrismaClient, BookingStatus, RefundStatus, LedgerEntryType, Prisma } from '@prisma/client';
import {
  backfillCancellationRefundObligations,
  BackfillLogger,
  BackfillStats,
  LegacyRefundBookingIdColumnMissingError,
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
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
  $disconnect: jest.Mock;
};

describe('backfillCancellationRefundObligations unit tests', () => {
  let mockPrisma: MockPrisma;
  let mockLogger: jest.Mocked<BackfillLogger>;

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
      $queryRaw: jest.fn((query: unknown) => {
        const sqlQuery = query as { strings?: readonly string[] };
        const isSchemaGuard = sqlQuery.strings?.join('').includes('information_schema.columns');

        return Promise.resolve(isSchemaGuard ? [{ hasBookingId: true }] : []);
      }),
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
    };

    const mockRefund = {
      id: 'refund-1',
      paymentId: 'payment-1',
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

    mockPrisma.booking.findMany.mockResolvedValueOnce([mockBooking]).mockResolvedValueOnce([]);

    mockPrisma.refund.findMany.mockResolvedValueOnce([mockRefund]).mockResolvedValueOnce([]);

    mockPrisma.cancellationRefundObligation.create.mockResolvedValue({
      id: 'obligation-1',
    });

    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ hasBookingId: true }])
      .mockResolvedValueOnce([
        {
          id: 'refund-1',
          bookingId: 'booking-1',
          paymentId: 'payment-1',
          currency: 'GBP',
          cancellationRefundObligationId: null,
        },
      ])
      .mockResolvedValueOnce([{ bookingId: 'booking-1' }]);

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

  it('fails fast before row processing when the pre-contract bookingId column is absent', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ hasBookingId: false }]);

    const result = backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    await expect(result).rejects.toBeInstanceOf(LegacyRefundBookingIdColumnMissingError);
    await expect(result).rejects.toThrow('requires the pre-contract refunds.bookingId column');

    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.refund.findMany).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
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

    mockPrisma.booking.findMany.mockResolvedValueOnce([mockBooking]).mockResolvedValueOnce([]);

    mockPrisma.refund.findMany.mockResolvedValueOnce([mockRefund]).mockResolvedValueOnce([]);

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

    mockPrisma.booking.findMany.mockResolvedValueOnce([mockBooking]).mockResolvedValueOnce([]);
    mockPrisma.refund.findMany.mockResolvedValueOnce([]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.mismatches).toBe(1);
    expect(stats.obligationsCreated).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith({
      message: 'refund_obligation_backfill',
      outcome: 'QUARANTINED',
      reason: 'BOOKING_PAYMENT_CURRENCY_MISMATCH',
    });
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

    mockPrisma.booking.findMany.mockResolvedValueOnce([mockBooking]).mockResolvedValueOnce([]);
    mockPrisma.refund.findMany.mockResolvedValueOnce([]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.mismatches).toBe(1);
    expect(stats.obligationsCreated).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith({
      message: 'refund_obligation_backfill',
      outcome: 'QUARANTINED',
      reason: 'MISSING_PAYMENT',
    });
    expect(mockLogger.log).toHaveBeenLastCalledWith({
      message: 'refund_obligation_backfill',
      outcome: 'COMPLETED',
      processedBookings: 1,
      obligationsCreated: 0,
      obligationsUpdated: 0,
      refundsLinked: 0,
      ledgerEntriesLinked: 0,
      quarantined: 1,
      mismatches: 1,
      errors: 0,
    });
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

    mockPrisma.booking.findMany.mockResolvedValueOnce([mockBooking]).mockResolvedValueOnce([]);
    mockPrisma.refund.findMany.mockResolvedValueOnce([]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.mismatches).toBe(1);
    expect(stats.obligationsCreated).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith({
      message: 'refund_obligation_backfill',
      outcome: 'QUARANTINED',
      reason: 'BOOKING_PAYMENT_MISMATCH',
    });
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

    mockPrisma.booking.findMany.mockResolvedValueOnce([mockBooking]).mockResolvedValueOnce([]);
    mockPrisma.refund.aggregate.mockResolvedValueOnce({
      _sum: { amount: 15000 },
    });
    mockPrisma.refund.findMany.mockResolvedValueOnce([]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.mismatches).toBe(1);
    expect(stats.obligationsCreated).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith({
      message: 'refund_obligation_backfill',
      outcome: 'QUARANTINED',
      reason: 'PAYMENT_OVER_REFUND',
    });
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
    mockPrisma.refund.findMany.mockResolvedValueOnce([mockRefund]).mockResolvedValueOnce([]);

    mockPrisma.ledgerEntry.findMany
      .mockResolvedValueOnce([]) // linked
      .mockResolvedValueOnce([]); // no unlinked

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.mismatches).toBe(1);
    expect(stats.ledgerEntriesLinked).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith({
      message: 'refund_obligation_backfill',
      outcome: 'QUARANTINED',
      reason: 'MISSING_LEDGER_PAIR',
    });
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
    mockPrisma.refund.findMany.mockResolvedValueOnce([mockRefund]).mockResolvedValueOnce([]);

    mockPrisma.ledgerEntry.findMany.mockResolvedValueOnce([
      { id: 'le-1', refundTransactionId: 'refund-failed' },
    ]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.quarantined).toBe(1);
    expect(stats.mismatches).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalledWith({
      message: 'refund_obligation_backfill',
      outcome: 'QUARANTINED',
      reason: 'NON_TERMINAL_REFUND_LEDGER_LINK',
    });
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

    mockPrisma.booking.findMany.mockResolvedValueOnce([mockBooking]).mockResolvedValueOnce([]);
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

  it('quarantines refunds when multiple ambiguous candidate ledger entry pairs exist for the same payment', async () => {
    const mockRefund1 = {
      id: 'refund-early',
      paymentId: 'payment-multi-refund',
      bookingId: null,
      amount: 5000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: 'obligation-1',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      updatedAt: new Date('2026-08-01T10:00:00.000Z'),
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

    const pair1Debit = {
      id: 'entry-1-debit',
      paymentId: 'payment-multi-refund',
      transactionId: 'tx-1',
      accountId: 'PLATFORM_REVENUE',
      entryType: LedgerEntryType.DEBIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:02.000Z'),
    };
    const pair1Credit = {
      id: 'entry-1-credit',
      paymentId: 'payment-multi-refund',
      transactionId: 'tx-1',
      accountId: 'CUSTOMER_RECEIVABLE',
      entryType: LedgerEntryType.CREDIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:02.000Z'),
    };

    const pair2Debit = {
      id: 'entry-2-debit',
      paymentId: 'payment-multi-refund',
      transactionId: 'tx-2',
      accountId: 'PLATFORM_REVENUE',
      entryType: LedgerEntryType.DEBIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T12:00:04.000Z'),
    };
    const pair2Credit = {
      id: 'entry-2-credit',
      paymentId: 'payment-multi-refund',
      transactionId: 'tx-2',
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
    // 2nd ledger findMany: candidate unlinked entries -> returns both pairs (ambiguous: 2 pairs matching 5000 GBP)
    // For refund-late:
    // 3rd ledger findMany: linked check -> returns []
    // 4th ledger findMany: candidate unlinked entries -> returns both pairs (ambiguous: 2 pairs matching 5000 GBP)
    mockPrisma.ledgerEntry.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pair1Debit, pair1Credit, pair2Debit, pair2Credit])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pair1Debit, pair1Credit, pair2Debit, pair2Credit]);

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.ledgerEntriesLinked).toBe(0);
    expect(stats.quarantined).toBe(2);
    expect(stats.mismatches).toBe(2);
    expect(stats.errors).toBe(0);

    expect(mockPrisma.ledgerEntry.updateMany).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith({
      message: 'refund_obligation_backfill',
      outcome: 'QUARANTINED',
      reason: 'AMBIGUOUS_LEDGER_PAIR',
    });
  });

  it('matches multiple refunds on the same payment when distinct amounts make pairing unambiguous', async () => {
    const mockRefund1 = {
      id: 'refund-50',
      paymentId: 'payment-multi-distinct',
      bookingId: null,
      amount: 5000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: 'obligation-1',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      payment: { id: 'payment-multi-distinct', amount: 20000 },
      ledgerEntries: [],
    };

    const mockRefund2 = {
      id: 'refund-30',
      paymentId: 'payment-multi-distinct',
      bookingId: null,
      amount: 3000,
      currency: 'GBP',
      status: RefundStatus.SUCCEEDED,
      cancellationRefundObligationId: 'obligation-1',
      createdAt: new Date('2026-08-01T12:00:00.000Z'),
      payment: { id: 'payment-multi-distinct', amount: 20000 },
      ledgerEntries: [],
    };

    const debit50 = {
      id: 'entry-50-debit',
      paymentId: 'payment-multi-distinct',
      transactionId: 'tx-50',
      accountId: 'PLATFORM_REVENUE',
      entryType: LedgerEntryType.DEBIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:02.000Z'),
    };
    const credit50 = {
      id: 'entry-50-credit',
      paymentId: 'payment-multi-distinct',
      transactionId: 'tx-50',
      accountId: 'CUSTOMER_RECEIVABLE',
      entryType: LedgerEntryType.CREDIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:02.000Z'),
    };

    const debit30 = {
      id: 'entry-30-debit',
      paymentId: 'payment-multi-distinct',
      transactionId: 'tx-30',
      accountId: 'PLATFORM_REVENUE',
      entryType: LedgerEntryType.DEBIT,
      amount: 3000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T12:00:04.000Z'),
    };
    const credit30 = {
      id: 'entry-30-credit',
      paymentId: 'payment-multi-distinct',
      transactionId: 'tx-30',
      accountId: 'CUSTOMER_RECEIVABLE',
      entryType: LedgerEntryType.CREDIT,
      amount: 3000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T12:00:04.000Z'),
    };

    mockPrisma.booking.findMany.mockResolvedValueOnce([]);
    mockPrisma.refund.findMany
      .mockResolvedValueOnce([mockRefund1, mockRefund2])
      .mockResolvedValueOnce([]);

    // For refund-50:
    // 1st: linked -> []
    // 2nd: unlinked -> both pairs, but only 1 matches 5000 GBP
    // For refund-30:
    // 3rd: linked -> []
    // 4th: unlinked -> remaining 3000 GBP pair
    mockPrisma.ledgerEntry.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([debit50, credit50, debit30, credit30])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([debit30, credit30]);

    mockPrisma.ledgerEntry.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.ledgerEntriesLinked).toBe(4);
    expect(stats.quarantined).toBe(0);
    expect(stats.errors).toBe(0);

    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-50-debit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-50' },
    });
    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-50-credit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-50' },
    });
    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-30-debit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-30' },
    });
    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-30-credit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-30' },
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
    mockPrisma.refund.findMany.mockResolvedValueOnce([mockRefund]).mockResolvedValueOnce([]);
    mockPrisma.cancellationRefundObligation.findUnique.mockResolvedValueOnce(mockObligation);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ hasBookingId: true }])
      .mockResolvedValueOnce([{ bookingId: 'booking-1' }]);
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
    expect(stats.mismatches).toBe(1);
    expect(stats.refundsLinked).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith({
      message: 'refund_obligation_backfill',
      outcome: 'QUARANTINED',
      reason: 'OBLIGATION_OVER_REFUND',
    });
  });

  it('handles partial CAS claim rollback and quarantines gracefully', async () => {
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

    const pairDebit = {
      id: 'race-debit',
      paymentId: 'payment-race',
      transactionId: 'tx-race',
      accountId: 'PLATFORM_REVENUE',
      entryType: LedgerEntryType.DEBIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    };
    const pairCredit = {
      id: 'race-credit',
      paymentId: 'payment-race',
      transactionId: 'tx-race',
      accountId: 'CUSTOMER_RECEIVABLE',
      entryType: LedgerEntryType.CREDIT,
      amount: 5000,
      currency: 'GBP',
      refundTransactionId: null,
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    };

    mockPrisma.booking.findMany.mockResolvedValueOnce([]);
    mockPrisma.refund.findMany.mockResolvedValueOnce([mockRefund]).mockResolvedValueOnce([]);

    mockPrisma.ledgerEntry.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pairDebit, pairCredit]);

    // Partial claim: debit succeeds (1), credit fails (0)
    mockPrisma.ledgerEntry.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 }); // rollback updateMany

    const stats = await backfillCancellationRefundObligations({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: mockLogger,
    });

    expect(stats.ledgerEntriesLinked).toBe(0);
    expect(stats.quarantined).toBe(1);
    expect(stats.mismatches).toBe(1);

    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'race-debit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-race' },
    });
    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'race-credit', refundTransactionId: null },
      data: { refundTransactionId: 'refund-race' },
    });
    expect(mockPrisma.ledgerEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'race-debit', refundTransactionId: 'refund-race' },
      data: { refundTransactionId: null },
    });
    expect(mockLogger.warn).toHaveBeenCalledWith({
      message: 'refund_obligation_backfill',
      outcome: 'QUARANTINED',
      reason: 'LEDGER_PAIR_CLAIM_FAILURE',
    });
  });
});
