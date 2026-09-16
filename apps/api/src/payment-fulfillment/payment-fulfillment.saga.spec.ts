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

interface ConfirmPaymentResult {
  success?: boolean;
  status?: string;
  message?: string;
  pollUrl?: string;
  paymentId?: string;
  bookingReference?: string;
  duffelOrderId?: string;
  error?: string;
  bookingStatus?: string;
}

interface MockPrisma {
  $transaction: jest.Mock;
  payment: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  paymentEvent: {
    create: jest.Mock;
    findFirst: jest.Mock;
  };
  bookingIntent: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  booking: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
  };
  ledgerEntry: {
    createMany: jest.Mock;
  };
}

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
  let mockPrisma: MockPrisma;
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
        type: 'ADULT',
        title: 'ms',
        email: 'ada@example.com',
        phoneNumber: '+15551234567',
      },
    ],
    user: { email: 'ada@example.com' },
  };

  const basePayment = {
    id: paymentId,
    amount: 15000,
    currency: 'USD',
    status: 'CREATED',
    stripePaymentIntentId: 'pi-123',
    stripeCustomerId: 'cus-123',
    bookingIntentId: 'intent-123',
    ancillarySelectionId: 'anc-123',
    ancillarySelectionVersion: 1,
    bookingIntent: baseBookingIntent,
    ancillarySelection: {
      id: 'anc-123',
      version: 1,
      status: 'PAYMENT_BOUND',
      seatSelections: [{ serviceId: 'seat-1' }],
      baggageSelections: [{ serviceId: 'bag-1', quantity: 1 }],
    },
  };

  const baseSnapshots = {
    flightSnapshot: {
      slices: [],
      segments: [{ departureAt: '2026-10-01T10:00:00Z' }],
    },
    passengerSnapshot: {
      passengers: [{ id: 'p-1', name: 'Ada Lovelace' }],
    },
    departureAt: new Date('2026-10-01T10:00:00Z'),
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
      createOrder: jest.fn().mockImplementation(async (_input: unknown, control?: PortInvocationControl) => {
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
      retrieveOrderSnapshot: jest.fn().mockImplementation(
        async (_id: string, _ev: unknown, _p: unknown, _e: unknown, control?: PortInvocationControl) => {
          if (control?.beforeInvoke) await control.beforeInvoke();
          return baseSnapshots;
        },
      ),
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
      saveMethod: jest.fn().mockResolvedValue(undefined),
    };

    mockBookingLifecycle = {
      createBooking: jest.fn().mockResolvedValue({
        id: bookingId,
        userId,
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

    const currentPaymentState = JSON.parse(JSON.stringify(basePayment));
    mockPrisma = {
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(mockPrisma)),
      payment: {
        findUnique: jest.fn().mockImplementation(async () => JSON.parse(JSON.stringify(currentPaymentState))),
        findFirst: jest.fn().mockImplementation(async () => JSON.parse(JSON.stringify(currentPaymentState))),
        update: jest.fn().mockImplementation(async (args: { data?: Record<string, unknown> }) => {
          if (args?.data) {
            Object.assign(currentPaymentState, args.data);
          }
          return JSON.parse(JSON.stringify(currentPaymentState));
        }),
        updateMany: jest.fn().mockImplementation(async (args: { data?: Record<string, unknown> }) => {
          if (args?.data) {
            Object.assign(currentPaymentState, args.data);
          }
          return { count: 1 };
        }),
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
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'event-1',
          eventType: 'duffel_order_created',
          metadata: {
            id: 'ord-123',
            bookingReference: 'PNR123',
            booking_reference: 'PNR123',
          },
        }),
      },
      ledgerEntry: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    mockAudit = {
      createLog: jest.fn().mockResolvedValue(undefined),
    };

    mockValidator = {
      validateAndMapPassengers: jest.fn().mockReturnValue([
        {
          id: 'p-1',
          givenName: 'Ada',
          familyName: 'Lovelace',
          bornOn: '1990-01-01',
          passengerType: 'adult',
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
      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(mockIdempotency.acquireOrReplay).toHaveBeenCalledWith(
        idempotencyKey,
        'hash-123',
        userId,
        '/api/bookings/payment/confirm',
      );

      expect(mockBookingLifecycle.createBooking).toHaveBeenCalledWith(
        userId,
        bookingId,
        'intent-123',
        paymentId,
      );

      expect(mockPaymentGateway.authorizeHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'stripe_authorized',
      );

      expect(mockFulfillmentGateway.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          offerId: 'off-123',
          idempotencyKey,
          services: [
            { serviceId: 'seat-1', quantity: 1 },
            { serviceId: 'bag-1', quantity: 1 },
          ],
        }),
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'duffel_order_created',
      );

      expect(mockPaymentGateway.capturePayment).toHaveBeenCalledWith(
        'pi-123',
        `${idempotencyKey}-stripe-capture`,
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'captured',
      );

      expect(mockFulfillmentGateway.retrieveOrderSnapshot).toHaveBeenCalledWith(
        'ord-123',
        expect.anything(),
        expect.any(Array),
        'ada@example.com',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockBookingLifecycle.updateToConfirmed).toHaveBeenCalledWith(
        bookingId,
        'PNR123',
        'ord-123',
        baseSnapshots.flightSnapshot,
        baseSnapshots.passengerSnapshot,
        expect.anything(),
      );
      expect(mockPrisma.ledgerEntry.createMany).toHaveBeenCalled();
      expect(mockPaymentMethod.saveMethod).toHaveBeenCalledWith(userId, 'cus-123', 'pi-123');
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.OK,
        expect.objectContaining({
          success: true,
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

    it('returns cached replay body when key has already been executed', async () => {
      mockIdempotency.acquireOrReplay.mockResolvedValueOnce({
        status: 'replay',
        responseCode: 200,
        responseBody: JSON.stringify({
          success: true,
          paymentId,
          status: 'SUCCEEDED',
          replayed: true,
        }),
      });

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(result.status).toBe('SUCCEEDED');
      expect((result as Record<string, unknown>).replayed).toBe(true);
      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException if payment does not belong to the user', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        bookingIntent: { ...baseBookingIntent, userId: 'other-user' },
      });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        'You do not own this payment',
      );
      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
    });
  });

  describe('25-Second Handoff & Background Execution Invariant', () => {
    it('returns 202 PENDING when execution exceeds timeoutMs, while continuing in background', async () => {
      saga.timeoutMs = 15;

      mockFulfillmentGateway.createOrder.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          orderId: 'ord-slow',
          bookingReference: 'PNR-SLOW',
          evidence: { id: 'ord-slow', bookingReference: 'PNR-SLOW' },
        }), 60)),
      );

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(result).toEqual({
        success: true,
        status: 'PENDING',
        message: 'Booking is being confirmed. Please poll status.',
        pollUrl: `/api/bookings/payment/${paymentId}/status`,
      });

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

      mockFulfillmentGateway.createOrder.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('Duffel network drop')), 40)),
      );

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(result.status).toBe('PENDING');

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
    });
  });

  describe('Fenced Ownership Assertion & Preflight Checks', () => {
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

      expect(mockIdempotency.advanceSagaCheckpoint).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
    });

    it('halts immediately without DB update if assertOwned rejects after authorizeHold', async () => {
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // Preflight in authorizeHold
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // Post-provider check

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockIdempotency.advanceSagaCheckpoint).not.toHaveBeenCalled();
    });

    it('halts immediately if assertOwned rejects before fulfillmentGateway.createOrder without compensating', async () => {
      mockFulfillmentGateway.createOrder.mockImplementation(
        async (_input: unknown, control: PortInvocationControl) => {
          await control.beforeInvoke();
          return { orderId: 'ord-123', bookingReference: 'PNR', evidence: { id: 'ord-123' } };
        },
      );
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // Stage 1 preflight
        .mockResolvedValueOnce(undefined) // Stage 1 post-provider
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // Stage 2 preflight

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
    });

    it('halts immediately without event creation if assertOwned rejects after fulfillmentGateway.createOrder', async () => {
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // Stage 1 preflight
        .mockResolvedValueOnce(undefined) // Stage 1 post-provider
        .mockResolvedValueOnce(undefined) // Stage 2 preflight
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // Stage 2 post-provider

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ eventType: 'duffel_order_created' }) }),
      );
      expect(mockPaymentGateway.capturePayment).not.toHaveBeenCalled();
    });

    it('halts immediately if assertOwned rejects before paymentGateway.capturePayment without destructive cancellation', async () => {
      mockPaymentGateway.capturePayment.mockImplementation(
        async (_id: string, _key: string, control: PortInvocationControl) => {
          await control.beforeInvoke();
          return { success: true, intentId: 'pi-123', status: 'succeeded' };
        },
      );
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // authorizeHold preflight
        .mockResolvedValueOnce(undefined) // authorizeHold post-provider
        .mockResolvedValueOnce(undefined) // createOrder preflight
        .mockResolvedValueOnce(undefined) // createOrder post-provider
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // capturePayment preflight

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
    });

    it('halts immediately if assertOwned rejects during compensation', async () => {
      mockFulfillmentGateway.createOrder.mockImplementationOnce(
        async (_input: unknown, control: PortInvocationControl) => {
          await control.beforeInvoke();
          throw new Error('Airline rejected request');
        },
      );
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // authorizeHold preflight
        .mockResolvedValueOnce(undefined) // authorizeHold post-provider
        .mockResolvedValueOnce(undefined) // createOrder preflight
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // voidHold compensation preflight

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('Compensation Matrix', () => {
    it('compensates via voidHold and marks booking FAILED when final passenger validation throws', async () => {
      mockValidator.validateAndMapPassengers.mockImplementationOnce(() => {
        throw new UnprocessableEntityException('Passenger passport expired');
      });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalledWith(
        bookingId,
        BookingFailureReason.SYSTEM_ERROR,
        undefined,
        undefined,
        undefined,
        expect.anything(),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.UNPROCESSABLE_ENTITY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Passenger passport expired'),
        }),
      );
    });

    it('compensates via voidHold and marks booking FAILED when Duffel order creation fails', async () => {
      mockFulfillmentGateway.createOrder.mockRejectedValueOnce(new Error('Seats unavailable'));

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPaymentGateway.capturePayment).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalledWith(
        bookingId,
        BookingFailureReason.SYSTEM_ERROR,
        undefined,
        undefined,
        undefined,
        expect.anything(),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Seats unavailable'),
        }),
      );
    });

    it('compensates when capturePayment returns success: false with requires_capture status without throwing', async () => {
      mockPaymentGateway.capturePayment.mockResolvedValueOnce({
        success: false,
        intentId: 'pi-123',
        status: 'requires_capture',
      });
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
          rawStatus: 'requires_capture',
        });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(HttpException);

      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith('ord-123', expect.any(Object));
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith('pi-123', expect.any(Object));
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalled();
    });

    it('compensates via cancelOrder and voidHold when capture fails and reconciles to authorized/requires_capture', async () => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Card declined on capture'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
          rawStatus: 'requires_capture',
        });

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
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalledWith(
        bookingId,
        BookingFailureReason.CAPTURE_FAILED,
        baseSnapshots.flightSnapshot,
        baseSnapshots.passengerSnapshot,
        baseSnapshots.departureAt,
        expect.anything(),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Card declined on capture'),
        }),
      );
    });

    it('does NOT compensate if capture fails but reconciles to captured/succeeded (continues to Stage 4)', async () => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Network disconnect on return'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockResolvedValueOnce({
          status: 'captured',
          intentId: 'pi-123',
          rawStatus: 'succeeded',
        });

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

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
        })
        .mockResolvedValueOnce({
          status: 'nonfinal',
          intentId: 'pi-123',
          rawStatus: 'processing',
        });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

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

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

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

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

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

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

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
