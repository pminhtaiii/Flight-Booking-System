import {
  PrismaClient,
  BookingStatus,
  RefundStatus,
  LedgerEntryType,
  Prisma,
} from '@prisma/client';
import { Logger } from '@nestjs/common';

export type BackfillStats = {
  processedBookings: number;
  obligationsCreated: number;
  obligationsUpdated: number;
  refundsLinked: number;
  ledgerEntriesLinked: number;
  quarantined: number;
  mismatches: number;
  errors: number;
};

export type BackfillTelemetry = {
  message: 'refund_obligation_backfill';
  outcome: 'STARTED' | 'QUARANTINED' | 'COMPLETED' | 'FAILED';
  reason?: string;
  processedBookings?: number;
  obligationsCreated?: number;
  obligationsUpdated?: number;
  refundsLinked?: number;
  ledgerEntriesLinked?: number;
  quarantined?: number;
  mismatches?: number;
  errors?: number;
};

export type BackfillLogger = {
  log: (event: BackfillTelemetry) => void;
  warn: (event: BackfillTelemetry) => void;
  error: (event: BackfillTelemetry) => void;
};

export type BackfillOptions = {
  prisma?: PrismaClient;
  chunkSize?: number;
  logger?: BackfillLogger;
};

export type BookingWithRelations = Prisma.BookingGetPayload<{
  include: {
    cancellationRefundObligation: true;
    payment: true;
  };
}>;

export type RefundWithRelations = Prisma.RefundGetPayload<{
  include: {
    payment: true;
    cancellationRefundObligation: true;
    ledgerEntries: true;
  };
}>;

/**
 * The pre-contract schema stored the cancellation-to-booking association on
 * `refunds.bookingId`. The contracted Prisma client intentionally no longer
 * exposes that column or the inverse Booking relation. This narrow projection
 * keeps the one-off backfill runnable before the destructive migration without
 * reintroducing either legacy field to the application schema.
 */
type LegacyRefundCompatibilityRow = {
  id: string;
  bookingId: string | null;
  paymentId: string;
  currency: string;
  cancellationRefundObligationId: string | null;
};

type LegacyRefundBookingRow = Pick<LegacyRefundCompatibilityRow, 'bookingId'>;

type LegacyRefundBookingIdColumnGuardRow = {
  hasBookingId: boolean;
};

export class LegacyRefundBookingIdColumnMissingError extends Error {
  constructor() {
    super(
      'Cancellation refund obligation backfill requires the pre-contract refunds.bookingId column. Run it before the refund obligation contract migration.',
    );
    this.name = 'LegacyRefundBookingIdColumnMissingError';
  }
}

async function assertLegacyRefundBookingIdColumn(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<LegacyRefundBookingIdColumnGuardRow[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'refunds'
        AND column_name = 'bookingId'
    ) AS "hasBookingId"
  `);

  if (rows[0]?.hasBookingId !== true) {
    throw new LegacyRefundBookingIdColumnMissingError();
  }
}

async function findLegacyRefundsForBooking(
  prisma: PrismaClient,
  bookingId: string,
): Promise<LegacyRefundCompatibilityRow[]> {
  return prisma.$queryRaw<LegacyRefundCompatibilityRow[]>(Prisma.sql`
    SELECT "id", "bookingId", "paymentId", "currency", "cancellationRefundObligationId"
    FROM "refunds"
    WHERE "bookingId" = ${bookingId}
    ORDER BY "createdAt" ASC, "id" ASC
  `);
}

async function findLegacyBookingIdForRefund(
  prisma: PrismaClient,
  refundId: string,
): Promise<string | null> {
  const rows = await prisma.$queryRaw<LegacyRefundBookingRow[]>(Prisma.sql`
    SELECT "bookingId"
    FROM "refunds"
    WHERE "id" = ${refundId}
    LIMIT 1
  `);

  return rows[0]?.bookingId ?? null;
}

export const ACCOUNT_PLATFORM_REVENUE = 'PLATFORM_REVENUE';
export const ACCOUNT_CUSTOMER_RECEIVABLE = 'CUSTOMER_RECEIVABLE';

type QuarantineReason =
  | 'AMBIGUOUS_LEGACY_REFUND'
  | 'MISSING_PAYMENT'
  | 'BOOKING_PAYMENT_MISMATCH'
  | 'LEGACY_REFUND_PAYMENT_MISMATCH'
  | 'BOOKING_PAYMENT_CURRENCY_MISMATCH'
  | 'LEGACY_REFUND_CURRENCY_MISMATCH'
  | 'INVALID_OBLIGATION_AMOUNT'
  | 'OBLIGATION_EXCEEDS_PAYMENT'
  | 'PAYMENT_OVER_REFUND'
  | 'REFUND_OBLIGATION_MISMATCH'
  | 'OBLIGATION_OVER_REFUND'
  | 'REFUND_EXCEEDS_OBLIGATION'
  | 'REFUND_BOOKING_MISMATCH'
  | 'LEDGER_INVARIANT_FAILURE'
  | 'MISSING_LEDGER_PAIR'
  | 'AMBIGUOUS_LEDGER_PAIR'
  | 'LEDGER_PAIR_CLAIM_FAILURE'
  | 'NON_TERMINAL_REFUND_LEDGER_LINK';

// Each quarantine represents a data-quality or financial-invariant violation
// from the rollout runbook. Processing failures are counted separately in
// `errors`, never as mismatches.
const DATA_QUALITY_OR_INVARIANT_QUARANTINE_REASONS = new Set<QuarantineReason>([
  'AMBIGUOUS_LEGACY_REFUND',
  'MISSING_PAYMENT',
  'BOOKING_PAYMENT_MISMATCH',
  'LEGACY_REFUND_PAYMENT_MISMATCH',
  'BOOKING_PAYMENT_CURRENCY_MISMATCH',
  'LEGACY_REFUND_CURRENCY_MISMATCH',
  'INVALID_OBLIGATION_AMOUNT',
  'OBLIGATION_EXCEEDS_PAYMENT',
  'PAYMENT_OVER_REFUND',
  'REFUND_OBLIGATION_MISMATCH',
  'OBLIGATION_OVER_REFUND',
  'REFUND_EXCEEDS_OBLIGATION',
  'REFUND_BOOKING_MISMATCH',
  'LEDGER_INVARIANT_FAILURE',
  'MISSING_LEDGER_PAIR',
  'AMBIGUOUS_LEDGER_PAIR',
  'LEDGER_PAIR_CLAIM_FAILURE',
  'NON_TERMINAL_REFUND_LEDGER_LINK',
]);

export function toMinorUnits(amount: Prisma.Decimal | number | string | null | undefined): number | null {
  if (amount === null || amount === undefined) {
    return null;
  }
  const numeric = Number(amount);
  if (isNaN(numeric)) {
    return null;
  }
  return Math.round(numeric * 100);
}

export function deriveObligationAmounts(booking: {
  status: BookingStatus;
  totalAmount: Prisma.Decimal | number | string;
  customerRefundAmount?: Prisma.Decimal | number | string | null;
  airlineRefundAmount?: Prisma.Decimal | number | string | null;
}): { totalAmount: number | null; airlineRefundAmount: number | null } {
  if (booking.status === BookingStatus.CANCELLED_NO_REFUND) {
    return {
      totalAmount: 0,
      airlineRefundAmount: 0,
    };
  }

  const totalAmount =
    booking.customerRefundAmount !== null && booking.customerRefundAmount !== undefined
      ? toMinorUnits(booking.customerRefundAmount)
      : toMinorUnits(booking.totalAmount);

  const airlineRefundAmount =
    booking.airlineRefundAmount !== null && booking.airlineRefundAmount !== undefined
      ? toMinorUnits(booking.airlineRefundAmount)
      : totalAmount;

  return { totalAmount, airlineRefundAmount };
}

export type LedgerValidationResult = {
  isValid: boolean;
  debitEntry?: Prisma.LedgerEntryGetPayload<{}>;
  creditEntry?: Prisma.LedgerEntryGetPayload<{}>;
};

export function validateLedgerPair(
  entries: Prisma.LedgerEntryGetPayload<{}>[],
  expectedAmount: number,
  expectedCurrency: string,
): LedgerValidationResult {
  const debits = entries.filter(
    (e) => e.entryType === LedgerEntryType.DEBIT && e.accountId === ACCOUNT_PLATFORM_REVENUE,
  );
  const credits = entries.filter(
    (e) => e.entryType === LedgerEntryType.CREDIT && e.accountId === ACCOUNT_CUSTOMER_RECEIVABLE,
  );

  if (debits.length !== 1 || credits.length !== 1) {
    return { isValid: false };
  }

  const debit = debits[0];
  const credit = credits[0];
  const normalizedCurrency = expectedCurrency.toUpperCase();

  const isBalanced =
    debit.amount === expectedAmount &&
    credit.amount === expectedAmount &&
    debit.amount === credit.amount &&
    debit.currency.toUpperCase() === normalizedCurrency &&
    credit.currency.toUpperCase() === normalizedCurrency;

  return {
    isValid: isBalanced,
    debitEntry: debit,
    creditEntry: credit,
  };
}

export async function backfillCancellationRefundObligations(
  options?: BackfillOptions,
): Promise<BackfillStats> {
  const prisma = options?.prisma ?? new PrismaClient();
  const shouldDisconnect = !options?.prisma;
  const chunkSize = options?.chunkSize ?? 50;
  const logger: BackfillLogger = options?.logger ?? new Logger('CancellationRefundObligationBackfill');

  const stats: BackfillStats = {
    processedBookings: 0,
    obligationsCreated: 0,
    obligationsUpdated: 0,
    refundsLinked: 0,
    ledgerEntriesLinked: 0,
    quarantined: 0,
    mismatches: 0,
    errors: 0,
  };

  const quarantine = (reason: QuarantineReason): void => {
    stats.quarantined++;
    if (DATA_QUALITY_OR_INVARIANT_QUARANTINE_REASONS.has(reason)) {
      stats.mismatches++;
    }
    logger.warn({
      message: 'refund_obligation_backfill',
      outcome: 'QUARANTINED',
      reason,
    });
  };

  try {
    await assertLegacyRefundBookingIdColumn(prisma);
    logger.log({ message: 'refund_obligation_backfill', outcome: 'STARTED' });

    // =========================================================================
    // Phase 1: Cursor pagination over Bookings
    // =========================================================================
    let lastBookingId: string | undefined = undefined;

    while (true) {
      const bookings: BookingWithRelations[] = await prisma.booking.findMany({
        take: chunkSize,
        skip: lastBookingId ? 1 : 0,
        cursor: lastBookingId ? { id: lastBookingId } : undefined,
        orderBy: { id: 'asc' },
        include: {
          cancellationRefundObligation: true,
          payment: true,
        },
      });

      if (bookings.length === 0) {
        break;
      }

      for (const booking of bookings) {
        lastBookingId = booking.id;
        stats.processedBookings++;

        try {
          const legacyRefunds = await findLegacyRefundsForBooking(prisma, booking.id);
          if (legacyRefunds.length > 1) {
            quarantine('AMBIGUOUS_LEGACY_REFUND');
            continue;
          }
          const legacyRefund = legacyRefunds[0] ?? null;

          const hasCancellationContext =
            booking.cancellationRefundObligation !== null ||
            legacyRefund !== null ||
            booking.status === BookingStatus.CANCELLED_AND_REFUNDED ||
            booking.status === BookingStatus.CANCELLED_PENDING_REFUND ||
            booking.status === BookingStatus.CANCELLED_NO_REFUND;

          if (!hasCancellationContext) {
            continue;
          }

          if (!booking.paymentId) {
            quarantine('MISSING_PAYMENT');
            continue;
          }

          if (booking.payment && booking.payment.id !== booking.paymentId) {
            quarantine('BOOKING_PAYMENT_MISMATCH');
            continue;
          }

          if (
            legacyRefund?.paymentId &&
            booking.paymentId !== legacyRefund.paymentId
          ) {
            quarantine('LEGACY_REFUND_PAYMENT_MISMATCH');
            continue;
          }

          if (
            booking.payment &&
            booking.currency.toUpperCase() !== booking.payment.currency.toUpperCase()
          ) {
            quarantine('BOOKING_PAYMENT_CURRENCY_MISMATCH');
            continue;
          }

          if (
            legacyRefund &&
            booking.currency.toUpperCase() !== legacyRefund.currency.toUpperCase()
          ) {
            quarantine('LEGACY_REFUND_CURRENCY_MISMATCH');
            continue;
          }

          // Derive obligation amounts using unified helper
          const { totalAmount: totalAmountMinor, airlineRefundAmount: airlineRefundAmountMinor } =
            deriveObligationAmounts(booking);

          if (
            totalAmountMinor === null ||
            airlineRefundAmountMinor === null ||
            totalAmountMinor < 0 ||
            airlineRefundAmountMinor < 0
          ) {
            quarantine('INVALID_OBLIGATION_AMOUNT');
            continue;
          }

          if (booking.payment && totalAmountMinor > booking.payment.amount) {
            quarantine('OBLIGATION_EXCEEDS_PAYMENT');
            continue;
          }

          // Cumulative Over-Refund verification per data-model.md L216
          if (booking.payment) {
            const refundSum = await prisma.refund.aggregate({
              where: {
                paymentId: booking.payment.id,
                status: RefundStatus.SUCCEEDED,
              },
              _sum: { amount: true },
            });
            const cumulativeRefunded = refundSum._sum.amount ?? 0;
            if (cumulativeRefunded > booking.payment.amount) {
              quarantine('PAYMENT_OVER_REFUND');
              continue;
            }
          }

          const normalizedCurrency = booking.currency.toUpperCase();
          let obligationId: string;

          if (booking.cancellationRefundObligation) {
            const existing = booking.cancellationRefundObligation;
            const needsUpdate =
              existing.totalAmount !== totalAmountMinor ||
              existing.airlineRefundAmount !== airlineRefundAmountMinor ||
              existing.paymentId !== booking.paymentId ||
              existing.currency.toUpperCase() !== normalizedCurrency;

            if (needsUpdate) {
              await prisma.cancellationRefundObligation.update({
                where: { id: existing.id },
                data: {
                  totalAmount: totalAmountMinor,
                  airlineRefundAmount: airlineRefundAmountMinor,
                  paymentId: booking.paymentId,
                  currency: normalizedCurrency,
                },
              });
              stats.obligationsUpdated++;
            }
            obligationId = existing.id;
          } else {
            const created = await prisma.cancellationRefundObligation.create({
              data: {
                bookingId: booking.id,
                paymentId: booking.paymentId,
                totalAmount: totalAmountMinor,
                airlineRefundAmount: airlineRefundAmountMinor,
                currency: normalizedCurrency,
              },
            });
            stats.obligationsCreated++;
            obligationId = created.id;
          }

          if (
            legacyRefund &&
            legacyRefund.cancellationRefundObligationId !== obligationId
          ) {
            await prisma.refund.update({
              where: { id: legacyRefund.id },
              data: {
                cancellationRefundObligationId: obligationId,
              },
            });
            stats.refundsLinked++;
          }
        } catch (err: unknown) {
          stats.errors++;
          logger.error({
            message: 'refund_obligation_backfill',
            outcome: 'FAILED',
            reason: 'BOOKING_PROCESSING_FAILURE',
          });
        }
      }
    }

    // =========================================================================
    // Phase 2: Cursor pagination over Refunds (Obligation & Ledger linking)
    // =========================================================================
    let lastRefundId: string | undefined = undefined;

    while (true) {
      const refunds: RefundWithRelations[] = await prisma.refund.findMany({
        take: chunkSize,
        skip: lastRefundId ? 1 : 0,
        cursor: lastRefundId ? { id: lastRefundId } : undefined,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          payment: true,
          cancellationRefundObligation: true,
          ledgerEntries: true,
        },
      });

      if (refunds.length === 0) {
        break;
      }

      for (const refund of refunds) {
        lastRefundId = refund.id;

        try {
          // Cumulative Over-Refund verification per data-model.md L216
          if (refund.payment) {
            const refundSum = await prisma.refund.aggregate({
              where: {
                paymentId: refund.payment.id,
                status: RefundStatus.SUCCEEDED,
              },
              _sum: { amount: true },
            });
            const cumulativeRefunded = refundSum._sum.amount ?? 0;
            if (cumulativeRefunded > refund.payment.amount) {
              quarantine('PAYMENT_OVER_REFUND');
              continue;
            }
          }

          // 1. Link cancellationRefundObligationId if missing but refund has the
          // pre-contract bookingId column. The compatibility read is deliberate:
          // Refund.bookingId is absent from the contracted Prisma schema.
          const legacyBookingId = await findLegacyBookingIdForRefund(prisma, refund.id);
          if (legacyBookingId && !refund.cancellationRefundObligationId) {
            const obligation = await prisma.cancellationRefundObligation.findUnique({
              where: { bookingId: legacyBookingId },
            });

            if (obligation) {
              if (
                obligation.paymentId !== refund.paymentId ||
                obligation.currency.toUpperCase() !== refund.currency.toUpperCase()
              ) {
                quarantine('REFUND_OBLIGATION_MISMATCH');
              } else {
                const linkResult = await prisma.$transaction(async (tx) => {
                  const existingObligationRefunds = await tx.refund.aggregate({
                    where: {
                      cancellationRefundObligationId: obligation.id,
                      status: RefundStatus.SUCCEEDED,
                      id: { not: refund.id },
                    },
                    _sum: { amount: true },
                  });
                  const currentObligationRefunded = existingObligationRefunds._sum.amount ?? 0;
                  const prospectiveObligationTotal =
                    refund.status === RefundStatus.SUCCEEDED
                      ? currentObligationRefunded + refund.amount
                      : currentObligationRefunded;

                  if (prospectiveObligationTotal > obligation.totalAmount) {
                    return {
                      success: false,
                      currentObligationRefunded,
                      totalAmount: obligation.totalAmount,
                    };
                  }

                  await tx.refund.update({
                    where: { id: refund.id },
                    data: { cancellationRefundObligationId: obligation.id },
                  });

                  return { success: true };
                });

                if (linkResult.success) {
                  stats.refundsLinked++;
                } else {
                  quarantine('OBLIGATION_OVER_REFUND');
                }
              }
            } else {
              const booking = await prisma.booking.findUnique({
                where: { id: legacyBookingId },
                include: { payment: true },
              });

              if (
                booking &&
                booking.paymentId &&
                booking.paymentId === refund.paymentId &&
                booking.currency.toUpperCase() === refund.currency.toUpperCase()
              ) {
                const { totalAmount: totalMinor, airlineRefundAmount: airlineMinor } =
                  deriveObligationAmounts(booking);

                if (
                  totalMinor !== null &&
                  airlineMinor !== null &&
                  totalMinor >= 0 &&
                  airlineMinor >= 0
                ) {
                  if (refund.status === RefundStatus.SUCCEEDED && refund.amount > totalMinor) {
                    quarantine('REFUND_EXCEEDS_OBLIGATION');
                  } else {
                    const createResult = await prisma.$transaction(async (tx) => {
                      let obligationRecord = await tx.cancellationRefundObligation.findUnique({
                        where: { bookingId: booking.id },
                      });

                      let createdNew = false;
                      if (!obligationRecord) {
                        obligationRecord = await tx.cancellationRefundObligation.create({
                          data: {
                            bookingId: booking.id,
                            paymentId: refund.paymentId,
                            totalAmount: totalMinor,
                            airlineRefundAmount: airlineMinor,
                            currency: refund.currency.toUpperCase(),
                          },
                        });
                        createdNew = true;
                      } else {
                        const existingObligationRefunds = await tx.refund.aggregate({
                          where: {
                            cancellationRefundObligationId: obligationRecord.id,
                            status: RefundStatus.SUCCEEDED,
                            id: { not: refund.id },
                          },
                          _sum: { amount: true },
                        });
                        const currentRefunded = existingObligationRefunds._sum.amount ?? 0;
                        const prospective =
                          refund.status === RefundStatus.SUCCEEDED
                            ? currentRefunded + refund.amount
                            : currentRefunded;
                        if (prospective > obligationRecord.totalAmount) {
                          return {
                            success: false,
                            currentRefunded,
                            totalAmount: obligationRecord.totalAmount,
                          };
                        }
                      }

                      await tx.refund.update({
                        where: { id: refund.id },
                        data: { cancellationRefundObligationId: obligationRecord.id },
                      });

                      return { success: true, createdNew };
                    });

                    if (createResult.success) {
                      if (createResult.createdNew) {
                        stats.obligationsCreated++;
                      }
                      stats.refundsLinked++;
                    } else {
                      quarantine('OBLIGATION_OVER_REFUND');
                    }
                  }
                } else {
                  quarantine('INVALID_OBLIGATION_AMOUNT');
                }
              } else {
                quarantine('REFUND_BOOKING_MISMATCH');
              }
            }
          }

          // 2. Backfill & assert LedgerEntry linkage for SUCCEEDED refunds
          if (refund.status === RefundStatus.SUCCEEDED) {
            const linkedEntries = await prisma.ledgerEntry.findMany({
              where: { refundTransactionId: refund.id },
            });

            if (linkedEntries.length > 0) {
              // Validate existing linked entries for double-entry ledger balance
              const validation = validateLedgerPair(linkedEntries, refund.amount, refund.currency);

              if (!validation.isValid) {
                quarantine('LEDGER_INVARIANT_FAILURE');
              }
            } else {
              // Find candidate unlinked ledger entries for this payment
              const unlinkedEntries = await prisma.ledgerEntry.findMany({
                where: {
                  paymentId: refund.paymentId,
                  refundTransactionId: null,
                },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              });

              // Group candidate entries by transactionId
              const grouped = new Map<string, typeof unlinkedEntries>();
              for (const entry of unlinkedEntries) {
                const group = grouped.get(entry.transactionId) || [];
                group.push(entry);
                grouped.set(entry.transactionId, group);
              }

              type ValidPair = {
                transactionId: string;
                debitEntry: (typeof unlinkedEntries)[0];
                creditEntry: (typeof unlinkedEntries)[0];
              };

              const validPairs: ValidPair[] = [];

              for (const [txId, entries] of grouped.entries()) {
                const validation = validateLedgerPair(entries, refund.amount, refund.currency);
                if (validation.isValid && validation.debitEntry && validation.creditEntry) {
                  validPairs.push({
                    transactionId: txId,
                    debitEntry: validation.debitEntry,
                    creditEntry: validation.creditEntry,
                  });
                }
              }

              if (validPairs.length === 0) {
                quarantine('MISSING_LEDGER_PAIR');
              } else if (validPairs.length > 1) {
                quarantine('AMBIGUOUS_LEDGER_PAIR');
              } else {
                const pair = validPairs[0];
                const [debitRes, creditRes] = await prisma.$transaction([
                  prisma.ledgerEntry.updateMany({
                    where: { id: pair.debitEntry.id, refundTransactionId: null },
                    data: { refundTransactionId: refund.id },
                  }),
                  prisma.ledgerEntry.updateMany({
                    where: { id: pair.creditEntry.id, refundTransactionId: null },
                    data: { refundTransactionId: refund.id },
                  }),
                ]);

                if (debitRes.count === 1 && creditRes.count === 1) {
                  stats.ledgerEntriesLinked += 2;
                } else {
                  // If a partial claim occurred, roll it back
                  if (debitRes.count === 1 && creditRes.count === 0) {
                    await prisma.ledgerEntry.updateMany({
                      where: { id: pair.debitEntry.id, refundTransactionId: refund.id },
                      data: { refundTransactionId: null },
                    });
                  } else if (creditRes.count === 1 && debitRes.count === 0) {
                    await prisma.ledgerEntry.updateMany({
                      where: { id: pair.creditEntry.id, refundTransactionId: refund.id },
                      data: { refundTransactionId: null },
                    });
                  }
                  quarantine('LEDGER_PAIR_CLAIM_FAILURE');
                }
              }
            }
          } else {
            // Non-succeeded refunds should not have linked reversal entries
            const linkedEntries = await prisma.ledgerEntry.findMany({
              where: { refundTransactionId: refund.id },
            });
            if (linkedEntries.length > 0) {
              quarantine('NON_TERMINAL_REFUND_LEDGER_LINK');
            }
          }
        } catch (err: unknown) {
          stats.errors++;
          logger.error({
            message: 'refund_obligation_backfill',
            outcome: 'FAILED',
            reason: 'REFUND_PROCESSING_FAILURE',
          });
        }
      }
    }

    logger.log({
      message: 'refund_obligation_backfill',
      outcome: 'COMPLETED',
      processedBookings: stats.processedBookings,
      obligationsCreated: stats.obligationsCreated,
      obligationsUpdated: stats.obligationsUpdated,
      refundsLinked: stats.refundsLinked,
      ledgerEntriesLinked: stats.ledgerEntriesLinked,
      quarantined: stats.quarantined,
      mismatches: stats.mismatches,
      errors: stats.errors,
    });

    return stats;
  } finally {
    if (shouldDisconnect) {
      await prisma.$disconnect();
    }
  }
}

if (require.main === module) {
  const prisma = new PrismaClient();
  const logger = new Logger('CancellationRefundObligationBackfill');
  backfillCancellationRefundObligations({ prisma, logger })
    .then(async (stats) => {
      await prisma.$disconnect();
      process.exit(stats.errors > 0 ? 1 : 0);
    })
    .catch(async (error: unknown) => {
      logger.error({
        message: 'refund_obligation_backfill',
        outcome: 'FAILED',
        reason:
          error instanceof LegacyRefundBookingIdColumnMissingError
            ? 'PRE_CONTRACT_SCHEMA_GUARD_FAILED'
            : 'FATAL_PROCESSING_FAILURE',
      });
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}
