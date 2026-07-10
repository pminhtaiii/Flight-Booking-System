import 'reflect-metadata';
import { BookingIntentService } from './booking-intent.service';
import { EncryptionService } from '@/common/encryption.service';
import { DuffelService, DuffelTimeoutError } from '@/duffel/duffel.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { HttpException, HttpStatus } from '@nestjs/common';

describe('BookingIntentService Refinements', () => {
  let service: BookingIntentService;
  let mockEncryptionService: EncryptionService;
  let mockDuffelService: DuffelService;
  let mockPrismaService: PrismaService;
  let mockAuditService: AuditService;

  beforeEach(() => {
    mockEncryptionService = {
      encrypt: jest.fn(),
      decrypt: jest.fn((val) => `decrypted-${val}`),
    } as any;

    mockDuffelService = {
      getOfferById: jest.fn(),
    } as any;

    mockPrismaService = {} as any;
    mockAuditService = {} as any;

    service = new BookingIntentService(
      mockPrismaService,
      mockDuffelService,
      mockAuditService,
      mockEncryptionService,
    );
  });

  describe('decryptProfileField', () => {
    it('returns null if value is null', () => {
      const result = (service as any).decryptProfileField(null);
      expect(result).toBeNull();
    });

    it('returns legacy plaintext as-is even if it contains colons', () => {
      const legacyValue = 'plain:text:with:colons';
      const result = (service as any).decryptProfileField(legacyValue);
      expect(result).toBe(legacyValue);
      expect(mockEncryptionService.decrypt).not.toHaveBeenCalled();
    });

    it('decrypts value if it starts with recognized marker v1:', () => {
      const encryptedValue = 'v1:ciphertext-here';
      const result = (service as any).decryptProfileField(encryptedValue);
      expect(result).toBe('decrypted-ciphertext-here');
      expect(mockEncryptionService.decrypt).toHaveBeenCalledWith('ciphertext-here');
    });

    it('returns null if decryption throws error', () => {
      jest.spyOn(mockEncryptionService, 'decrypt').mockImplementationOnce(() => {
        throw new Error('decryption failed');
      });
      const result = (service as any).decryptProfileField('v1:bad-cipher');
      expect(result).toBeNull();
    });
  });

  describe('fetchLiveOffer', () => {
    it('rejects offer with missing total_amount', async () => {
      jest.spyOn(mockDuffelService, 'getOfferById').mockResolvedValueOnce({
        total_currency: 'USD',
      });

      await expect((service as any).fetchLiveOffer('offer-123')).rejects.toThrow(
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
      jest.spyOn(mockDuffelService, 'getOfferById').mockResolvedValueOnce({
        total_amount: 'invalid-price',
        total_currency: 'USD',
      });

      await expect((service as any).fetchLiveOffer('offer-123')).rejects.toThrow(
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
      jest.spyOn(mockDuffelService, 'getOfferById').mockResolvedValueOnce({
        total_amount: '-10.00',
        total_currency: 'USD',
      });

      await expect((service as any).fetchLiveOffer('offer-123')).rejects.toThrow(
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
      jest.spyOn(mockDuffelService, 'getOfferById').mockResolvedValueOnce(mockRaw);

      const result = await (service as any).fetchLiveOffer('offer-123');
      expect(result).toEqual({
        totalAmount: '150.00',
        currency: 'USD',
        offerExpiresAt: new Date('2026-07-15T00:00:00Z'),
        raw: mockRaw,
      });
    });

    it('throws UPSTREAM_TIMEOUT on DuffelTimeoutError', async () => {
      jest.spyOn(mockDuffelService, 'getOfferById').mockRejectedValueOnce(new DuffelTimeoutError());

      await expect((service as any).fetchLiveOffer('offer-123')).rejects.toThrow(
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
