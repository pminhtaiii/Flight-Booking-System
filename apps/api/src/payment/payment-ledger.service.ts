import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma, LedgerEntryType } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class PaymentLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records capture ledger double-entry entries:
   * DEBIT CUSTOMER_RECEIVABLE
   * CREDIT PLATFORM_REVENUE
   * Wrapped in the provided transaction client.
   */
  async recordCaptureLedger(
    paymentId: string,
    amount: number,
    currency: string,
    tx: Prisma.TransactionClient
  ): Promise<string> {
    const transactionId = crypto.randomUUID();

    await tx.ledgerEntry.createMany({
      data: [
        {
          paymentId,
          transactionId,
          accountId: 'CUSTOMER_RECEIVABLE',
          entryType: LedgerEntryType.DEBIT,
          amount,
          currency,
        },
        {
          paymentId,
          transactionId,
          accountId: 'PLATFORM_REVENUE',
          entryType: LedgerEntryType.CREDIT,
          amount,
          currency,
        },
      ],
    });

    return transactionId;
  }

  /**
   * Records refund ledger double-entry entries:
   * DEBIT PLATFORM_REVENUE
   * CREDIT CUSTOMER_RECEIVABLE
   * Wrapped in the provided transaction client.
   */
  async recordRefundLedger(
    paymentId: string,
    amount: number,
    currency: string,
    tx: Prisma.TransactionClient
  ): Promise<string> {
    const transactionId = crypto.randomUUID();

    await tx.ledgerEntry.createMany({
      data: [
        {
          paymentId,
          transactionId,
          accountId: 'PLATFORM_REVENUE',
          entryType: LedgerEntryType.DEBIT,
          amount,
          currency,
        },
        {
          paymentId,
          transactionId,
          accountId: 'CUSTOMER_RECEIVABLE',
          entryType: LedgerEntryType.CREDIT,
          amount,
          currency,
        },
      ],
    });

    return transactionId;
  }
}
