import 'reflect-metadata';
import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentStatus, RefundStatus, RefundTriggerType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import {
  RefundTransactionService,
  ReserveRefundTransactionInput,
} from './refund-transaction.service';

describe('RefundTransactionService', () => {
  let service: RefundTransactionService;

  const mockPrisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    payment: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    paymentEvent: {
      create: jest.fn(),
    },
    user: {
      findFirst: jest.fn(),
    },
    cancellationRefundObligation: {
      findUnique: jest.fn(),
    },
    idempotencyKey: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    refund: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.resetAllMocks();

    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) =>
        callback(mockPrisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundTransactionService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<RefundTransactionService>(RefundTransactionService);
  });

  const baseInput: ReserveRefundTransactionInput = {
    paymentId: 'pay-123',
    amount: 5000,
    currency: 'USD',
    reason: 'Customer requested cancellation',
    triggerType: RefundTriggerType.USER,
    actorId: 'user-123',
    idempotencyKey: 'idem-key-abc',
  };

  describe('input validation', () => {
    it('throws BadRequestException for negative, zero, or non-integer amount', async () => {
      await expect(
        service.reserveTransaction({ ...baseInput, amount: -100 }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.reserveTransaction({ ...baseInput, amount: 0 }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.reserveTransaction({ ...baseInput, amount: 10.5 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('locking and payment validation', () => {
    it('throws NotFoundException when Payment is not found', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([]);

      await expect(service.reserveTransaction(baseInput)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('throws BadRequestException on currency mismatch with payment', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'pay-123',
          amount: 10000,
          currency: 'EUR',
          status: PaymentStatus.SUCCEEDED,
          version: 1,
        },
      ]);

      await expect(
        service.reserveTransaction({ ...baseInput, currency: 'USD' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('obligation locking and validation', () => {
    it('throws NotFoundException when Obligation is specified but not found', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'pay-123',
            amount: 10000,
            currency: 'USD',
            status: PaymentStatus.SUCCEEDED,
            version: 1,
          },
        ])
        .mockResolvedValueOnce([]);

      await expect(
        service.reserveTransaction({
          ...baseInput,
          cancellationRefundObligationId: 'ob-999',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when Obligation belongs to a different payment', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'pay-123',
            amount: 10000,
            currency: 'USD',
            status: PaymentStatus.SUCCEEDED,
            version: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'ob-1',
            paymentId: 'other-payment',
            totalAmount: 5000,
            currency: 'USD',
          },
        ]);

      await expect(
        service.reserveTransaction({
          ...baseInput,
          cancellationRefundObligationId: 'ob-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when Obligation currency mismatches', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'pay-123',
            amount: 10000,
            currency: 'USD',
            status: PaymentStatus.SUCCEEDED,
            version: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'ob-1',
            paymentId: 'pay-123',
            totalAmount: 5000,
            currency: 'GBP',
          },
        ]);

      await expect(
        service.reserveTransaction({
          ...baseInput,
          cancellationRefundObligationId: 'ob-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('idempotency key reuse', () => {
    const expectedHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          paymentId: baseInput.paymentId,
          obligationId: baseInput.cancellationRefundObligationId,
          amount: baseInput.amount,
          currency: baseInput.currency,
          reason: baseInput.reason,
        }),
      )
      .digest('hex');

    beforeEach(() => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'pay-123',
          amount: 10000,
          currency: 'USD',
          status: PaymentStatus.SUCCEEDED,
          version: 1,
        },
      ]);
    });

    it.each([
      RefundStatus.REFUND_PENDING,
      RefundStatus.REFUND_PROCESSING,
      RefundStatus.REFUND_RETRY_SCHEDULED,
      RefundStatus.SUCCEEDED,
    ])(
      'returns existing refund immediately if idempotency key exists and status is %s',
      async (status) => {
        const existingRefund = {
          id: 'ref-existing',
          paymentId: 'pay-123',
          idempotencyKeyId: 'key-rec-1',
          amount: 5000,
          currency: 'USD',
          status,
        };

        mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({
          id: 'key-rec-1',
          key: 'idem-key-abc',
          requestHash: expectedHash,
        });
        mockPrisma.refund.findUnique.mockResolvedValueOnce(existingRefund);

        const result = await service.reserveTransaction(baseInput);

        expect(result).toBe(existingRefund);
        expect(mockPrisma.refund.create).not.toHaveBeenCalled();
      },
    );

    it('throws BadRequestException when idempotency key is reused with different amount, currency, reason, or payment', async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValueOnce({
        id: 'key-rec-1',
        key: 'idem-key-abc',
        requestHash: 'different-hash',
      });

      await expect(service.reserveTransaction(baseInput)).rejects.toThrow(
        new BadRequestException('Idempotency key reuse with different payload'),
      );
      expect(mockPrisma.refund.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.refund.create).not.toHaveBeenCalled();
    });
  });

  describe('capacity calculations against Payment and Obligation', () => {
    beforeEach(() => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
    });

    it('rejects requested refund when amount exceeds payment capacity', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'pay-123',
          amount: 10000,
          currency: 'USD',
          status: PaymentStatus.SUCCEEDED,
          version: 1,
        },
      ]);

      mockPrisma.refund.findMany.mockResolvedValueOnce([
        { id: 'ref-1', amount: 6000, status: RefundStatus.SUCCEEDED },
        { id: 'ref-2', amount: 3000, status: RefundStatus.REFUND_PENDING },
      ]);

      // payment: 10000, used: 9000 (6000 + 3000), remaining: 1000. Request: 2000 -> reject
      await expect(
        service.reserveTransaction({ ...baseInput, amount: 2000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('ignores terminal failed refunds in payment capacity calculation', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'pay-123',
          amount: 10000,
          currency: 'USD',
          status: PaymentStatus.SUCCEEDED,
          version: 1,
        },
      ]);

      mockPrisma.refund.findMany.mockResolvedValueOnce([
        { id: 'ref-1', amount: 4000, status: RefundStatus.SUCCEEDED },
        { id: 'ref-2', amount: 3000, status: RefundStatus.FAILED },
        {
          id: 'ref-3',
          amount: 2000,
          status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
        },
      ]);

      mockPrisma.idempotencyKey.create.mockResolvedValueOnce({
        id: 'key-new',
        key: 'idem-key-abc',
      });
      mockPrisma.refund.create.mockResolvedValueOnce({
        id: 'ref-new',
        paymentId: 'pay-123',
        amount: 6000,
        currency: 'USD',
        status: RefundStatus.REFUND_PENDING,
      });

      // payment: 10000, used: 4000 (since failed/attention are ignored), remaining: 6000. Request: 6000 -> succeed
      const result = await service.reserveTransaction({
        ...baseInput,
        amount: 6000,
      });
      expect(result.id).toBe('ref-new');
    });

    it('rejects requested refund when amount exceeds obligation capacity', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'pay-123',
            amount: 20000,
            currency: 'USD',
            status: PaymentStatus.SUCCEEDED,
            version: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'ob-1',
            paymentId: 'pay-123',
            totalAmount: 8000,
            currency: 'USD',
          },
        ]);

      // Payment capacity refunds
      mockPrisma.refund.findMany
        .mockResolvedValueOnce([]) // payment refunds
        .mockResolvedValueOnce([
          // obligation refunds: 5000 succeeded, 2000 processing -> 1000 remaining
          { id: 'ref-ob-1', amount: 5000, status: RefundStatus.SUCCEEDED },
          {
            id: 'ref-ob-2',
            amount: 2000,
            status: RefundStatus.REFUND_PROCESSING,
          },
        ]);

      await expect(
        service.reserveTransaction({
          ...baseInput,
          cancellationRefundObligationId: 'ob-1',
          amount: 2000,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('tracks active and successful refunds across payment and obligation and creates refund reservation', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'pay-123',
            amount: 20000,
            currency: 'USD',
            status: PaymentStatus.SUCCEEDED,
            version: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'ob-1',
            paymentId: 'pay-123',
            totalAmount: 10000,
            currency: 'USD',
          },
        ]);

      mockPrisma.refund.findMany
        .mockResolvedValueOnce([
          { id: 'ref-1', amount: 5000, status: RefundStatus.SUCCEEDED },
          {
            id: 'ref-2',
            amount: 3000,
            status: RefundStatus.REFUND_RETRY_SCHEDULED,
          },
        ])
        .mockResolvedValueOnce([
          { id: 'ref-ob-1', amount: 3000, status: RefundStatus.SUCCEEDED },
        ]);

      mockPrisma.idempotencyKey.create.mockResolvedValueOnce({
        id: 'key-new',
        key: 'idem-key-abc',
      });

      const created = {
        id: 'ref-created-1',
        paymentId: 'pay-123',
        cancellationRefundObligationId: 'ob-1',
        idempotencyKeyId: 'key-new',
        amount: 4000,
        currency: 'USD',
        reason: 'Customer cancellation',
        triggerType: RefundTriggerType.USER,
        triggeredByUserId: 'user-123',
        status: RefundStatus.REFUND_PENDING,
      };
      mockPrisma.refund.create.mockResolvedValueOnce(created);

      const result = await service.reserveTransaction({
        ...baseInput,
        cancellationRefundObligationId: 'ob-1',
        amount: 4000,
      });

      expect(result).toEqual(created);
      expect(mockPrisma.idempotencyKey.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          key: 'idem-key-abc',
          customerId: 'user-123',
          requestPath: '/api/refund/reserve',
        }),
      });
      expect(mockPrisma.refund.create).toHaveBeenCalledWith({
        data: {
          paymentId: 'pay-123',
          bookingId: null,
          cancellationRefundObligationId: 'ob-1',
          idempotencyKeyId: 'key-new',
          amount: 4000,
          currency: 'USD',
          reason: baseInput.reason,
          triggerType: RefundTriggerType.USER,
          triggeredByUserId: 'user-123',
          status: RefundStatus.REFUND_PENDING,
          idempotencyKeyCreatedAt: expect.any(Date),
        },
      });
    });

    it('falls back to bookingIntent userId when actorId is not provided', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'pay-123',
          amount: 10000,
          currency: 'USD',
          status: PaymentStatus.SUCCEEDED,
          version: 1,
        },
      ]);
      mockPrisma.refund.findMany.mockResolvedValueOnce([]);
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'pay-123',
        bookingIntent: { userId: 'booking-owner-id' },
      });
      mockPrisma.idempotencyKey.create.mockResolvedValueOnce({
        id: 'key-new-2',
        key: 'idem-key-xyz',
      });
      mockPrisma.refund.create.mockResolvedValueOnce({
        id: 'ref-xyz',
        status: RefundStatus.REFUND_PENDING,
      });

      await service.reserveTransaction({
        paymentId: 'pay-123',
        amount: 2000,
        currency: 'USD',
        reason: 'System auto-refund',
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        idempotencyKey: 'idem-key-xyz',
      });

      expect(mockPrisma.idempotencyKey.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          customerId: 'booking-owner-id',
        }),
      });
    });
  });
});
