import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import {
  BookingStatus,
  LedgerEntryType,
  PaymentEventSource,
  PaymentStatus,
  RefundStatus,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import {
  BookingEventPublisherService,
  BookingRefundUpdatedEvent,
  RefundSettledEvent,
} from '@/domain-events';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { RefundSettlementService } from './refund-settlement.service';
import { RefundSettlementInput } from './refund-settlement.types';

describe('RefundSettlementService', () => {
  let service: RefundSettlementService;
  let mockPrisma: {
    $transaction: jest.Mock;
  };
  let mockTx: {
    $queryRaw: jest.Mock;
    refund: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    payment: {
      update: jest.Mock;
    };
    booking: {
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    ledgerEntry: {
      create: jest.Mock;
    };
    paymentEvent: {
      create: jest.Mock;
    };
  };
  let mockAuditService: {
    createLog: jest.Mock;
  };
  let mockPublisher: {
    createContext: jest.Mock;
    publish: jest.Mock;
  };
  let mockBookingLifecycleService: {
    updateBookingRefundStatus: jest.Mock;
  };
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockTx = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'ref_123',
          paymentId: 'pay_123',
          cancellationRefundObligationId: 'obl_123',
        },
      ]),
      refund: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      payment: {
        update: jest.fn(),
      },
      booking: {
        update: jest.fn().mockResolvedValue({ id: 'book_123', version: 2 }),
        updateMany: jest.fn(),
      },
      ledgerEntry: {
        create: jest.fn(),
      },
      paymentEvent: {
        create: jest.fn(),
      },
    };

    mockPrisma = {
      $transaction: jest.fn().mockImplementation(async (cb) => cb(mockTx)),
    };

    mockAuditService = {
      createLog: jest.fn().mockResolvedValue(undefined),
    };

    mockPublisher = {
      createContext: jest.fn((tx) => ({ tx, events: [] })),
      publish: jest.fn().mockResolvedValue(undefined),
    };

    mockBookingLifecycleService = {
      updateBookingRefundStatus: jest.fn().mockImplementation(
        async (bookingId, targetStatus, refundStatus, reason, tx, context) => {
          if (targetStatus === BookingStatus.CANCELLED_PENDING_REFUND) {
            return { count: 0, updatedBooking: { id: bookingId, status: targetStatus, version: 1 } };
          }
          if (context) {
            context.events.push(
              new BookingRefundUpdatedEvent({
                bookingId,
                eventId: 'mock-event-id',
                sourceVersion: 2,
                status: targetStatus,
                refundStatus,
                reason,
                timestamp: new Date(),
              }),
            );
          }
          return { count: 1, updatedBooking: { id: bookingId, status: targetStatus, version: 2 } };
        },
      ),
    };

    service = new RefundSettlementService(
      mockPrisma as unknown as PrismaService,
      mockAuditService as unknown as AuditService,
      mockPublisher as unknown as BookingEventPublisherService,
      mockBookingLifecycleService as unknown as BookingLifecycleService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('settleVerifiedOutcome', () => {
    const baseRefundRow = {
      id: 'ref_123',
      paymentId: 'pay_123',
      amount: 20000,
      currency: 'USD',
      status: RefundStatus.REFUND_PENDING,
      cancellationRefundObligationId: 'obl_123',
      payment: {
        id: 'pay_123',
        amount: 20000,
        currency: 'USD',
        status: PaymentStatus.REFUND_PENDING,
        preDisputeStatus: null,
      },
      cancellationRefundObligation: {
        id: 'obl_123',
        bookingId: 'book_123',
        paymentId: 'pay_123',
        totalAmount: 20000,
        airlineRefundAmount: 20000,
        currency: 'USD',
        booking: {
          id: 'book_123',
          status: BookingStatus.CANCELLED_PENDING_REFUND,
        },
      },
    };

    const baseInput: RefundSettlementInput = {
      transactionId: 'ref_123',
      money: { amount: 20000, currency: 'USD' },
      outcome: {
        status: 'SUCCEEDED',
        providerReference: 're_stripe_123',
        occurredAt: '2026-08-22T10:00:00.000Z',
      },
      provenance: {
        source: 'WEBHOOK',
        externalEventId: 'evt_stripe_123',
        actorId: 'system',
        metadata: { gateway: 'stripe' },
      },
    };

    it('should throw NotFoundException if refund transaction is not found', async () => {
      mockTx.$queryRaw.mockResolvedValue([]);
      mockTx.refund.findUnique.mockResolvedValue(null);

      await expect(service.settleVerifiedOutcome(baseInput)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if amount or currency does not match persisted facts', async () => {
      mockTx.refund.findUnique.mockResolvedValue(baseRefundRow);

      const mismatchedAmountInput: RefundSettlementInput = {
        ...baseInput,
        money: { amount: 15000, currency: 'USD' },
      };

      await expect(service.settleVerifiedOutcome(mismatchedAmountInput)).rejects.toThrow(
        BadRequestException,
      );

      expect(warnSpy).toHaveBeenCalledWith({
        message: 'refund_settlement',
        outcome: 'CONFLICT',
        provenance: 'WEBHOOK',
        transactionStatus: RefundStatus.REFUND_PENDING,
      });

      const mismatchedCurrencyInput: RefundSettlementInput = {
        ...baseInput,
        money: { amount: 20000, currency: 'EUR' },
      };

      await expect(service.settleVerifiedOutcome(mismatchedCurrencyInput)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should handle single full refund settlement transitioning Payment to REFUNDED and Booking to CANCELLED_AND_REFUNDED', async () => {
      mockTx.refund.findUnique.mockResolvedValue(baseRefundRow);
      mockTx.refund.update.mockResolvedValue({
        ...baseRefundRow,
        status: RefundStatus.SUCCEEDED,
      });
      mockTx.refund.findMany.mockImplementation((args) => {
        if (args.where.paymentId) {
          return [{ amount: 20000 }];
        }
        if (args.where.cancellationRefundObligationId) {
          return [{ amount: 20000 }];
        }
        return [];
      });

      const result = await service.settleVerifiedOutcome(baseInput);

      expect(result).toEqual({
        applied: true,
        transactionStatus: 'SUCCEEDED',
        paymentStatus: PaymentStatus.REFUNDED,
        bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
      });

      expect(mockTx.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref_123' },
        data: {
          status: RefundStatus.SUCCEEDED,
          stripeRefundId: 're_stripe_123',
          nextRetryAt: null,
          updatedAt: new Date('2026-08-22T10:00:00.000Z'),
        },
      });

      expect(mockTx.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay_123' },
        data: { status: PaymentStatus.REFUNDED },
      });

      expect(mockBookingLifecycleService.updateBookingRefundStatus).toHaveBeenCalledWith(
        'book_123',
        BookingStatus.CANCELLED_AND_REFUNDED,
        RefundStatus.SUCCEEDED,
        undefined,
        mockTx,
        expect.any(Object),
      );

      expect(mockTx.paymentEvent.create).toHaveBeenCalledWith({
        data: {
          paymentId: 'pay_123',
          eventType: 'charge.refunded',
          previousStatus: PaymentStatus.REFUND_PENDING,
          newStatus: PaymentStatus.REFUNDED,
          amount: 20000,
          source: PaymentEventSource.WEBHOOK,
          stripeEventId: 'evt_stripe_123',
          createdBy: 'system',
          metadata: { gateway: 'stripe' },
        },
      });

      expect(mockAuditService.createLog).toHaveBeenCalledWith(mockTx, {
        userId: 'system',
        action: 'refund_settled',
        resourceType: 'Refund',
        resourceId: 'ref_123',
        metadata: {
          paymentId: 'pay_123',
          cancellationRefundObligationId: 'obl_123',
          amount: 20000,
          currency: 'USD',
          outcome: baseInput.outcome,
          provenance: baseInput.provenance,
        },
      });
    });

    it('emits identifier-free applied settlement telemetry by provenance', async () => {
      mockTx.refund.findUnique.mockResolvedValue(baseRefundRow);
      mockTx.refund.findMany.mockResolvedValue([{ amount: 20000 }]);

      await service.settleVerifiedOutcome(baseInput);

      expect(logSpy).toHaveBeenCalledWith({
        message: 'refund_settlement',
        outcome: 'APPLIED',
        provenance: 'WEBHOOK',
        transactionStatus: 'SUCCEEDED',
      });
    });

    it('should produce exactly one balanced ledger pair on success: DEBIT PLATFORM_REVENUE === CREDIT CUSTOMER_RECEIVABLE', async () => {
      mockTx.refund.findUnique.mockResolvedValue(baseRefundRow);
      mockTx.refund.findMany.mockResolvedValue([{ amount: 20000 }]);

      await service.settleVerifiedOutcome(baseInput);

      expect(mockTx.ledgerEntry.create).toHaveBeenCalledTimes(2);

      const firstCall = mockTx.ledgerEntry.create.mock.calls[0][0].data;
      const secondCall = mockTx.ledgerEntry.create.mock.calls[1][0].data;

      expect(firstCall.paymentId).toBe('pay_123');
      expect(firstCall.refundTransactionId).toBe('ref_123');
      expect(firstCall.accountId).toBe('PLATFORM_REVENUE');
      expect(firstCall.entryType).toBe(LedgerEntryType.DEBIT);
      expect(firstCall.amount).toBe(20000);
      expect(firstCall.currency).toBe('USD');

      expect(secondCall.paymentId).toBe('pay_123');
      expect(secondCall.refundTransactionId).toBe('ref_123');
      expect(secondCall.accountId).toBe('CUSTOMER_RECEIVABLE');
      expect(secondCall.entryType).toBe(LedgerEntryType.CREDIT);
      expect(secondCall.amount).toBe(20000);
      expect(secondCall.currency).toBe('USD');

      expect(firstCall.transactionId).toBe(secondCall.transactionId);
      expect(firstCall.amount).toBe(secondCall.amount);
    });

    it('should handle multi-transaction partial refunds ($500 payment, $300 obligation with 3x $100 refunds): Booking transitions to CANCELLED_AND_REFUNDED only on 3rd success; Payment remains PARTIALLY_REFUNDED', async () => {
      const multiRefundRow = (refundId: string, amount: number) => ({
        id: refundId,
        paymentId: 'pay_500',
        amount,
        currency: 'USD',
        status: RefundStatus.REFUND_PENDING,
        cancellationRefundObligationId: 'obl_300',
        payment: {
          id: 'pay_500',
          amount: 50000,
          currency: 'USD',
          status: PaymentStatus.PARTIALLY_REFUNDED,
          preDisputeStatus: null,
        },
        cancellationRefundObligation: {
          id: 'obl_300',
          bookingId: 'book_300',
          paymentId: 'pay_500',
          totalAmount: 30000,
          airlineRefundAmount: 30000,
          currency: 'USD',
          booking: {
            id: 'book_300',
            status: BookingStatus.CANCELLED_PENDING_REFUND,
          },
        },
      });

      // 1st refund ($100 of $300 obligation)
      mockTx.refund.findUnique.mockResolvedValue(multiRefundRow('ref_1', 10000));
      mockTx.refund.findMany.mockImplementation((args) => {
        if (args.where.paymentId) return [{ amount: 10000 }];
        if (args.where.cancellationRefundObligationId) return [{ amount: 10000 }];
        return [];
      });

      const res1 = await service.settleVerifiedOutcome({
        transactionId: 'ref_1',
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: 're_1',
          occurredAt: '2026-08-22T10:00:00.000Z',
        },
        provenance: { source: 'INLINE', actorId: 'user_1' },
      });

      expect(res1).toEqual({
        applied: true,
        transactionStatus: 'SUCCEEDED',
        paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
        bookingStatus: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      expect(mockBookingLifecycleService.updateBookingRefundStatus).toHaveBeenCalledWith(
        'book_300',
        BookingStatus.CANCELLED_PENDING_REFUND,
        RefundStatus.SUCCEEDED,
        undefined,
        mockTx,
        expect.any(Object),
      );

      // 2nd refund ($100, cumulative $200 of $300 obligation)
      mockBookingLifecycleService.updateBookingRefundStatus.mockClear();
      mockTx.refund.findUnique.mockResolvedValue(multiRefundRow('ref_2', 10000));
      mockTx.refund.findMany.mockImplementation((args) => {
        if (args.where.paymentId) return [{ amount: 10000 }, { amount: 10000 }];
        if (args.where.cancellationRefundObligationId)
          return [{ amount: 10000 }, { amount: 10000 }];
        return [];
      });

      const res2 = await service.settleVerifiedOutcome({
        transactionId: 'ref_2',
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: 're_2',
          occurredAt: '2026-08-22T10:05:00.000Z',
        },
        provenance: { source: 'INLINE', actorId: 'user_1' },
      });

      expect(res2).toEqual({
        applied: true,
        transactionStatus: 'SUCCEEDED',
        paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
        bookingStatus: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      expect(mockBookingLifecycleService.updateBookingRefundStatus).toHaveBeenCalledWith(
        'book_300',
        BookingStatus.CANCELLED_PENDING_REFUND,
        RefundStatus.SUCCEEDED,
        undefined,
        mockTx,
        expect.any(Object),
      );

      // 3rd refund ($100, cumulative $300 of $300 obligation met, $300 of $500 payment)
      mockBookingLifecycleService.updateBookingRefundStatus.mockClear();
      mockTx.refund.findUnique.mockResolvedValue(multiRefundRow('ref_3', 10000));
      mockTx.refund.findMany.mockImplementation((args) => {
        if (args.where.paymentId) return [{ amount: 10000 }, { amount: 10000 }, { amount: 10000 }];
        if (args.where.cancellationRefundObligationId)
          return [{ amount: 10000 }, { amount: 10000 }, { amount: 10000 }];
        return [];
      });

      const res3 = await service.settleVerifiedOutcome({
        transactionId: 'ref_3',
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: 're_3',
          occurredAt: '2026-08-22T10:10:00.000Z',
        },
        provenance: { source: 'INLINE', actorId: 'user_1' },
      });

      expect(res3).toEqual({
        applied: true,
        transactionStatus: 'SUCCEEDED',
        paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
        bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
      });
      expect(mockBookingLifecycleService.updateBookingRefundStatus).toHaveBeenCalledWith(
        'book_300',
        BookingStatus.CANCELLED_AND_REFUNDED,
        RefundStatus.SUCCEEDED,
        undefined,
        mockTx,
        expect.any(Object),
      );
    });

    it('should return applied: false on duplicate delivery of SUCCEEDED without modifying database or logging audit', async () => {
      mockTx.refund.findUnique.mockResolvedValue({
        ...baseRefundRow,
        status: RefundStatus.SUCCEEDED,
        payment: {
          ...baseRefundRow.payment,
          status: PaymentStatus.REFUNDED,
        },
        cancellationRefundObligation: {
          ...baseRefundRow.cancellationRefundObligation,
          booking: {
            ...baseRefundRow.cancellationRefundObligation.booking,
            status: BookingStatus.CANCELLED_AND_REFUNDED,
          },
        },
      });

      const result = await service.settleVerifiedOutcome(baseInput);

      expect(result).toEqual({
        applied: false,
        transactionStatus: 'SUCCEEDED',
        paymentStatus: PaymentStatus.REFUNDED,
        bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
      });

      expect(mockTx.refund.update).not.toHaveBeenCalled();
      expect(mockTx.ledgerEntry.create).not.toHaveBeenCalled();
      expect(mockTx.payment.update).not.toHaveBeenCalled();
      expect(mockBookingLifecycleService.updateBookingRefundStatus).not.toHaveBeenCalled();
      expect(mockTx.paymentEvent.create).not.toHaveBeenCalled();
      expect(mockAuditService.createLog).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith({
        message: 'refund_settlement',
        outcome: 'NO_OP',
        provenance: 'WEBHOOK',
        transactionStatus: RefundStatus.SUCCEEDED,
      });
    });

    it('alerts without identifiers when writing the ledger pair fails', async () => {
      mockTx.refund.findUnique.mockResolvedValue(baseRefundRow);
      mockTx.ledgerEntry.create.mockRejectedValueOnce(new Error('constraint failure'));

      await expect(service.settleVerifiedOutcome(baseInput)).rejects.toThrow('constraint failure');

      expect(errorSpy).toHaveBeenCalledWith({
        message: 'refund_ledger_invariant_failure',
        provenance: 'WEBHOOK',
        operation: 'WRITE_REVERSAL_PAIR',
      });
    });

    it('should return applied: false on duplicate delivery of FAILED or REFUND_FAILED_NEEDS_ATTENTION', async () => {
      mockTx.refund.findUnique.mockResolvedValue({
        ...baseRefundRow,
        status: RefundStatus.FAILED,
        payment: {
          ...baseRefundRow.payment,
          status: PaymentStatus.SUCCEEDED,
        },
      });

      const failedInput: RefundSettlementInput = {
        ...baseInput,
        outcome: {
          status: 'FAILED',
          errorCode: 'card_declined',
          occurredAt: '2026-08-22T10:00:00.000Z',
        },
      };

      const result = await service.settleVerifiedOutcome(failedInput);

      expect(result).toEqual({
        applied: false,
        transactionStatus: 'FAILED',
        paymentStatus: PaymentStatus.SUCCEEDED,
        bookingStatus: BookingStatus.CANCELLED_PENDING_REFUND,
      });

      expect(mockTx.refund.update).not.toHaveBeenCalled();
      expect(mockTx.ledgerEntry.create).not.toHaveBeenCalled();
      expect(mockTx.payment.update).not.toHaveBeenCalled();
      expect(mockAuditService.createLog).not.toHaveBeenCalled();
    });

    it('should preserve dispute status and update preDisputeStatus when payment is DISPUTED or CHARGEBACK_LOST', async () => {
      const disputedRefundRow = {
        ...baseRefundRow,
        payment: {
          ...baseRefundRow.payment,
          status: PaymentStatus.DISPUTED,
          preDisputeStatus: PaymentStatus.SUCCEEDED,
        },
      };

      mockTx.refund.findUnique.mockResolvedValue(disputedRefundRow);
      mockTx.refund.findMany.mockResolvedValue([{ amount: 20000 }]);

      const result = await service.settleVerifiedOutcome(baseInput);

      expect(result.paymentStatus).toBe(PaymentStatus.DISPUTED);
      expect(mockTx.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay_123' },
        data: { preDisputeStatus: PaymentStatus.REFUNDED },
      });
      expect(mockTx.paymentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            previousStatus: PaymentStatus.DISPUTED,
            newStatus: PaymentStatus.DISPUTED,
          }),
        }),
      );
    });

    it('should set bookingStatus to CANCELLED_NO_REFUND if obligation totalAmount is 0', async () => {
      const zeroObligationRefundRow = {
        ...baseRefundRow,
        cancellationRefundObligation: {
          ...baseRefundRow.cancellationRefundObligation,
          totalAmount: 0,
        },
      };

      mockTx.refund.findUnique.mockResolvedValue(zeroObligationRefundRow);
      mockTx.refund.findMany.mockResolvedValue([{ amount: 20000 }]);

      const result = await service.settleVerifiedOutcome(baseInput);

      expect(result.bookingStatus).toBe(BookingStatus.CANCELLED_NO_REFUND);
      expect(mockBookingLifecycleService.updateBookingRefundStatus).toHaveBeenCalledWith(
        'book_123',
        BookingStatus.CANCELLED_NO_REFUND,
        RefundStatus.SUCCEEDED,
        undefined,
        mockTx,
        expect.any(Object),
      );
    });

    it('should handle refund without cancellation obligation correctly', async () => {
      const directPaymentRefundRow = {
        ...baseRefundRow,
        cancellationRefundObligationId: null,
        cancellationRefundObligation: null,
      };

      mockTx.refund.findUnique.mockResolvedValue(directPaymentRefundRow);
      mockTx.refund.findMany.mockResolvedValue([{ amount: 20000 }]);

      const result = await service.settleVerifiedOutcome(baseInput);

      expect(result.bookingStatus).toBeUndefined();
      expect(mockBookingLifecycleService.updateBookingRefundStatus).not.toHaveBeenCalled();
      expect(result.applied).toBe(true);
      expect(result.transactionStatus).toBe('SUCCEEDED');
      expect(result.paymentStatus).toBe(PaymentStatus.REFUNDED);
    });

    it('should handle failed refund outcome and restore payment status when no other active refunds exist', async () => {
      mockTx.refund.findUnique.mockResolvedValue(baseRefundRow);
      mockTx.refund.findMany.mockImplementation((args) => {
        // activeOtherRefunds query
        if (args.where.id?.not) return [];
        // succeededRefunds query
        if (args.where.status === RefundStatus.SUCCEEDED) return [];
        return [];
      });

      const failedInput: RefundSettlementInput = {
        transactionId: 'ref_123',
        money: { amount: 20000, currency: 'USD' },
        outcome: {
          status: 'FAILED',
          errorCode: 'charge_already_refunded',
          occurredAt: '2026-08-22T10:00:00.000Z',
        },
        provenance: {
          source: 'ADMIN',
          actorId: 'admin_1',
          metadata: { note: 'manual trigger failed' },
        },
      };

      const result = await service.settleVerifiedOutcome(failedInput);

      expect(result).toEqual({
        applied: true,
        transactionStatus: 'FAILED',
        paymentStatus: PaymentStatus.SUCCEEDED,
        bookingStatus: BookingStatus.CANCELLED_PENDING_REFUND,
      });

      expect(mockTx.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref_123' },
        data: {
          status: RefundStatus.FAILED,
          lastErrorCode: 'charge_already_refunded',
          lastErrorAt: new Date('2026-08-22T10:00:00.000Z'),
        },
      });

      expect(mockTx.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay_123' },
        data: { status: PaymentStatus.SUCCEEDED },
      });

      expect(mockTx.paymentEvent.create).toHaveBeenCalledWith({
        data: {
          paymentId: 'pay_123',
          eventType: 'refund_failed',
          previousStatus: PaymentStatus.REFUND_PENDING,
          newStatus: PaymentStatus.SUCCEEDED,
          amount: 20000,
          source: PaymentEventSource.API,
          stripeEventId: null,
          createdBy: 'admin_1',
          metadata: {
            errorCode: 'charge_already_refunded',
            note: 'manual trigger failed',
          },
        },
      });

      expect(mockAuditService.createLog).toHaveBeenCalledWith(mockTx, {
        userId: 'admin_1',
        action: 'refund_failed',
        resourceType: 'Refund',
        resourceId: 'ref_123',
        metadata: {
          paymentId: 'pay_123',
          cancellationRefundObligationId: 'obl_123',
          amount: 20000,
          currency: 'USD',
          outcome: failedInput.outcome,
          provenance: failedInput.provenance,
        },
      });
    });

    it('should set REFUND_FAILED_NEEDS_ATTENTION when error code includes ATTENTION', async () => {
      mockTx.refund.findUnique.mockResolvedValue(baseRefundRow);
      mockTx.refund.findMany.mockImplementation((args) => {
        if (args.where.id?.not) return [];
        if (args.where.status === RefundStatus.SUCCEEDED) return [{ amount: 5000 }];
        return [];
      });

      const attentionInput: RefundSettlementInput = {
        transactionId: 'ref_123',
        money: { amount: 20000, currency: 'USD' },
        outcome: {
          status: 'FAILED',
          errorCode: 'STRIPE_REQUIRES_ATTENTION',
          occurredAt: '2026-08-22T10:00:00.000Z',
        },
        provenance: {
          source: 'CRON',
        },
      };

      const result = await service.settleVerifiedOutcome(attentionInput);

      expect(result).toEqual({
        applied: true,
        transactionStatus: 'REFUND_FAILED_NEEDS_ATTENTION',
        paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
        bookingStatus: BookingStatus.REFUND_FAILED_NEEDS_ATTENTION,
      });

      expect(mockTx.refund.update).toHaveBeenCalledWith({
        where: { id: 'ref_123' },
        data: {
          status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
          lastErrorCode: 'STRIPE_REQUIRES_ATTENTION',
          lastErrorAt: new Date('2026-08-22T10:00:00.000Z'),
        },
      });

      expect(mockTx.paymentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source: PaymentEventSource.CRON,
            newStatus: PaymentStatus.PARTIALLY_REFUNDED,
          }),
        }),
      );
    });

    it('should emit RefundSettledEvent post-commit on non-replay success', async () => {
      mockTx.refund.findUnique.mockResolvedValue(baseRefundRow);
      mockTx.refund.findMany.mockResolvedValue([{ amount: 20000 }]);

      await service.settleVerifiedOutcome(baseInput);

      expect(mockPublisher.createContext).toHaveBeenCalledWith(mockTx);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const publishedBatch = mockPublisher.publish.mock.calls[0][0];
      const refundSettled = publishedBatch.find((e: any) => e instanceof RefundSettledEvent);
      expect(refundSettled).toBeDefined();
      expect(refundSettled).toMatchObject({
        refundId: 'ref_123',
        amount: 20000,
        currency: 'USD',
        bookingId: 'book_123',
      });
      expect(refundSettled.eventId).toBeDefined();
      expect(refundSettled.timestamp).toBeInstanceOf(Date);
    });

    it('should increment booking version and emit BookingRefundUpdatedEvent post-commit on booking status transition', async () => {
      mockTx.refund.findUnique.mockResolvedValue(baseRefundRow);
      mockTx.refund.findMany.mockResolvedValue([{ amount: 20000 }]);

      await service.settleVerifiedOutcome(baseInput);

      expect(mockBookingLifecycleService.updateBookingRefundStatus).toHaveBeenCalledWith(
        'book_123',
        BookingStatus.CANCELLED_AND_REFUNDED,
        RefundStatus.SUCCEEDED,
        undefined,
        mockTx,
        expect.any(Object),
      );

      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const publishedBatch = mockPublisher.publish.mock.calls[0]?.[0];
      expect(Array.isArray(publishedBatch)).toBe(true);
      if (!Array.isArray(publishedBatch)) {
        throw new Error('Expected publishedBatch to be an array');
      }
      const bookingRefundUpdated = publishedBatch.find(
        (e: any): e is BookingRefundUpdatedEvent => e instanceof BookingRefundUpdatedEvent,
      );
      expect(bookingRefundUpdated).toBeDefined();
      if (!bookingRefundUpdated) {
        throw new Error('Expected BookingRefundUpdatedEvent in publishedBatch');
      }
      expect(bookingRefundUpdated).toMatchObject({
        bookingId: 'book_123',
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        refundStatus: RefundStatus.SUCCEEDED,
        sourceVersion: 2,
      });
      expect(bookingRefundUpdated.eventId).toBeDefined();
      expect(bookingRefundUpdated.timestamp).toBeInstanceOf(Date);
    });

    it('should emit refund.settled without a booking event or version bump when refund succeeds with NO booking state change', async () => {
      const partialRefundRow = {
        ...baseRefundRow,
        amount: 10000,
        cancellationRefundObligation: {
          ...baseRefundRow.cancellationRefundObligation,
          totalAmount: 30000,
          booking: {
            id: 'book_123',
            status: BookingStatus.CANCELLED_PENDING_REFUND,
            version: 3,
          },
        },
      };

      mockTx.refund.findUnique.mockResolvedValue(partialRefundRow);
      mockTx.refund.findMany.mockImplementation((args) => {
        if (args.where.cancellationRefundObligationId) {
          return [{ amount: 10000 }];
        }
        if (args.where.paymentId) {
          return [{ amount: 10000 }];
        }
        return [];
      });

      const partialInput: RefundSettlementInput = {
        ...baseInput,
        money: { amount: 10000, currency: 'USD' },
      };

      await service.settleVerifiedOutcome(partialInput);

      expect(mockBookingLifecycleService.updateBookingRefundStatus).toHaveBeenCalledWith(
        'book_123',
        BookingStatus.CANCELLED_PENDING_REFUND,
        RefundStatus.SUCCEEDED,
        undefined,
        mockTx,
        expect.any(Object),
      );

      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const publishedBatch = mockPublisher.publish.mock.calls[0]?.[0];
      expect(Array.isArray(publishedBatch)).toBe(true);
      if (!Array.isArray(publishedBatch)) {
        throw new Error('Expected publishedBatch to be an array');
      }
      expect(publishedBatch).toHaveLength(1);
      expect(publishedBatch[0]).toBeInstanceOf(RefundSettledEvent);
      expect(publishedBatch[0]).toMatchObject({
        refundId: 'ref_123',
        amount: 10000,
        currency: 'USD',
        bookingId: 'book_123',
      });
      const hasBookingEvent = publishedBatch.some(
        (e: any) => e instanceof BookingRefundUpdatedEvent,
      );
      expect(hasBookingEvent).toBe(false);
    });

    it('should increment booking version and emit BookingRefundUpdatedEvent on REFUND_FAILED_NEEDS_ATTENTION', async () => {
      mockTx.refund.findUnique.mockResolvedValue({
        ...baseRefundRow,
        cancellationRefundObligation: {
          ...baseRefundRow.cancellationRefundObligation,
          booking: {
            id: 'book_123',
            status: BookingStatus.CANCELLED_PENDING_REFUND,
            version: 1,
          },
        },
      });
      mockTx.refund.findMany.mockResolvedValue([]);

      const attentionInput: RefundSettlementInput = {
        transactionId: 'ref_123',
        money: { amount: 20000, currency: 'USD' },
        outcome: {
          status: 'FAILED',
          errorCode: 'STRIPE_REQUIRES_ATTENTION',
          occurredAt: '2026-08-22T10:00:00.000Z',
        },
        provenance: {
          source: 'CRON',
        },
      };

      await service.settleVerifiedOutcome(attentionInput);

      expect(mockBookingLifecycleService.updateBookingRefundStatus).toHaveBeenCalledWith(
        'book_123',
        BookingStatus.REFUND_FAILED_NEEDS_ATTENTION,
        RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
        'STRIPE_REQUIRES_ATTENTION',
        mockTx,
        expect.any(Object),
      );

      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const publishedBatch = mockPublisher.publish.mock.calls[0]?.[0];
      expect(Array.isArray(publishedBatch)).toBe(true);
      if (!Array.isArray(publishedBatch)) {
        throw new Error('Expected publishedBatch to be an array');
      }
      expect(publishedBatch).toHaveLength(1);
      const bookingRefundUpdated = publishedBatch[0];
      expect(bookingRefundUpdated).toBeInstanceOf(BookingRefundUpdatedEvent);
      if (!bookingRefundUpdated) {
        throw new Error('Expected event in publishedBatch');
      }
      expect(bookingRefundUpdated).toMatchObject({
        bookingId: 'book_123',
        status: BookingStatus.REFUND_FAILED_NEEDS_ATTENTION,
        refundStatus: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
        reason: 'STRIPE_REQUIRES_ATTENTION',
      });
      const hasSettledFact = publishedBatch.some((e: any) => e instanceof RefundSettledEvent);
      expect(hasSettledFact).toBe(false);
    });

    it('verifies no-op on already in target state: no events emitted if booking already in status', async () => {
      mockTx.refund.findUnique.mockResolvedValue(baseRefundRow);
      mockTx.refund.findMany.mockResolvedValue([{ amount: 20000 }]);
      // Simulate no-op when booking is already CANCELLED_AND_REFUNDED
      mockBookingLifecycleService.updateBookingRefundStatus.mockResolvedValueOnce({
        count: 0,
        updatedBooking: { id: 'book_123', status: BookingStatus.CANCELLED_AND_REFUNDED, version: 1 },
      });

      const result = await service.settleVerifiedOutcome(baseInput);

      expect(result.applied).toBe(true);
      expect(mockBookingLifecycleService.updateBookingRefundStatus).toHaveBeenCalledWith(
        'book_123',
        BookingStatus.CANCELLED_AND_REFUNDED,
        RefundStatus.SUCCEEDED,
        undefined,
        mockTx,
        expect.any(Object),
      );
      // Only RefundSettledEvent should be published, no BookingRefundUpdatedEvent
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const publishedBatch = mockPublisher.publish.mock.calls[0]?.[0];
      expect(Array.isArray(publishedBatch)).toBe(true);
      if (!Array.isArray(publishedBatch)) {
        throw new Error('Expected publishedBatch to be an array');
      }
      expect(publishedBatch.some((e: any) => e instanceof BookingRefundUpdatedEvent)).toBe(false);
    });

    it('should discard all events on transaction rollback', async () => {
      mockTx.refund.findUnique.mockResolvedValue(baseRefundRow);
      mockTx.ledgerEntry.create.mockRejectedValueOnce(new Error('Transaction aborted'));

      await expect(service.settleVerifiedOutcome(baseInput)).rejects.toThrow('Transaction aborted');

      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('should publish zero events on replay of SUCCEEDED', async () => {
      mockTx.refund.findUnique.mockResolvedValue({
        ...baseRefundRow,
        status: RefundStatus.SUCCEEDED,
      });

      const result = await service.settleVerifiedOutcome(baseInput);

      expect(result.applied).toBe(false);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });
});
