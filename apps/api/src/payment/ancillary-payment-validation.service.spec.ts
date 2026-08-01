import { DuffelService } from '@/duffel/duffel.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AncillaryPaymentValidationService } from './ancillary-payment-validation.service';

describe('AncillaryPaymentValidationService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reprices once outside transactions and validates the leased current snapshot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    let inTransaction = false;
    const selection = {
      id: 'selection-3',
      bookingIntentId: 'intent-1',
      version: 3,
      status: 'DRAFT_COMMITTED',
      currency: 'USD',
      total: '53.00',
      validationLeaseToken: null,
      validationLeaseExpiresAt: null,
      seatSelections: [{ serviceId: 'seat-1' }],
      baggageSelections: [{ serviceId: 'bag-1', quantity: 1 }],
    };
    const intent = {
      id: 'intent-1',
      userId: 'user-1',
      status: 'PENDING',
      intentExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      offerExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      duffelOfferId: 'offer-1',
      confirmedPrice: '420.00',
      currency: 'USD',
      ancillaryVersion: 3,
      currentAncillarySelectionId: 'selection-3',
      currentAncillarySelection: selection,
    };
    type PrismaFake = {
      $transaction: jest.Mock;
      $queryRaw: jest.Mock;
      bookingIntent: {
        findUnique: jest.Mock;
        updateMany: jest.Mock;
      };
      ancillarySelection: {
        updateMany: jest.Mock;
      };
    };
    const prisma: PrismaFake = {
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'intent-1' }]),
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue(intent),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ancillarySelection: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: PrismaFake) => Promise<unknown>): Promise<unknown> => {
        inTransaction = true;
        try {
          return await callback(prisma);
        } finally {
          inTransaction = false;
        }
      },
    );
    const duffel = {
      repriceOffer: jest.fn().mockImplementation(async () => {
        expect(inTransaction).toBe(false);
        return {
          totalAmount: '473.00',
          baseAmount: '420.00',
          serviceLines: [
            { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
            { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
          ],
          currency: 'USD',
          invalidServiceIdentities: [],
        };
      }),
    };
    const service = new AncillaryPaymentValidationService(
      prisma as unknown as PrismaService,
      duffel as unknown as DuffelService,
    );

    const result = await service.validateForPayment({
      userId: 'user-1',
      bookingIntentId: 'intent-1',
      ancillarySelectionId: 'selection-3',
      ancillarySelectionVersion: 3,
    });

    expect(result).toEqual({
      selectionId: 'selection-3',
      selectionVersion: 3,
      baseAmount: '420.00',
      grandTotal: '473.00',
      currency: 'USD',
      services: [
        { serviceId: 'bag-1', quantity: 1 },
        { serviceId: 'seat-1', quantity: 1 },
      ],
    });
    expect(duffel.repriceOffer).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.ancillarySelection.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'selection-3',
          version: 3,
          validationLeaseToken: expect.any(String),
        }),
        data: expect.objectContaining({
          status: 'VALIDATED',
          validatedBaseAmount: '420.00',
          validatedGrandTotal: '473.00',
          validationLeaseToken: null,
          validationLeaseExpiresAt: null,
        }),
      }),
    );
  });

  it('fails fast with GatewayTimeoutException and releases the lease when repricing exceeds 15 seconds', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    const selection = {
      id: 'selection-3',
      bookingIntentId: 'intent-1',
      version: 3,
      status: 'DRAFT_COMMITTED',
      currency: 'USD',
      total: '53.00',
      validationLeaseToken: null,
      validationLeaseExpiresAt: null,
      seatSelections: [{ serviceId: 'seat-1' }],
      baggageSelections: [{ serviceId: 'bag-1', quantity: 1 }],
    };
    const intent = {
      id: 'intent-1',
      userId: 'user-1',
      status: 'PENDING',
      intentExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      offerExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      duffelOfferId: 'offer-1',
      confirmedPrice: '420.00',
      currency: 'USD',
      ancillaryVersion: 3,
      currentAncillarySelectionId: 'selection-3',
      currentAncillarySelection: selection,
    };
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'intent-1' }]),
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue(intent),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ancillarySelection: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (tx: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction),
      ),
      ancillarySelection: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    // Duffel repricing hangs past 15s timeout
    const duffel = {
      repriceOffer: jest.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 20_000))),
    };
    const service = new AncillaryPaymentValidationService(
      prisma as unknown as PrismaService,
      duffel as unknown as DuffelService,
    );

    const validationPromise = service.validateForPayment({
      userId: 'user-1',
      bookingIntentId: 'intent-1',
      ancillarySelectionId: 'selection-3',
      ancillarySelectionVersion: 3,
    });

    // Flush microtasks to allow the async validation pipeline to setup timers
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    jest.advanceTimersByTime(15_000);

    await expect(validationPromise).rejects.toMatchObject({
      response: {
        code: 'ANCILLARY_REPRICING_TIMEOUT',
        message: 'External ancillary repricing request timed out',
      },
    });

    // Lease must be released
    expect(prisma.ancillarySelection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'selection-3',
          bookingIntentId: 'intent-1',
          version: 3,
          validationLeaseToken: expect.any(String),
        }),
        data: expect.objectContaining({
          validationLeaseToken: null,
          validationLeaseExpiresAt: null,
        }),
      }),
    );
  });
});
