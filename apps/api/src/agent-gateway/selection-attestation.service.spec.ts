import { Test, TestingModule } from '@nestjs/testing';
import { SelectionAttestationService } from './selection-attestation.service';
import { ConfigService } from '@nestjs/config';

describe('SelectionAttestationService', () => {
  let service: SelectionAttestationService;

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
  });

  it('should sign and verify an ordered-offer attestation', async () => {
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

    const verified = await service.verifySelectionAttestation(attestation, userId, sessionId, version, offers);
    expect(verified).toBe(true);
  });

  it('should reject an attestation with modified offers', async () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 3;
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
    );

    const tamperedOffers = [
      { flightOfferId: 'offer-1', duffelOfferId: 'duff-1' },
      { flightOfferId: 'offer-2', duffelOfferId: 'duff-2' },
    ];
    
    await expect(service.verifySelectionAttestation(attestation, userId, sessionId, version, tamperedOffers)).rejects.toThrow();
  });

  it('should reject an expired attestation', async () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 3;
    const expiresAt = new Date(Date.now() - 1000).toISOString(); // expired 1s ago
    const offers = [
      { flightOfferId: 'offer-1', duffelOfferId: 'duff-1' },
    ];

    const attestation = await service.signSelectionAttestation(
      userId,
      sessionId,
      version,
      expiresAt,
      offers,
    );

    await expect(service.verifySelectionAttestation(attestation, userId, sessionId, version, offers)).rejects.toThrow();
  });
});
