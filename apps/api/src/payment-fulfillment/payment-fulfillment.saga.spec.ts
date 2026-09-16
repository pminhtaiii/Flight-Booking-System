import 'reflect-metadata';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BookingFailureReason } from '@prisma/client';
import { PaymentFulfillmentSaga } from './payment-fulfillment.saga';
import {
  PaymentGatewayPort,
  FulfillmentGatewayPort,
  PortInvocationControl,
} from './ports';
import { PaymentIdempotencyService, SagaOwnership } from '@/idempotency/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { BookingPassengerFinalValidatorService } from '@/booking-intent/booking-passenger-final-validator.service';
import { ConfirmPaymentDto } from '@/payment/dto/confirm-payment.dto';

describe('PaymentFulfillmentSaga', () => {
  let saga: PaymentFulfillmentSaga;
  let mockPaymentGateway: {
    authorizeHold: jest.Mock;
    capturePayment: jest.Mock;
    voidHold: jest.Mock;
  };
  let mockFulfillmentGateway: {
    createOrder: jest.Mock;
    cancelOrder: jest.Mock;
    retrieveOrderSnapshot: jest.Mock;
  };
  let mockIdempotency: {
    computeHash: jest.Mock;
    acquireOrReplay: jest.Mock;
    assertOwned: jest.Mock;
    getResumePoint: jest.Mock;
    advanceSagaCheckpoint: jest.Mock;
    completeSagaKeyAtomic: jest.Mock;
  };
  let mockPaymentMethod: {
    saveMethod: jest.Mock;
  };
  let mockBookingLifecycle: {
    createBooking: jest.Mock;
    updateToConfirmed: jest.Mock;
    updateToFailed: jest.Mock;
  };
  let mockPrisma: any;
  let mockAudit: {
    createLog: jest.Mock;
  };
  let mockValidator: {
    validateAndMapPassengers: jest.Mock;
  };

  const userId = 'user-123';
  const idempotencyKey = 'idemp-key-123';
  const bookingId = '123e4567-e89b-42d3-a456-426614174000';
  const paymentId = 'pay-123';
  const dto: ConfirmPaymentDto = {
    bookingId,
    paymentId,
  };

  const baseBookingIntent = {
    id: 'intent-123',
    userId,
    duffelOfferId: 'off-123',
    paymentAttemptCount: 1,
    confirmedPrice: 15000,
    currency: 'USD',
    status: 'AWAITING_PAYMENT',
    passengers: [
      {
        id: 'p-1',
        givenName: 'Ada',
        familyName: 'Lovelace',
        firstName: 'Ada',
        lastName: 'Lovelace',
        dateOfBirth: new Date('1990-01-01'),
        passengerType: 'adult',
        type: 'ADULT' as any,
        title: 'ms',
        email: 'ada@example.com',
        phoneNumber: '+15551234567',
      },
    ],
    user: { email: 'ada@example.com' },
  };

  const basePayment = {
    id: paymentId,
    bookingIntentId: 'intent-123',
    stripePaymentIntentId: 'pi-123',
    stripeCustomerId: 'cus-123',
    status: 'CREATED',
    amount: 15000,
    currency: 'USD',
    ancillarySelectionId: null,
    ancillarySelectionVersion: null,
    ancillarySelection: null,
    bookingIntent: baseBookingIntent,
  };

  const baseSnapshots = {
    flightSnapshot: {
      segments: [
        {
          departureAt: '2026-10-15T08:00:00Z',
          origin: { iata_code: 'JFK' },
          destination: { iata_code: 'LHR' },
        },
      ],
    },
    passengerSnapshot: {
      passengers: [{ id: 'p-1', firstName: 'Ada', lastName: 'Lovelace' }],
    },
    departureAt: new Date('2026-10-15T08:00:00Z'),
  };

  beforeEach(() => {
    mockPaymentGateway = {
      authorizeHold: jest.fn().mockImplementation(async (_id: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        return {
          status: 'authorized',
          intentId: 'pi-123',
          amount: 15000,
          currency: 'USD',
          rawStatus: 'requires_capture',
        };
      }),
      capturePayment: jest.fn().mockImplementation(async (_id: string, _key: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        return {
          success: true,
          intentId: 'pi-123',
          status: 'succeeded',
          capturedAmount: 15000,
          currency: 'USD',
        };
      }),
      voidHold: jest.fn().mockImplementation(async (_id: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        return {
          success: true,
          intentId: 'pi-123',
          status: 'canceled',
        };
      }),
    };

    mockFulfillmentGateway = {
      createOrder: jest.fn().mockImplementation(async (_input: any, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        return {
          orderId: 'ord-123',
          bookingReference: 'PNR123',
          evidence: {
            id: 'ord-123',
            bookingReference: 'PNR123',
            booking_reference: 'PNR123',
          },
        };
      }),
      cancelOrder: jest.fn().mockImplementation(async (_id: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        return {
          success: true,
          orderId: 'ord-123',
          status: 'CANCELLED',
        };
      }),
      retrieveOrderSnapshot: jest.fn().mockImplementation(async (_id: string, _ev: any, _p: any, _e: any, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        return baseSnapshots;
      }),
    };

    mockIdempotency = {
      computeHash: jest.fn().mockReturnValue('hash-123'),
      acquireOrReplay: jest.fn().mockResolvedValue({
        status: 'acquired',
        lockedAt: new Date('2026-09-16T12:00:00Z'),
      }),
      assertOwned: jest.fn().mockResolvedValue(undefined),
      getResumePoint: jest.fn().mockResolvedValue('started'),
      advanceSagaCheckpoint: jest.fn().mockResolvedValue(undefined),
      completeSagaKeyAtomic: jest.fn().mockResolvedValue(undefined),
    };

    mockPaymentMethod = {
      saveMethod: jest.fn().mockResolvedValue({ id: 'pm-1' }),
    };

    mockBookingLifecycle = {
      createBooking: jest.fn().mockResolvedValue({
        id: bookingId,
        userId,
        bookingIntentId: 'intent-123',
        status: 'PROCESSING',
      }),
      updateToConfirmed: jest.fn().mockResolvedValue({
        id: bookingId,
        status: 'CONFIRMED',
      }),
      updateToFailed: jest.fn().mockResolvedValue({
        id: bookingId,
        status: 'FAILED',
      }),
    };

    mockPrisma = {
      $transaction: jest.fn(async (callback: (tx: any) => Promise<any>) => callback(mockPrisma)),
      payment: {
        findUnique: jest.fn().mockResolvedValue(JSON.parse(JSON.stringify(basePayment))),
        findFirst: jest.fn().mockResolvedValue(JSON.parse(JSON.stringify(basePayment))),
        update: jest.fn().mockResolvedValue(JSON.parse(JSON.stringify(basePayment))),
      },
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue(JSON.parse(JSON.stringify(baseBookingIntent))),
        update: jest.fn().mockResolvedValue(JSON.parse(JSON.stringify(baseBookingIntent))),
      },
      booking: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({ id: bookingId, paymentId }),
      },
      paymentEvent: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pe-1',
          paymentId,
          eventType: 'duffel_order_created',
          metadata: {
            id: 'ord-123',
            bookingReference: 'PNR123',
            booking_reference: 'PNR123',
          },
        }),
        create: jest.fn().mockResolvedValue({ id: 'pe-created' }),
      },
      ledgerEntry: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    mockAudit = {
      createLog: jest.fn().mockResolvedValue({}),
    };

    mockValidator = {
      validateAndMapPassengers: jest.fn().mockReturnValue([
        {
          id: 'p-1',
          firstName: 'Ada',
          lastName: 'Lovelace',
          dateOfBirth: '1990-01-01',
          type: 'adult',
        },
      ]),
    };

    saga = new PaymentFulfillmentSaga(
      mockPaymentGateway as unknown as PaymentGatewayPort,
      mockFulfillmentGateway as unknown as FulfillmentGatewayPort,
      mockIdempotency as unknown as PaymentIdempotencyService,
      mockPaymentMethod as unknown as PaymentMethodService,
      mockBookingLifecycle as unknown as BookingLifecycleService,
      mockPrisma as unknown as PrismaService,
      mockAudit as unknown as AuditService,
      mockValidator as unknown as BookingPassengerFinalValidatorService,
    );
    saga.timeoutMs = 1000;
  });

  describe('4-Stage Happy Path Pipeline', () => {
    it('executes all 4 stages sequentially, persisting checkpoints and completing key atomically', async () => {
      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as any;

      // 1. Idempotency acquisition
      expect(mockIdempotency.acquireOrReplay).toHaveBeenCalledWith(
        idempotencyKey,
        'hash-123',
        userId,
        '/api/bookings/payment/confirm',
      );

      // 2. Canonical booking created
      expect(mockBookingLifecycle.createBooking).toHaveBeenCalledWith(
        userId,
        bookingId,
        'intent-123',
        paymentId,
      );

      // 3. Stage 1: authorizeHold
      expect(mockPaymentGateway.authorizeHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: paymentId },
          data: { status: 'AUTHORIZED' },
        }),
      );
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'stripe_authorized',
      );

      // 4. Stage 2: passenger validation & fulfillment createOrder
      expect(mockValidator.validateAndMapPassengers).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'intent-123' }),
        expect.anything(),
      );
      expect(mockFulfillmentGateway.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          offerId: 'off-123',
          idempotencyKey,
          metadata: { bookingIntentId: 'intent-123', paymentId },
        }),
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            paymentId,
            eventType: 'duffel_order_created',
          }),
        }),
      );
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'duffel_order_created',
      );

      // 5. Stage 3: capturePayment
      expect(mockPaymentGateway.capturePayment).toHaveBeenCalledWith(
        'pi-123',
        `${idempotencyKey}-stripe-capture`,
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'captured',
      );

      // 6. Stage 4: retrieveOrderSnapshot, updateToConfirmed, ledger entries, saveMethod, completeSagaKeyAtomic
      expect(mockFulfillmentGateway.retrieveOrderSnapshot).toHaveBeenCalledWith(
        'ord-123',
        expect.objectContaining({ id: 'ord-123' }),
        expect.any(Array),
        'ada@example.com',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: paymentId },
          data: { status: 'SUCCEEDED' },
        }),
      );
      expect(mockBookingLifecycle.updateToConfirmed).toHaveBeenCalledWith(
        bookingId,
        'PNR123',
        'ord-123',
        baseSnapshots.flightSnapshot,
        baseSnapshots.passengerSnapshot,
        mockPrisma,
      );
      expect(mockPrisma.ledgerEntry.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            paymentId,
            accountId: 'CUSTOMER_RECEIVABLE',
            entryType: 'DEBIT',
            amount: 15000,
          }),
          expect.objectContaining({
            paymentId,
            accountId: 'PLATFORM_REVENUE',
            entryType: 'CREDIT',
            amount: 15000,
          }),
        ],
      });
      expect(mockPaymentMethod.saveMethod).toHaveBeenCalledWith(userId, 'cus-123', 'pi-123');
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.OK,
        expect.objectContaining({
          success: true,
          paymentId,
          status: 'SUCCEEDED',
          bookingReference: 'PNR123',
          duffelOrderId: 'ord-123',
        }),
      );

      expect(result).toEqual({
        success: true,
        paymentId,
        status: 'SUCCEEDED',
        bookingReference: 'PNR123',
        duffelOrderId: 'ord-123',
      });
    });

    it('returns replay response directly when idempotency status is replay', async () => {
      const replayPayload = {
        success: true,
        paymentId,
        status: 'SUCCEEDED',
        bookingReference: 'PNR-REPLAY',
        duffelOrderId: 'ord-replay',
      };
      mockIdempotency.acquireOrReplay.mockResolvedValueOnce({
        status: 'replay',
        responseCode: 200,
        responseBody: JSON.stringify(replayPayload),
      });

      const result = await saga.confirmPayment(dto, idempotencyKey, userId);

      expect(result).toEqual(replayPayload);
      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
    });
  });

  describe('25-Second Handoff & Background Execution', () => {
    it('returns 202/PENDING when timeout fires before confirmation finishes, while background continues', async () => {
      saga.timeoutMs = 20;

      // Slow down createOrder to exceed 20ms
      mockFulfillmentGateway.createOrder.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          orderId: 'ord-slow',
          bookingReference: 'PNR-SLOW',
          evidence: { id: 'ord-slow', bookingReference: 'PNR-SLOW' },
        }), 60)),
      );

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as any;

      expect(result).toEqual({
        success: true,
        status: 'PENDING',
        message: 'Booking is being confirmed. Please poll status.',
        pollUrl: `/api/bookings/payment/${paymentId}/status`,
      });

      // Wait for background promise to complete
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(mockPaymentGateway.capturePayment).toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.OK,
        expect.objectContaining({
          success: true,
          status: 'SUCCEEDED',
        }),
      );
    });

    it('invokes handleBackgroundError when background confirmation rejects after handoff', async () => {
      saga.timeoutMs = 15;

      // Slow down and then reject
      mockFulfillmentGateway.createOrder.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('Duffel network drop')), 40)),
      );

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as any;

      expect(result.status).toBe('PENDING');

      // Wait for background error handling
      await new Promise((resolve) => setTimeout(resolve, 80));

      // handleBackgroundError should compensate
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalled();
    });
  });

  describe('Preflight Ownership Assertion (assertOwned rejection)', () => {
    it('halts immediately if assertOwned rejects before paymentGateway.authorizeHold', async () => {
      mockPaymentGateway.authorizeHold.mockImplementation(
        async (_id: string, control: PortInvocationControl) => {
          await control.beforeInvoke();
          return { status: 'authorized', intentId: 'pi-123' };
        },
      );
      mockIdempotency.assertOwned.mockRejectedValueOnce(
        new ConflictException('Idempotency key ownership lost'),
      );

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
      expect(mockIdempotency.advanceSagaCheckpoint).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
    });

    it('halts immediately if assertOwned rejects before fulfillmentGateway.createOrder without compensating', async () => {
      mockFulfillmentGateway.createOrder.mockImplementation(
        async (_input: any, control: PortInvocationControl) => {
          await control.beforeInvoke();
          return { orderId: 'ord-123', bookingReference: 'PNR', evidence: { id: 'ord-123' } };
        },
      );
      // Stage 1 passes, but Stage 2 ownership check fails
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // Stage 1 authorizeHold
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // Stage 2 createOrder

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      // Void hold must NOT be called on lost ownership
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
    });

    it('halts immediately if assertOwned rejects before paymentGateway.capturePayment without destructive cancellation', async () => {
      mockPaymentGateway.capturePayment.mockImplementation(
        async (_id: string, _key: string, control: PortInvocationControl) => {
          await control.beforeInvoke();
          return { success: true, intentId: 'pi-123', status: 'succeeded' };
        },
      );
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // authorizeHold
        .mockResolvedValueOnce(undefined) // createOrder
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // capturePayment

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
    });

    it('halts immediately if assertOwned rejects during compensation', async () => {
      mockFulfillmentGateway.createOrder.mockImplementationOnce(
        async (_input: any, control: PortInvocationControl) => {
          await control.beforeInvoke();
          throw new Error('Airline rejected request');
        },
      );
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // authorizeHold
        .mockResolvedValueOnce(undefined) // createOrder preflight
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // voidHold compensation preflight

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockPrisma.payment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });
  });

  describe('Stage 2 Failure & Passenger Validation Compensation', () => {
    it('compensates via voidHold and cancels payment/booking when Duffel createOrder fails', async () => {
      mockFulfillmentGateway.createOrder.mockRejectedValueOnce(
        new Error('Offer sold out'),
      );

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      // Void hold called
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );

      // Status transitioned to CANCELLED / FAILED
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: paymentId },
          data: { status: 'CANCELLED' },
        }),
      );
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalledWith(
        bookingId,
        BookingFailureReason.SYSTEM_ERROR,
        undefined,
        undefined,
        undefined,
        mockPrisma,
      );

      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Offer sold out'),
        }),
      );
    });

    it('compensates via voidHold and cancels payment when passenger validation fails', async () => {
      mockValidator.validateAndMapPassengers.mockImplementationOnce(() => {
        throw new UnprocessableEntityException({
          code: 'DOCUMENT_EXPIRED',
          message: 'Passport expired',
        });
      });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: paymentId },
          data: { status: 'CANCELLED' },
        }),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.UNPROCESSABLE_ENTITY,
        expect.objectContaining({
          code: 'DOCUMENT_EXPIRED',
          success: false,
        }),
      );
    });
  });

  describe('Stage 3 Capture Failure & Reconciliation Matrix', () => {
    it('compensates destructively (cancelOrder + voidHold) when capture fails and reconciles to authorized', async () => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Stripe timeout'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        }) // Stage 1
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
          rawStatus: 'requires_capture',
        }); // Reconciliation in Stage 3

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith(
        'ord-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockFulfillmentGateway.retrieveOrderSnapshot).toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalledWith(
        bookingId,
        BookingFailureReason.CAPTURE_FAILED,
        baseSnapshots.flightSnapshot,
        baseSnapshots.passengerSnapshot,
        expect.any(Date),
        mockPrisma,
      );
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Stripe capture failed'),
        }),
      );
    });

    it('does NOT compensate if capture fails but reconciles to captured/succeeded (continues to Stage 4)', async () => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Network disconnect on return'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        }) // Stage 1
        .mockResolvedValueOnce({
          status: 'captured',
          intentId: 'pi-123',
          rawStatus: 'succeeded',
        }); // Reconciliation in Stage 3

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as any;

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'captured',
      );
      expect(result.status).toBe('SUCCEEDED');
    });

    it('throws 502 without destructive compensation if capture reconciliation is nonfinal or unavailable', async () => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Stripe 500'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        }) // Stage 1
        .mockResolvedValueOnce({
          status: 'nonfinal',
          intentId: 'pi-123',
          rawStatus: 'processing',
        }); // Reconciliation in Stage 3: nonfinal!

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      // Must NOT cancel order or release hold
      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
    });
  });

  describe('Nonfatal Payment Method Saving', () => {
    it('does not abort confirmPayment if paymentMethodService.saveMethod throws', async () => {
      mockPaymentMethod.saveMethod.mockRejectedValueOnce(new Error('Stripe Customer not found'));

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as any;

      expect(result.status).toBe('SUCCEEDED');
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.OK,
        expect.objectContaining({ status: 'SUCCEEDED' }),
      );
    });
  });

  describe('Checkpoint Resume Capabilities', () => {
    it('skips Stage 1 and Stage 2 when resuming from captured', async () => {
      mockIdempotency.getResumePoint.mockResolvedValueOnce('captured');
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as any;

      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.capturePayment).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToConfirmed).toHaveBeenCalled();
      expect(result.status).toBe('SUCCEEDED');
    });

    it('returns reconstructed success response when recoveryPoint is completed and payment is SUCCEEDED', async () => {
      mockIdempotency.getResumePoint.mockResolvedValueOnce('completed');
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'SUCCEEDED',
      });

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as any;

      expect(result).toEqual({
        success: true,
        paymentId,
        status: 'SUCCEEDED',
        bookingReference: 'PNR123',
        duffelOrderId: 'ord-123',
      });
      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
    });
  });

  describe('handleBackgroundError', () => {
    const ownership: SagaOwnership = {
      key: idempotencyKey,
      userId,
      requestPath: '/api/bookings/payment/confirm',
      requestHash: 'hash-123',
      lockedAt: new Date('2026-09-16T12:00:00Z'),
    };

    it('returns early if payment is already in terminal state', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'SUCCEEDED',
      });

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('error'));

      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
    });

    it('advances checkpoint to captured and halts destructive actions if paymentIntent is already captured', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'captured',
        intentId: 'pi-123',
      });

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('error'));

      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(ownership, 'captured');
      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
    });

    it('compensates via cancelOrder and voidHold when paymentIntent is authorized', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'authorized',
        intentId: 'pi-123',
      });

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith(
        'ord-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        ownership,
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('background crash'),
        }),
      );
    });

    it('halts without action if assertOwned rejects during background recovery', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.authorizeHold.mockImplementation(
        async (_id: string, control: PortInvocationControl) => {
          await control.beforeInvoke();
          return { status: 'authorized', intentId: 'pi-123' };
        },
      );
      mockIdempotency.assertOwned.mockRejectedValueOnce(
        new ConflictException('Idempotency key ownership lost'),
      );

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
    });
  });
});
