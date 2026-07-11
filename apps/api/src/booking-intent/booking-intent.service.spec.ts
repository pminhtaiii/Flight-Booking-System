import 'reflect-metadata';
import { BookingIntentService } from './booking-intent.service';
import { DuffelTimeoutError } from '@/duffel/duffel.service';
import { HttpException, HttpStatus } from '@nestjs/common';

type MockEncryptionService = {
  encrypt: jest.Mock;
  decrypt: jest.Mock;
};

type MockDuffelService = {
  getOfferById: jest.Mock;
};

type TestableService = {
  decryptProfileField(value: string | null): string | null;
  fetchLiveOffer(duffelOfferId: string): Promise<{
    totalAmount: string;
    currency: string;
    offerExpiresAt: Date | null;
    raw: unknown;
  }>;
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

  describe('Cron Cleanup Methods', () => {
    let service: BookingIntentService;
    let mockPrisma: any;
    let mockAudit: any;
    const originalGraceHours = process.env.BOOKING_INTENT_GRACE_HOURS;

    beforeEach(() => {
      mockPrisma = {
        bookingIntent: {
          findMany: jest.fn(),
          updateMany: jest.fn(),
          deleteMany: jest.fn(),
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      };

      mockAudit = {
        createLog: jest.fn(),
      };

      service = new BookingIntentService(
        mockPrisma as any,
        {} as any,
        mockAudit as any,
        {} as any,
      );
    });

    afterEach(() => {
      process.env.BOOKING_INTENT_GRACE_HOURS = originalGraceHours;
    });

    describe('expireExpiredIntents', () => {
      it('returns 0 and empty array if no intents found to expire', async () => {
        mockPrisma.bookingIntent.findMany.mockResolvedValueOnce([]);

        const result = await service.expireExpiredIntents(new Date());
        expect(result).toEqual({ expiredCount: 0, expiredIds: [] });
        expect(mockPrisma.bookingIntent.updateMany).not.toHaveBeenCalled();
        expect(mockAudit.createLog).not.toHaveBeenCalled();
      });

      it('expires intents and creates audit log if expired intents are found', async () => {
        const mockIntents = [{ id: 'intent-1' }, { id: 'intent-2' }];
        mockPrisma.bookingIntent.findMany.mockResolvedValueOnce(mockIntents);
        mockPrisma.bookingIntent.updateMany.mockResolvedValueOnce({ count: 2 });

        const now = new Date('2026-07-11T12:00:00Z');
        const result = await service.expireExpiredIntents(now);

        expect(result).toEqual({ expiredCount: 2, expiredIds: ['intent-1', 'intent-2'] });
        expect(mockPrisma.bookingIntent.findMany).toHaveBeenCalledWith({
          where: {
            status: 'PENDING',
            intentExpiresAt: { lt: now },
          },
          select: { id: true },
        });
        expect(mockPrisma.bookingIntent.updateMany).toHaveBeenCalledWith({
          where: {
            id: { in: ['intent-1', 'intent-2'] },
            status: 'PENDING',
          },
          data: { status: 'EXPIRED' },
        });
        expect(mockAudit.createLog).toHaveBeenCalledWith(mockPrisma, {
          userId: null,
          action: 'booking_intent_expired',
          resourceType: 'BookingIntent',
          resourceId: null,
          metadata: {
            intentIds: ['intent-1', 'intent-2'],
            count: 2,
          },
        });
      });
    });

    describe('deleteExpiredIntents', () => {
      it('returns 0 and empty array if no intents found to delete', async () => {
        mockPrisma.bookingIntent.findMany.mockResolvedValueOnce([]);

        const result = await service.deleteExpiredIntents(new Date());
        expect(result).toEqual({ deletedCount: 0, deletedIds: [] });
        expect(mockPrisma.bookingIntent.deleteMany).not.toHaveBeenCalled();
        expect(mockAudit.createLog).not.toHaveBeenCalled();
      });

      it('deletes expired intents and creates audit log if intents are past grace period', async () => {
        process.env.BOOKING_INTENT_GRACE_HOURS = '12';
        const mockIntents = [{ id: 'expired-1' }];
        mockPrisma.bookingIntent.findMany.mockResolvedValueOnce(mockIntents);
        mockPrisma.bookingIntent.deleteMany.mockResolvedValueOnce({ count: 1 });

        const now = new Date('2026-07-11T12:00:00Z');
        const result = await service.deleteExpiredIntents(now);

        expect(result).toEqual({ deletedCount: 1, deletedIds: ['expired-1'] });

        const expectedCutoff = new Date(now.getTime() - 12 * 60 * 60 * 1000);
        expect(mockPrisma.bookingIntent.findMany).toHaveBeenCalledWith({
          where: {
            status: 'EXPIRED',
            updatedAt: { lt: expectedCutoff },
          },
          select: { id: true },
        });
        expect(mockPrisma.bookingIntent.deleteMany).toHaveBeenCalledWith({
          where: {
            id: { in: ['expired-1'] },
            status: 'EXPIRED',
          },
        });
        expect(mockAudit.createLog).toHaveBeenCalledWith(mockPrisma, {
          userId: null,
          action: 'booking_intent_deleted',
          resourceType: 'BookingIntent',
          resourceId: null,
          metadata: {
            intentIds: ['expired-1'],
            count: 1,
          },
        });
      });
    });
  });
});
