import 'reflect-metadata';
import { BookingIntentService } from './booking-intent.service';
import { DuffelTimeoutError } from '@/duffel/duffel.service';
import { HttpException, HttpStatus, NotFoundException, ForbiddenException, GoneException } from '@nestjs/common';

type MockEncryptionService = {
  encrypt: jest.Mock;
  decrypt: jest.Mock;
};

type MockDuffelService = {
  getOfferById: jest.Mock;
};

type MockPrismaService = {
  bookingIntent: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
    findUnique: jest.Mock;
  };
  $transaction: jest.Mock;
};

type MockAuditService = {
  createLog: jest.Mock;
};

type TestableService = {
  decryptProfileField(value: string | null): string | null;
  fetchLiveOffer(duffelOfferId: string): Promise<{
    totalAmount: string;
    currency: string;
    offerExpiresAt: Date | null;
    raw: unknown;
  }>;
  extractDuffelPassengerIds(
    rawOffer: unknown,
    passengers: Array<{ type: import('@prisma/client').PassengerType }>,
  ): string[];
};

describe('BookingIntentService Refinements', () => {
  let testable: TestableService;
  let mockEncryptionService: MockEncryptionService;
  let mockDuffelService: MockDuffelService;

  beforeEach(() => {
    mockEncryptionService = {
      encrypt: jest.fn(),
      decrypt: jest.fn((val: string) => `decrypted-${val}`),
    };

    mockDuffelService = {
      getOfferById: jest.fn(),
    };

    const service = new BookingIntentService(
      {} as never,
      mockDuffelService as never,
      {} as never,
      mockEncryptionService as never,
    );
    testable = service as unknown as TestableService;
  });

  describe('decryptProfileField', () => {
    it('returns null if value is null', () => {
      const result = testable.decryptProfileField(null);
      expect(result).toBeNull();
    });

    it('returns legacy plaintext as-is even if it contains colons', () => {
      const legacyValue = 'plain:text:with:colons';
      const result = testable.decryptProfileField(legacyValue);
      expect(result).toBe(legacyValue);
      expect(mockEncryptionService.decrypt).not.toHaveBeenCalled();
    });

    it('decrypts value if it starts with recognized marker v1:', () => {
      const encryptedValue = 'v1:ciphertext-here';
      const result = testable.decryptProfileField(encryptedValue);
      expect(result).toBe('decrypted-ciphertext-here');
      expect(mockEncryptionService.decrypt).toHaveBeenCalledWith('ciphertext-here');
    });

    it('returns null if decryption throws error', () => {
      mockEncryptionService.decrypt.mockImplementationOnce(() => {
        throw new Error('decryption failed');
      });
      const result = testable.decryptProfileField('v1:bad-cipher');
      expect(result).toBeNull();
    });
  });

  describe('fetchLiveOffer', () => {
    it('rejects offer with missing total_amount', async () => {
      mockDuffelService.getOfferById.mockResolvedValueOnce({
        total_currency: 'USD',
      });

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toThrow(
        new HttpException(
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Failed to confirm live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        ),
      );
    });

    it('rejects offer with non-numeric total_amount', async () => {
      mockDuffelService.getOfferById.mockResolvedValueOnce({
        total_amount: 'invalid-price',
        total_currency: 'USD',
      });

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toThrow(
        new HttpException(
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Failed to confirm live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        ),
      );
    });

    it('rejects offer with non-positive total_amount', async () => {
      mockDuffelService.getOfferById.mockResolvedValueOnce({
        total_amount: '-10.00',
        total_currency: 'USD',
      });

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toThrow(
        new HttpException(
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Failed to confirm live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        ),
      );
    });

    it('returns pricing if total_amount is a valid positive number string', async () => {
      const mockRaw = {
        total_amount: '150.00',
        total_currency: 'USD',
        expires_at: '2026-07-15T00:00:00Z',
      };
      mockDuffelService.getOfferById.mockResolvedValueOnce(mockRaw);

      const result = await testable.fetchLiveOffer('offer-123');
      expect(result).toEqual({
        totalAmount: '150.00',
        currency: 'USD',
        offerExpiresAt: new Date('2026-07-15T00:00:00Z'),
        raw: mockRaw,
      });
    });

    it('throws UPSTREAM_TIMEOUT on DuffelTimeoutError', async () => {
      mockDuffelService.getOfferById.mockRejectedValueOnce(new DuffelTimeoutError());

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toThrow(
        new HttpException(
          {
            code: 'UPSTREAM_TIMEOUT',
            message: 'Timed out while confirming live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        ),
      );
    });
  });

  describe('extractDuffelPassengerIds', () => {
    it('maps supplier passengers by type and ordinal for new booking intents', () => {
      const result = testable.extractDuffelPassengerIds(
        {
          passengers: [
            { id: 'pas_adult_1', type: 'adult' },
            { id: 'pas_child_1', type: 'child' },
            { id: 'pas_adult_2', type: 'adult' },
          ],
        },
        [{ type: 'ADULT' }, { type: 'CHILD' }, { type: 'ADULT' }],
      );

      expect(result).toEqual(['pas_adult_1', 'pas_child_1', 'pas_adult_2']);
    });

    it('rejects a supplier passenger list that cannot map every local passenger', () => {
      expect(() =>
        testable.extractDuffelPassengerIds(
          { passengers: [{ id: 'pas_adult_1', type: 'adult' }] },
          [{ type: 'ADULT' }, { type: 'CHILD' }],
        ),
      ).toThrow(HttpException);
    });
  });

  describe('Cron Cleanup Methods', () => {
    let service: BookingIntentService;
    let mockPrisma: MockPrismaService;
    let mockAudit: MockAuditService;
    const originalGraceHours = process.env.BOOKING_INTENT_GRACE_HOURS;

    beforeEach(() => {
      mockPrisma = {
        bookingIntent: {
          findMany: jest.fn(),
          updateMany: jest.fn(),
          deleteMany: jest.fn(),
          findUnique: jest.fn(),
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      } as unknown as MockPrismaService;

      mockAudit = {
        createLog: jest.fn(),
      } as unknown as MockAuditService;

      const mockEncryption = {
        decrypt: jest.fn((val: string) => `decrypted-${val}`),
      };

      service = new BookingIntentService(
        mockPrisma as unknown as import('../prisma/prisma.service').PrismaService,
        {} as import('../duffel/duffel.service').DuffelService,
        mockAudit as unknown as import('../audit/audit.service').AuditService,
        mockEncryption as unknown as import('../common/encryption.service').EncryptionService,
      );
    });

    afterEach(() => {
      if (originalGraceHours === undefined) {
        delete process.env.BOOKING_INTENT_GRACE_HOURS;
      } else {
        process.env.BOOKING_INTENT_GRACE_HOURS = originalGraceHours;
      }
    });

    describe('expireExpiredIntents', () => {
      it('returns 0 if no intents were updated', async () => {
        mockPrisma.bookingIntent.updateMany.mockResolvedValueOnce({ count: 0 });

        const result = await service.expireExpiredIntents(new Date());
        expect(result).toEqual({ expiredCount: 0 });
        expect(mockAudit.createLog).not.toHaveBeenCalled();
      });

      it('expires intents and creates audit log if expired intents are updated', async () => {
        mockPrisma.bookingIntent.updateMany.mockResolvedValueOnce({ count: 2 });

        const now = new Date('2026-07-11T12:00:00Z');
        const result = await service.expireExpiredIntents(now);

        expect(result).toEqual({ expiredCount: 2 });
        expect(mockPrisma.bookingIntent.updateMany).toHaveBeenCalledWith({
          where: {
            status: 'PENDING',
            intentExpiresAt: { lt: now },
          },
          data: { status: 'EXPIRED' },
        });
        expect(mockAudit.createLog).toHaveBeenCalledWith(mockPrisma, {
          userId: null,
          action: 'booking_intent_expired',
          resourceType: 'BookingIntent',
          resourceId: null,
          metadata: {
            count: 2,
          },
        });
      });
    });

    describe('deleteExpiredIntents', () => {
      it('returns 0 if no intents were deleted', async () => {
        mockPrisma.bookingIntent.deleteMany.mockResolvedValueOnce({ count: 0 });

        const result = await service.deleteExpiredIntents(new Date());
        expect(result).toEqual({ deletedCount: 0 });
        expect(mockAudit.createLog).not.toHaveBeenCalled();
      });

      it('deletes expired intents and creates audit log if intents are past grace period', async () => {
        process.env.BOOKING_INTENT_GRACE_HOURS = '12';
        mockPrisma.bookingIntent.deleteMany.mockResolvedValueOnce({ count: 1 });

        const now = new Date('2026-07-11T12:00:00Z');
        const result = await service.deleteExpiredIntents(now);

        expect(result).toEqual({ deletedCount: 1 });

        const expectedCutoff = new Date(now.getTime() - 12 * 60 * 60 * 1000);
        expect(mockPrisma.bookingIntent.deleteMany).toHaveBeenCalledWith({
          where: {
            status: 'EXPIRED',
            updatedAt: { lt: expectedCutoff },
          },
        });
        expect(mockAudit.createLog).toHaveBeenCalledWith(mockPrisma, {
          userId: null,
          action: 'booking_intent_deleted',
          resourceType: 'BookingIntent',
          resourceId: null,
          metadata: {
            count: 1,
          },
        });
      });

      it('defaults to 24 hours if grace period configuration is non-finite', async () => {
        process.env.BOOKING_INTENT_GRACE_HOURS = 'Infinity';
        mockPrisma.bookingIntent.deleteMany.mockResolvedValueOnce({ count: 0 });

        const now = new Date('2026-07-11T12:00:00Z');
        await service.deleteExpiredIntents(now);

        const expectedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        expect(mockPrisma.bookingIntent.deleteMany).toHaveBeenCalledWith({
          where: {
            status: 'EXPIRED',
            updatedAt: { lt: expectedCutoff },
          },
        });
      });

      it('defaults to 24 hours if grace period configuration is less than or equal to zero', async () => {
        process.env.BOOKING_INTENT_GRACE_HOURS = '-5';
        mockPrisma.bookingIntent.deleteMany.mockResolvedValueOnce({ count: 0 });

        const now = new Date('2026-07-11T12:00:00Z');
        await service.deleteExpiredIntents(now);

        const expectedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        expect(mockPrisma.bookingIntent.deleteMany).toHaveBeenCalledWith({
          where: {
            status: 'EXPIRED',
            updatedAt: { lt: expectedCutoff },
          },
        });
      });
    });

    describe('getIntent', () => {
      it('throws NotFoundException if intent does not exist', async () => {
        mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce(null);

        await expect(service.getIntent('user-1', 'intent-1')).rejects.toThrow(
          NotFoundException,
        );
      });

      it('throws ForbiddenException if intent does not belong to the user', async () => {
        mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
          id: 'intent-1',
          userId: 'user-2',
          status: 'PENDING',
        });

        await expect(service.getIntent('user-1', 'intent-1')).rejects.toThrow(
          ForbiddenException,
        );
      });

      it('throws GoneException if intent status is EXPIRED', async () => {
        mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
          id: 'intent-1',
          userId: 'user-1',
          status: 'EXPIRED',
        });

        await expect(service.getIntent('user-1', 'intent-1')).rejects.toThrow(
          GoneException,
        );
      });

      it('returns mapped intent DTO on success', async () => {
        const mockPricedAt = new Date('2026-07-26T10:00:00Z');
        const mockExpiresAt = new Date('2026-07-26T10:30:00Z');
        const mockCreatedAt = new Date('2026-07-26T09:50:00Z');
        const mockDob = new Date('1990-01-01');

        mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
          id: 'intent-1',
          userId: 'user-1',
          status: 'PENDING',
          originalPrice: 150.00,
          confirmedPrice: 160.00,
          priceChanged: true,
          currency: 'USD',
          pricedAt: mockPricedAt,
          intentExpiresAt: mockExpiresAt,
          offerExpiresAt: null,
          createdAt: mockCreatedAt,
          passengers: [
            {
              id: 'p1',
              type: 'ADULT',
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: mockDob,
              gender: 'male',
              nationality: 'US',
              passportNumber: 'v1:encrypted-passport',
              passportExpiry: 'v1:encrypted-expiry',
              travelerProfileId: 'profile-1',
            }
          ],
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01'),
          returnDate: null,
          cabinClass: 'economy',
          adults: 1,
          children: 0,
          infants: 0,
        });

        const result = await service.getIntent('user-1', 'intent-1');

        expect(result).toEqual({
          intentId: 'intent-1',
          status: 'PENDING',
          originalPrice: 150,
          confirmedPrice: 160,
          priceChanged: true,
          currency: 'USD',
          pricedAt: mockPricedAt.toISOString(),
          intentExpiresAt: mockExpiresAt.toISOString(),
          offerExpiresAt: null,
          createdAt: mockCreatedAt.toISOString(),
          passengers: [
            {
              id: 'p1',
              type: 'ADULT',
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: '1990-01-01',
              gender: 'male',
              nationality: 'US',
              passportNumber: 'decrypted-v1:encrypted-passport',
              passportExpiry: 'decrypted-v1:encrypted-expiry',
              preFilledFromProfile: true,
            }
          ],
          flight: {
            origin: 'SGN',
            destination: 'HAN',
            departureDate: '2026-08-01',
            returnDate: null,
            cabinClass: 'economy',
            adults: 1,
            children: 0,
            infants: 0,
          },
        });
      });
    });
  });
});
