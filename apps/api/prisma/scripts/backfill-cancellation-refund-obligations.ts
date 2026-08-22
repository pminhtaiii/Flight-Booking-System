import {
  PrismaClient,
  BookingStatus,
  RefundStatus,
  LedgerEntryType,
  Prisma,
} from '@prisma/client';

export type BackfillStats = {
  processedBookings: number;
  obligationsCreated: number;
  obligationsUpdated: number;
  refundsLinked: number;
  ledgerEntriesLinked: number;
  quarantined: number;
  errors: number;
};

export type BackfillLogger = {
  log: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

export type BackfillOptions = {
  prisma?: PrismaClient;
  chunkSize?: number;
  logger?: BackfillLogger;
};

export type BookingWithRelations = Prisma.BookingGetPayload<{
  include: {
    cancellationRefund: true;
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

export const ACCOUNT_PLATFORM_REVENUE = 'PLATFORM_REVENUE';
export const ACCOUNT_CUSTOMER_RECEIVABLE = 'CUSTOMER_RECEIVABLE';

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
  const logger: BackfillLogger = {
    log: (msg: string, ...args: unknown[]) =>
      options?.logger ? options.logger.log(msg, ...args) : console.log(msg, ...args),
    warn: (msg: string, ...args: unknown[]) =>
      options?.logger ? options.logger.warn(msg, ...args) : console.warn(msg, ...args),
    error: (msg: string, ...args: unknown[]) =>
      options?.logger ? options.logger.error(msg, ...args) : console.error(msg, ...args),
  };

  const stats: BackfillStats = {
    processedBookings: 0,
    obligationsCreated: 0,
    obligationsUpdated: 0,
    refundsLinked: 0,
    ledgerEntriesLinked: 0,
    quarantined: 0,
    errors: 0,
  };

  try {
    logger.log('Starting restart-safe backfill of CancellationRefundObligations and LedgerEntries...');

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
          cancellationRefund: true,
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
          const hasCancellationContext =
            booking.cancellationRefundObligation !== null ||
            booking.cancellationRefund !== null ||
            booking.status === BookingStatus.CANCELLED_AND_REFUNDED ||
            booking.status === BookingStatus.CANCELLED_PENDING_REFUND ||
            booking.status === BookingStatus.CANCELLED_NO_REFUND;

          if (!hasCancellationContext) {
            continue;
          }

          if (!booking.paymentId) {
            logger.warn(
              `[QUARANTINE] Booking ${booking.id} has cancellation context but no associated paymentId. Quarantining.`,
            );
            stats.quarantined++;
            continue;
          }

          if (booking.payment && booking.payment.id !== booking.paymentId) {
            logger.warn(
              `[QUARANTINE] Booking ${booking.id} paymentId (${booking.paymentId}) does not match Payment record id (${booking.payment.id}). Quarantining.`,
            );
            stats.quarantined++;
            continue;
          }

          if (
            booking.cancellationRefund?.paymentId &&
            booking.paymentId !== booking.cancellationRefund.paymentId
          ) {
            logger.warn(
              `[QUARANTINE] Booking ${booking.id} paymentId (${booking.paymentId}) does not match cancellationRefund paymentId (${booking.cancellationRefund.paymentId}). Quarantining.`,
            );
            stats.quarantined++;
            continue;
          }

          if (
            booking.payment &&
            booking.currency.toUpperCase() !== booking.payment.currency.toUpperCase()
          ) {
            logger.warn(
              `[QUARANTINE] Booking ${booking.id} currency (${booking.currency}) does not match Payment currency (${booking.payment.currency}). Quarantining.`,
            );
            stats.quarantined++;
            continue;
          }

          if (
            booking.cancellationRefund &&
            booking.currency.toUpperCase() !== booking.cancellationRefund.currency.toUpperCase()
          ) {
            logger.warn(
              `[QUARANTINE] Booking ${booking.id} currency (${booking.currency}) does not match cancellationRefund currency (${booking.cancellationRefund.currency}). Quarantining.`,
            );
            stats.quarantined++;
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
            logger.warn(
              `[QUARANTINE] Booking ${booking.id} has negative or unparseable obligation amounts (total: ${totalAmountMinor}, airline: ${airlineRefundAmountMinor}). Quarantining.`,
            );
            stats.quarantined++;
            continue;
          }

          if (booking.payment && totalAmountMinor > booking.payment.amount) {
            logger.warn(
              `[QUARANTINE] Booking ${booking.id} total refund amount (${totalAmountMinor}) exceeds Payment amount (${booking.payment.amount}). Quarantining.`,
            );
            stats.quarantined++;
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
              logger.warn(
                `[QUARANTINE] Payment ${booking.payment.id} has cumulative succeeded refunds (${cumulativeRefunded}) exceeding payment amount (${booking.payment.amount}). Quarantining booking ${booking.id}.`,
              );
              stats.quarantined++;
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
            booking.cancellationRefund &&
            booking.cancellationRefund.cancellationRefundObligationId !== obligationId
          ) {
            await prisma.refund.update({
              where: { id: booking.cancellationRefund.id },
              data: {
                cancellationRefundObligationId: obligationId,
              },
            });
            stats.refundsLinked++;
          }
        } catch (err: unknown) {
          stats.errors++;
          logger.error(`Error processing booking ${booking.id}:`, err);
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
              logger.warn(
                `[QUARANTINE] Payment ${refund.payment.id} has cumulative succeeded refunds (${cumulativeRefunded}) exceeding payment amount (${refund.payment.amount}). Quarantining refund ${refund.id}.`,
              );
              stats.quarantined++;
              continue;
            }
          }

          // 1. Link cancellationRefundObligationId if missing but refund has legacy bookingId
          if (refund.bookingId && !refund.cancellationRefundObligationId) {
            const obligation = await prisma.cancellationRefundObligation.findUnique({
              where: { bookingId: refund.bookingId },
            });

            if (obligation) {
              if (
                obligation.paymentId !== refund.paymentId ||
                obligation.currency.toUpperCase() !== refund.currency.toUpperCase()
              ) {
                logger.warn(
                  `[QUARANTINE] Refund ${refund.id} payment/currency mismatches obligation ${obligation.id}. Quarantining.`,
                );
                stats.quarantined++;
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
                  logger.warn(
                    `[QUARANTINE] Linking refund ${refund.id} (amount: ${refund.amount}) to obligation ${obligation.id} (totalAmount: ${linkResult.totalAmount}) would exceed obligation debt (current refunded: ${linkResult.currentObligationRefunded}). Quarantining.`,
                  );
                  stats.quarantined++;
                }
              }
            } else {
              const booking = await prisma.booking.findUnique({
                where: { id: refund.bookingId },
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
                    logger.warn(
                      `[QUARANTINE] Refund ${refund.id} amount (${refund.amount}) exceeds new obligation totalAmount (${totalMinor}) for booking ${booking.id}. Quarantining.`,
                    );
                    stats.quarantined++;
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
                      logger.warn(
                        `[QUARANTINE] Linking refund ${refund.id} (amount: ${refund.amount}) to obligation for booking ${booking.id} would exceed obligation debt. Quarantining.`,
                      );
                      stats.quarantined++;
                    }
                  }
                } else {
                  logger.warn(
                    `[QUARANTINE] Refund ${refund.id} associated booking has invalid refund amounts. Quarantining.`,
                  );
                  stats.quarantined++;
                }
              } else {
                logger.warn(
                  `[QUARANTINE] Refund ${refund.id} links to missing, invalid, or mismatched booking ${refund.bookingId}. Quarantining.`,
                );
                stats.quarantined++;
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
                logger.warn(
                  `[QUARANTINE] Refund ${refund.id} has invalid or unbalanced linked ledger entries. Quarantining.`,
                );
                stats.quarantined++;
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
                logger.warn(
                  `[QUARANTINE] SUCCEEDED refund ${refund.id} (amount: ${refund.amount} ${refund.currency}) has no unlinked balanced ledger entries for payment ${refund.paymentId}. Quarantining.`,
                );
                stats.quarantined++;
              } else if (validPairs.length > 1) {
                logger.warn(
                  `[QUARANTINE] SUCCEEDED refund ${refund.id} (amount: ${refund.amount} ${refund.currency}) has multiple (${validPairs.length}) ambiguous unlinked ledger pairs for payment ${refund.paymentId}. Quarantining.`,
                );
                stats.quarantined++;
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
                  logger.warn(
                    `[QUARANTINE] SUCCEEDED refund ${refund.id} could not claim candidate ledger pair for payment ${refund.paymentId}. Quarantining.`,
                  );
                  stats.quarantined++;
                }
              }
            }
          } else {
            // Non-succeeded refunds should not have linked reversal entries
            const linkedEntries = await prisma.ledgerEntry.findMany({
              where: { refundTransactionId: refund.id },
            });
            if (linkedEntries.length > 0) {
              logger.warn(
                `[QUARANTINE] Non-succeeded refund ${refund.id} (status: ${refund.status}) has ${linkedEntries.length} linked ledger entries. Quarantining.`,
              );
              stats.quarantined++;
            }
          }
        } catch (err: unknown) {
          stats.errors++;
          logger.error(`Error processing refund ${refund.id}:`, err);
        }
      }
    }

    logger.log('Backfill finished. Summary:');
    logger.log(`- Processed Bookings: ${stats.processedBookings}`);
    logger.log(`- Obligations Created: ${stats.obligationsCreated}`);
    logger.log(`- Obligations Updated: ${stats.obligationsUpdated}`);
    logger.log(`- Refunds Linked: ${stats.refundsLinked}`);
    logger.log(`- Ledger Entries Linked: ${stats.ledgerEntriesLinked}`);
    logger.log(`- Quarantined: ${stats.quarantined}`);
    logger.log(`- Errors: ${stats.errors}`);

    return stats;
  } finally {
    if (shouldDisconnect) {
      await prisma.$disconnect();
    }
  }
}

if (require.main === module) {
  const prisma = new PrismaClient();
  backfillCancellationRefundObligations({ prisma })
    .then(async (stats) => {
      console.log('Backfill execution complete:', JSON.stringify(stats, null, 2));
      await prisma.$disconnect();
      process.exit(stats.errors > 0 ? 1 : 0);
    })
    .catch(async (err: unknown) => {
      console.error('Fatal error during backfill execution:', err);
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}


