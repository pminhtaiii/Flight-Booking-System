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
});
