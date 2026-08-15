import { Test, TestingModule } from '@nestjs/testing';
import { SelectionAttestationService } from './selection-attestation.service';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';

describe('SelectionAttestationService', () => {
  let service: SelectionAttestationService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SelectionAttestationService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'ATTESTATION_SECRET') return 'super-secret-key-for-attestation';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SelectionAttestationService>(SelectionAttestationService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('signSelectionAttestation & verifySelectionAttestation success roundtrip', () => {
    it('should sign and verify an ordered-offer attestation with default issuedAt', async () => {
      const userId = 'user-123';
      const sessionId = 'session-456';
      const version = 3;
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const offers = [
        { flightOfferId: 'offer-1', duffelOfferId: 'duff-1' },
        { flightOfferId: 'offer-2', duffelOfferId: 'duff-2' },
      ];

      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      expect(attestation).toBeDefined();
      expect(attestation).toMatch(/^sel_v1_[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/);

      const verified = await service.verifySelectionAttestation(
        attestation,
        userId,
        sessionId,
        version,
        offers,
      );
      expect(verified).toBe(true);
    });

    it('should sign and verify an ordered-offer attestation with custom issuedAt', async () => {
      const userId = 'user-123';
      const sessionId = 'session-456';
      const version = 3;
      const issuedAt = new Date(Date.now() - 5000).toISOString();
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const offers = [
        { flightOfferId: 'offer-1', duffelOfferId: 'duff-1' },
      ];

      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
        issuedAt,
      );

      const verified = await service.verifySelectionAttestation(
        attestation,
        userId,
        sessionId,
        version,
        offers,
      );
      expect(verified).toBe(true);
    });
  });

  describe('tampered offers rejection', () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 3;
    const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    const originalOffers = [
      { flightOfferId: 'offer-1', duffelOfferId: 'duff-1' },
      { flightOfferId: 'offer-2', duffelOfferId: 'duff-2' },
    ];

    it('should reject attestation when flightOfferId is modified', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        originalOffers,
      );

      const modifiedOffers = [
        { flightOfferId: 'offer-modified', duffelOfferId: 'duff-1' },
        { flightOfferId: 'offer-2', duffelOfferId: 'duff-2' },
      ];

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, modifiedOffers),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });

    it('should reject attestation when duffelOfferId is modified', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        originalOffers,
      );

      const modifiedOffers = [
        { flightOfferId: 'offer-1', duffelOfferId: 'duff-modified' },
        { flightOfferId: 'offer-2', duffelOfferId: 'duff-2' },
      ];

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, modifiedOffers),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });

    it('should reject attestation when offer order is swapped', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        originalOffers,
      );

      const swappedOffers = [
        { flightOfferId: 'offer-2', duffelOfferId: 'duff-2' },
        { flightOfferId: 'offer-1', duffelOfferId: 'duff-1' },
      ];

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, swappedOffers),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });

    it('should reject attestation with extra offers in expected parameter', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        originalOffers,
      );

      const extraOffers = [
        ...originalOffers,
        { flightOfferId: 'offer-3', duffelOfferId: 'duff-3' },
      ];

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, extraOffers),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });

    it('should reject attestation with missing offers in expected parameter', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        originalOffers,
      );

      const missingOffers = [originalOffers[0]];

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, missingOffers),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });
  });

  describe('mismatched parameters rejection', () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 3;
    const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    const offers = [{ flightOfferId: 'offer-1', duffelOfferId: 'duff-1' }];

    it('should reject mismatched userId', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      await expect(
        service.verifySelectionAttestation(attestation, 'wrong-user', sessionId, version, offers),
      ).rejects.toThrow(new UnauthorizedException('User mismatch'));
    });

    it('should reject mismatched sessionId', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      await expect(
        service.verifySelectionAttestation(attestation, userId, 'wrong-session', version, offers),
      ).rejects.toThrow(new UnauthorizedException('Session mismatch'));
    });

    it('should reject mismatched version', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version + 1, offers),
      ).rejects.toThrow(new UnauthorizedException('Version mismatch'));
    });
  });

  describe('expiration and timestamp validation', () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 3;
    const offers = [{ flightOfferId: 'offer-1', duffelOfferId: 'duff-1' }];

    it('should reject an expired attestation', async () => {
      const expiresAt = new Date(Date.now() - 1000).toISOString();
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, offers),
      ).rejects.toThrow(new UnauthorizedException('Attestation expired'));
    });

    it('should reject attestation if issuedAt exceeds clock skew (> 60s in the future)', async () => {
      const futureIssuedAt = new Date(Date.now() + 120000).toISOString();
      const expiresAt = new Date(Date.now() + 300000).toISOString();
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
        futureIssuedAt,
      );

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, offers),
      ).rejects.toThrow(new UnauthorizedException('Attestation issued in the future'));
    });

    it('should reject attestation if issuedAt is after expiresAt', async () => {
      const expiresAt = new Date(Date.now() + 10000).toISOString();
      const issuedAt = new Date(Date.now() + 20000).toISOString();
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
        issuedAt,
      );

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, offers),
      ).rejects.toThrow(new UnauthorizedException('Attestation issuedAt exceeds expiresAt'));
    });
  });

  describe('malformed format and invalid payload rejection', () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 1;
    const offers = [{ flightOfferId: 'offer-1', duffelOfferId: 'duff-1' }];

    it('should reject invalid attestation prefix or non-string format', async () => {
      await expect(
        service.verifySelectionAttestation(
          'wrong_prefix_base64.sig',
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation format'));

      await expect(
        service.verifySelectionAttestation(
          '',
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation format'));

      await expect(
        service.verifySelectionAttestation(
          'sel_v1_onlypayloadwithoutdot',
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation format'));

      await expect(
        service.verifySelectionAttestation(
          'sel_v1_payload.sig.extrapart',
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation format'));
    });

    it('should reject malformed non-JSON payload', async () => {
      const invalidJsonBase64 = Buffer.from('{not-valid-json').toString('base64url');
      const malformedAttestation = `sel_v1_${invalidJsonBase64}.validsignature`;

      await expect(
        service.verifySelectionAttestation(
          malformedAttestation,
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation payload'));
    });

    it('should reject non-object JSON payload', async () => {
      const nonObjectJsonBase64 = Buffer.from(JSON.stringify('plain-string')).toString('base64url');
      const attestation = `sel_v1_${nonObjectJsonBase64}.validsignature`;

      await expect(
        service.verifySelectionAttestation(
          attestation,
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation payload'));
    });
  });

  describe('signature validation & timingSafeEqual', () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 3;
    const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    const offers = [{ flightOfferId: 'offer-1', duffelOfferId: 'duff-1' }];

    it('should reject invalid or corrupted signature', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      const [prefixAndPayload, validSig] = attestation.split('.');
      const corruptedSig = validSig.slice(0, -2) + (validSig.endsWith('0') ? '1' : '0');
      const corruptedAttestation = `${prefixAndPayload}.${corruptedSig}`;

      await expect(
        service.verifySelectionAttestation(
          corruptedAttestation,
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid signature'));
    });

    it('should reject signature with wrong byte length', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      const [prefixAndPayload] = attestation.split('.');
      const shortSig = '1234abcd';
      const corruptedAttestation = `${prefixAndPayload}.${shortSig}`;

      await expect(
        service.verifySelectionAttestation(
          corruptedAttestation,
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid signature'));
    });

    it('should verify signature using constant-time timingSafeEqual comparison', async () => {
      const crypto = require('crypto');
      const timingSafeEqualSpy = jest.spyOn(crypto, 'timingSafeEqual');

      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      const verified = await service.verifySelectionAttestation(
        attestation,
        userId,
        sessionId,
        version,
        offers,
      );

      expect(verified).toBe(true);
      expect(timingSafeEqualSpy).toHaveBeenCalled();
      timingSafeEqualSpy.mockRestore();
    });
  });

  describe('missing ATTESTATION_SECRET configuration', () => {
    it('should throw Error on sign if ATTESTATION_SECRET is not configured', async () => {
      jest.spyOn(configService, 'get').mockReturnValue(null);

      await expect(
        service.signSelectionAttestation(
          'user-1',
          'session-1',
          1,
          new Date(Date.now() + 60000).toISOString(),
          [{ flightOfferId: 'f1', duffelOfferId: 'd1' }],
        ),
      ).rejects.toThrow('ATTESTATION_SECRET is not configured');
    });

    it('should throw Error on verify if ATTESTATION_SECRET is not configured', async () => {
      const attestation = await service.signSelectionAttestation(
        'user-1',
        'session-1',
        1,
        new Date(Date.now() + 60000).toISOString(),
        [{ flightOfferId: 'f1', duffelOfferId: 'd1' }],
      );

      jest.spyOn(configService, 'get').mockReturnValue(null);

      await expect(
        service.verifySelectionAttestation(
          attestation,
          'user-1',
          'session-1',
          1,
          [{ flightOfferId: 'f1', duffelOfferId: 'd1' }],
        ),
      ).rejects.toThrow('ATTESTATION_SECRET is not configured');
    });
  });
});
