import { Test, TestingModule } from '@nestjs/testing';
import { AgentBookingReadinessService } from './agent-booking-readiness.service';
import { PrismaService } from '@/prisma/prisma.service';
import { ProfileService } from '@/profile/profile.service';
import { BookingReadinessService } from '@/booking-intent/booking-readiness.service';
import { BookingReadinessObservability } from '@/booking-intent/booking-readiness.observability';
import { AuditService } from '@/audit/audit.service';
import { AgentToolAuditService } from '../audit/agent-tool-audit.service';
import { AgentBookingReadinessRequestDto } from '../dto/booking-readiness.dto';
import { PassengerType } from '@prisma/client';
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { FlightOfferNormalizer } from '@/supplier/search/flight-offer.normalizer';

describe('AgentBookingReadinessService', () => {
  let service: AgentBookingReadinessService;
  let prismaService: {
    flightOffer: { findUnique: jest.Mock };
  };
  let profileService: { getProfile: jest.Mock };
  let bookingReadinessService: { getAdvisoryReadiness: jest.Mock };
  let observability: { recordOutcome: jest.Mock };
  let auditService: { createLog: jest.Mock };
  let agentToolAuditService: { recordToolExecution: jest.Mock };

  beforeEach(async () => {
    prismaService = {
      flightOffer: { findUnique: jest.fn() },
    };
    profileService = { getProfile: jest.fn() };
    bookingReadinessService = { getAdvisoryReadiness: jest.fn() };
    observability = { recordOutcome: jest.fn() };
    auditService = { createLog: jest.fn() };
    agentToolAuditService = {
      recordToolExecution: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentBookingReadinessService,
        { provide: PrismaService, useValue: prismaService },
        { provide: ProfileService, useValue: profileService },
        { provide: BookingReadinessService, useValue: bookingReadinessService },
        { provide: BookingReadinessObservability, useValue: observability },
        { provide: AuditService, useValue: auditService },
        { provide: AgentToolAuditService, useValue: agentToolAuditService },
      ],
    }).compile();

    service = module.get<AgentBookingReadinessService>(AgentBookingReadinessService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw NotFoundException OFFER_NOT_FOUND when flight offer does not exist', async () => {
    prismaService.flightOffer.findUnique.mockResolvedValueOnce(null);

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-not-found';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
    ];

    await expect(service.checkBookingReadiness('user-1', dto)).rejects.toThrow(NotFoundException);

    expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'bookings/readiness',
        actorId: 'user-1',
        outcome: 'FAILURE',
        errorCode: 'OFFER_NOT_FOUND',
      }),
    );
  });

  it('should throw HttpException 422 OFFER_MALFORMED when stored offer data is malformed', async () => {
    prismaService.flightOffer.findUnique.mockResolvedValueOnce({
      id: 'offer-1',
      rawOffer: { passengers: 'not-an-array' },
    });

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-1';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
    ];

    await expect(service.checkBookingReadiness('user-1', dto)).rejects.toThrow(HttpException);

    try {
      prismaService.flightOffer.findUnique.mockResolvedValueOnce({
        id: 'offer-1',
        rawOffer: {},
      });
      await service.checkBookingReadiness('user-1', dto);
    } catch (err: any) {
      expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(err.getResponse()).toMatchObject({ code: 'OFFER_MALFORMED' });
    }
  });

  it('should throw HttpException 422 PASSENGER_MAPPING_INVALID when passenger ordinal cannot be mapped', async () => {
    prismaService.flightOffer.findUnique.mockResolvedValueOnce({
      id: 'offer-1',
      rawOffer: { passengers: [{ id: 'offer-p-1' }] },
    });

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-1';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 2, sourceType: 'inline' },
    ];

    await expect(service.checkBookingReadiness('user-1', dto)).rejects.toThrow(HttpException);

    try {
      prismaService.flightOffer.findUnique.mockResolvedValueOnce({
        id: 'offer-1',
        rawOffer: { passengers: [{ id: 'offer-p-1' }] },
      });
      await service.checkBookingReadiness('user-1', dto);
    } catch (err: any) {
      expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(err.getResponse()).toMatchObject({ code: 'PASSENGER_MAPPING_INVALID' });
    }
  });

  it('should throw NotFoundException PROFILE_NOT_FOUND when traveler profile does not exist', async () => {
    profileService.getProfile.mockResolvedValueOnce(null);

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-1';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'traveler_profile' },
    ];

    await expect(service.checkBookingReadiness('user-1', dto)).rejects.toThrow(NotFoundException);

    expect(profileService.getProfile).toHaveBeenCalledWith('user-1');
  });

  it('should successfully evaluate readiness for inline passenger and return safe response with CONTINUE_CHECKOUT', async () => {
    const rawOffer = { passengers: [{ id: 'offer-passenger-1' }] };
    prismaService.flightOffer.findUnique.mockResolvedValueOnce({ id: 'offer-1', rawOffer });

    bookingReadinessService.getAdvisoryReadiness.mockResolvedValueOnce({
      scope: 'DOMESTIC',
      ready: true,
      passengers: [
        {
          passengerType: PassengerType.ADULT,
          passengerOrdinal: 1,
          ready: true,
          profileRevision: 7,
          sections: [
            {
              name: 'identity',
              fields: [
                {
                  name: 'givenName',
                  status: 'filled',
                  reason: null,
                  blocking: false,
                  value: 'Ada Lovelace',
                },
              ],
            },
          ],
        },
      ],
    });

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-1';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
    ];

    const result = await service.checkBookingReadiness('user-1', dto, 'trace-1', 'corr-1');

    expect(result).toEqual({
      scope: 'DOMESTIC',
      ready: true,
      passengers: [
        {
          passengerType: PassengerType.ADULT,
          passengerOrdinal: 1,
          issues: [{ section: 'identity', name: 'givenName', status: 'filled', reason: null }],
        },
      ],
      nextAction: 'CONTINUE_CHECKOUT',
    });

    expect(JSON.stringify(result)).not.toContain('Ada Lovelace');
    expect(bookingReadinessService.getAdvisoryReadiness).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        flightOfferId: 'offer-1',
        passengers: [
          expect.objectContaining({
            offerPassengerId: 'offer-passenger-1',
            passengerType: PassengerType.ADULT,
            source: { type: 'inline' },
          }),
        ],
      }),
      { traceId: 'trace-1', correlationId: 'corr-1' },
    );

    expect(auditService.createLog).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        userId: 'user-1',
        action: 'AGENT_GATEWAY_READINESS',
        metadata: { status: 'ready', scope: 'DOMESTIC', passengerCount: 1 },
        traceId: 'trace-1',
        correlationId: 'corr-1',
      }),
    );

    expect(observability.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'gateway_readiness',
        status: 'ready',
        error: false,
      }),
    );

    expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'bookings/readiness',
        actorId: 'user-1',
        outcome: 'SUCCESS',
        traceId: 'trace-1',
        correlationId: 'corr-1',
      }),
    );
  });

  it('should correctly resolve owned profile internally for traveler_profile passenger', async () => {
    const rawOffer = { passengers: [{ id: 'offer-passenger-1' }] };
    prismaService.flightOffer.findUnique.mockResolvedValueOnce({ id: 'offer-1', rawOffer });
    profileService.getProfile.mockResolvedValueOnce({ profileId: 'profile-uuid-123' });

    bookingReadinessService.getAdvisoryReadiness.mockResolvedValueOnce({
      scope: 'INTERNATIONAL',
      ready: true,
      passengers: [],
    });

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-1';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'traveler_profile' },
    ];

    const result = await service.checkBookingReadiness('user-1', dto);

    expect(profileService.getProfile).toHaveBeenCalledWith('user-1');
    expect(bookingReadinessService.getAdvisoryReadiness).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        flightOfferId: 'offer-1',
        passengers: [
          expect.objectContaining({
            offerPassengerId: 'offer-passenger-1',
            source: {
              type: 'traveler_profile',
              travelerProfileId: 'profile-uuid-123',
            },
          }),
        ],
      }),
      expect.any(Object),
    );
    expect(result.nextAction).toBe('CONTINUE_CHECKOUT');
  });

  it('should set nextAction to COMPLETE_PROFILE when not ready and all passengers are from traveler_profile', async () => {
    const rawOffer = { passengers: [{ id: 'offer-passenger-1' }] };
    prismaService.flightOffer.findUnique.mockResolvedValueOnce({ id: 'offer-1', rawOffer });
    profileService.getProfile.mockResolvedValueOnce({ profileId: 'profile-uuid-123' });

    bookingReadinessService.getAdvisoryReadiness.mockResolvedValueOnce({
      scope: 'DOMESTIC',
      ready: false,
      passengers: [],
    });

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-1';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'traveler_profile' },
    ];

    const result = await service.checkBookingReadiness('user-1', dto);

    expect(result.ready).toBe(false);
    expect(result.nextAction).toBe('COMPLETE_PROFILE');
  });

  it('should set nextAction to CONTINUE_CHECKOUT when not ready but has inline passengers', async () => {
    const rawOffer = { passengers: [{ id: 'offer-passenger-1' }] };
    prismaService.flightOffer.findUnique.mockResolvedValueOnce({ id: 'offer-1', rawOffer });

    bookingReadinessService.getAdvisoryReadiness.mockResolvedValueOnce({
      scope: 'DOMESTIC',
      ready: false,
      passengers: [],
    });

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-1';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
    ];

    const result = await service.checkBookingReadiness('user-1', dto);

    expect(result.ready).toBe(false);
    expect(result.nextAction).toBe('CONTINUE_CHECKOUT');
  });

  it('records a PII-safe error outcome when the readiness service throws a value-bearing error', async () => {
    prismaService.flightOffer.findUnique.mockResolvedValueOnce({
      rawOffer: { passengers: [{ id: 'offer-passenger-1' }] },
    });
    bookingReadinessService.getAdvisoryReadiness.mockRejectedValueOnce(
      new HttpException(
        { code: 'DEPENDENCY_ERROR', message: 'Ada Lovelace passport 123456789' },
        503,
      ),
    );

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-id';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
    ];

    await expect(service.checkBookingReadiness('user-1', dto)).rejects.toThrow(HttpException);

    expect(auditService.createLog).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        action: 'AGENT_GATEWAY_READINESS',
        metadata: expect.objectContaining({ status: 'DEPENDENCY_ERROR', passengerCount: 1 }),
      }),
    );
    expect(JSON.stringify(auditService.createLog.mock.calls)).not.toContain('Ada Lovelace');
    expect(observability.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'gateway_readiness', error: true }),
    );
    expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'bookings/readiness',
        actorId: 'user-1',
        outcome: 'FAILURE',
        errorCode: 'DEPENDENCY_ERROR',
      }),
    );
  });

  it('handles generic non-HttpException errors and returns 500 READINESS_REQUEST_FAILED', async () => {
    prismaService.flightOffer.findUnique.mockRejectedValueOnce(new Error('DB failure'));

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-id';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
    ];

    await expect(service.checkBookingReadiness('user-1', dto)).rejects.toThrow(HttpException);

    try {
      prismaService.flightOffer.findUnique.mockRejectedValueOnce(new Error('DB failure'));
      await service.checkBookingReadiness('user-1', dto);
    } catch (err: any) {
      expect(err.getStatus()).toBe(500);
      expect(err.getResponse()).toMatchObject({ code: 'READINESS_REQUEST_FAILED' });
    }
  });

  it('flattens sections[].fields[] to issues[] and guarantees JSON depth <= 5', async () => {
    function getJsonDepth(value: unknown): number {
      if (value === null || typeof value !== 'object') {
        return 0;
      }
      const values = Array.isArray(value) ? value : Object.values(value);
      if (values.length === 0) {
        return 1;
      }
      return 1 + Math.max(...values.map(getJsonDepth));
    }

    const rawOffer = { passengers: [{ id: 'offer-passenger-1' }] };
    prismaService.flightOffer.findUnique.mockResolvedValueOnce({ id: 'offer-1', rawOffer });

    bookingReadinessService.getAdvisoryReadiness.mockResolvedValueOnce({
      scope: 'INTERNATIONAL',
      ready: false,
      passengers: [
        {
          passengerType: PassengerType.ADULT,
          passengerOrdinal: 1,
          ready: false,
          sections: [
            {
              name: 'identity',
              fields: [
                { name: 'givenName', status: 'filled', reason: null },
                { name: 'familyName', status: 'filled', reason: null },
              ],
            },
            {
              name: 'travel_document',
              fields: [
                { name: 'passportNumber', status: 'missing', reason: 'REQUIRED' },
              ],
            },
          ],
        },
      ],
    });

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-1';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
    ];

    const result = await service.checkBookingReadiness('user-1', dto);

    expect(result.passengers[0].issues).toEqual([
      { section: 'identity', name: 'givenName', status: 'filled', reason: null },
      { section: 'identity', name: 'familyName', status: 'filled', reason: null },
      { section: 'travel_document', name: 'passportNumber', status: 'missing', reason: 'REQUIRED' },
    ]);
    expect((result.passengers[0] as any).sections).toBeUndefined();
    expect(getJsonDepth(result)).toBeLessThanOrEqual(5);
  });
});

describe('Raw-Reader Replacement Parity (T015)', () => {
  let service: AgentBookingReadinessService;
  let prismaService: {
    flightOffer: { findUnique: jest.Mock };
  };
  let profileService: { getProfile: jest.Mock };
  let bookingReadinessService: { getAdvisoryReadiness: jest.Mock };
  let observability: { recordOutcome: jest.Mock };
  let auditService: { createLog: jest.Mock };
  let agentToolAuditService: { recordToolExecution: jest.Mock };

  beforeEach(async () => {
    prismaService = {
      flightOffer: { findUnique: jest.fn() },
    };
    profileService = { getProfile: jest.fn() };
    bookingReadinessService = { getAdvisoryReadiness: jest.fn() };
    observability = { recordOutcome: jest.fn() };
    auditService = { createLog: jest.fn() };
    agentToolAuditService = {
      recordToolExecution: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentBookingReadinessService,
        { provide: PrismaService, useValue: prismaService },
        { provide: ProfileService, useValue: profileService },
        { provide: BookingReadinessService, useValue: bookingReadinessService },
        { provide: BookingReadinessObservability, useValue: observability },
        { provide: AuditService, useValue: auditService },
        { provide: AgentToolAuditService, useValue: agentToolAuditService },
      ],
    }).compile();

    service = module.get<AgentBookingReadinessService>(AgentBookingReadinessService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  type RawOfferShape = {
    passengers?: Array<{ id?: string }>;
  };

  function existingReaderPassengerId(
    rawOffer: unknown,
    passengerOrdinal: number,
  ): string | undefined {
    const candidate = rawOffer as RawOfferShape | null;
    return candidate?.passengers?.[passengerOrdinal - 1]?.id;
  }

  function portNormalizedPassengerId(
    rawOffer: unknown,
    passengerOrdinal: number,
  ): string | undefined {
    const normalized = FlightOfferNormalizer.normalizeStoredOffer(rawOffer);
    return normalized?.passengers[passengerOrdinal - 1]?.supplierPassengerId;
  }

  const validSinglePassengerRawOffer: Record<string, unknown> = {
    id: 'off_single_001',
    total_amount: '200.00',
    total_currency: 'USD',
    expires_at: '2030-10-01T12:00:00Z',
    passengers: [{ id: 'pas_single_1', type: 'adult' }],
    slices: [
      {
        duration: 'PT2H',
        segments: [
          {
            id: 'seg_1',
            origin: { iata_code: 'SGN' },
            destination: { iata_code: 'DAD' },
            departing_at: '2030-10-15T09:00:00Z',
            arriving_at: '2030-10-15T11:00:00Z',
            duration: 'PT2H',
            marketing_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
            marketing_carrier_flight_number: '123',
          },
        ],
      },
    ],
  };

  const validMultiPassengerRawOffer: Record<string, unknown> = {
    id: 'off_multi_001',
    total_amount: '600.00',
    total_currency: 'USD',
    expires_at: '2030-10-01T12:00:00Z',
    passengers: [
      { id: 'pas_multi_1', type: 'adult' },
      { id: 'pas_multi_2', type: 'adult' },
      { id: 'pas_multi_3', type: 'child' },
    ],
    slices: [
      {
        duration: 'PT2H',
        segments: [
          {
            id: 'seg_1',
            origin: { iata_code: 'SGN' },
            destination: { iata_code: 'HAN' },
            departing_at: '2030-10-15T09:00:00Z',
            arriving_at: '2030-10-15T11:00:00Z',
            duration: 'PT2H',
            marketing_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
            marketing_carrier_flight_number: '123',
          },
        ],
      },
    ],
  };

  it('characterizes ordinal-to-passenger mapping for single-passenger offers: 100% parity', async () => {
    const rawId = existingReaderPassengerId(validSinglePassengerRawOffer, 1);
    const portId = portNormalizedPassengerId(validSinglePassengerRawOffer, 1);

    expect(rawId).toBe('pas_single_1');
    expect(portId).toBe('pas_single_1');
    expect(portId).toBe(rawId);

    // Out of bounds ordinal returns undefined for both
    expect(existingReaderPassengerId(validSinglePassengerRawOffer, 2)).toBeUndefined();
    expect(portNormalizedPassengerId(validSinglePassengerRawOffer, 2)).toBeUndefined();

    prismaService.flightOffer.findUnique.mockResolvedValueOnce({
      id: 'offer-single',
      rawOffer: validSinglePassengerRawOffer,
    });
    bookingReadinessService.getAdvisoryReadiness.mockResolvedValueOnce({
      scope: 'DOMESTIC',
      ready: true,
      passengers: [],
    });

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-single';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
    ];

    await service.checkBookingReadiness('user-1', dto);

    expect(bookingReadinessService.getAdvisoryReadiness).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        flightOfferId: 'offer-single',
        passengers: [
          expect.objectContaining({
            offerPassengerId: portId,
            passengerType: PassengerType.ADULT,
          }),
        ],
      }),
      expect.any(Object),
    );
  });

  it('characterizes ordinal-to-passenger mapping across multi-passenger offers: 100% parity across ordinals', async () => {
    const ordinals = [1, 2, 3];
    for (const ordinal of ordinals) {
      const rawId = existingReaderPassengerId(validMultiPassengerRawOffer, ordinal);
      const portId = portNormalizedPassengerId(validMultiPassengerRawOffer, ordinal);

      expect(portId).toBeDefined();
      expect(portId).toBe(rawId);
    }

    // Ordinal 4 is out of bounds
    expect(existingReaderPassengerId(validMultiPassengerRawOffer, 4)).toBeUndefined();
    expect(portNormalizedPassengerId(validMultiPassengerRawOffer, 4)).toBeUndefined();

    prismaService.flightOffer.findUnique.mockResolvedValueOnce({
      id: 'offer-multi',
      rawOffer: validMultiPassengerRawOffer,
    });
    bookingReadinessService.getAdvisoryReadiness.mockResolvedValueOnce({
      scope: 'DOMESTIC',
      ready: true,
      passengers: [],
    });

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-multi';
    dto.passengers = [
      { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
      { passengerType: PassengerType.ADULT, passengerOrdinal: 2, sourceType: 'inline' },
      { passengerType: PassengerType.CHILD, passengerOrdinal: 3, sourceType: 'inline' },
    ];

    await service.checkBookingReadiness('user-1', dto);

    expect(bookingReadinessService.getAdvisoryReadiness).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        flightOfferId: 'offer-multi',
        passengers: [
          expect.objectContaining({ offerPassengerId: 'pas_multi_1' }),
          expect.objectContaining({ offerPassengerId: 'pas_multi_2' }),
          expect.objectContaining({ offerPassengerId: 'pas_multi_3' }),
        ],
      }),
      expect.any(Object),
    );
  });

  it('characterizes malformed stored offer rejection: normalizeStoredOffer returns null matching the trigger for OFFER_MALFORMED (422)', async () => {
    const offerMalformedPayloads: readonly unknown[] = [
      null,
      undefined,
      {},
      { passengers: 'not-an-array' },
      { passengers: null },
      { passengers: 123 },
      { id: 'bad-1', total_amount: '0', total_currency: 'USD', slices: [] },
      { id: 'bad-2', total_amount: '100', total_currency: '', slices: [] },
    ];

    for (const malformed of offerMalformedPayloads) {
      expect(FlightOfferNormalizer.normalizeStoredOffer(malformed)).toBeNull();

      prismaService.flightOffer.findUnique.mockResolvedValueOnce({
        id: 'offer-malformed',
        rawOffer: malformed,
      });

      const dto = new AgentBookingReadinessRequestDto();
      dto.flightOfferId = 'offer-malformed';
      dto.passengers = [
        { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
      ];

      await expect(service.checkBookingReadiness('user-1', dto)).rejects.toThrow(HttpException);

      prismaService.flightOffer.findUnique.mockResolvedValueOnce({
        id: 'offer-malformed',
        rawOffer: malformed,
      });

      try {
        await service.checkBookingReadiness('user-1', dto);
        throw new Error('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        const response = httpErr.getResponse() as Record<string, unknown>;
        expect(response.code).toBe('OFFER_MALFORMED');
      }
    }

    // Additional corrupted payloads with empty/malformed slices or passengers also return null
    const additionalCorruptedPayloads: readonly unknown[] = [
      {
        id: 'bad-3',
        total_amount: '100',
        total_currency: 'USD',
        slices: [{ segments: [] }],
        passengers: [{ id: 'p1', type: 'adult' }],
      },
      {
        id: 'bad-4',
        total_amount: '100',
        total_currency: 'USD',
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HNL' },
                departing_at: 'bad-iso',
                arriving_at: '2030-08-15T13:00:00Z',
              },
            ],
          },
        ],
        passengers: [{ id: 'p1', type: 'adult' }],
      },
    ];

    for (const corrupted of additionalCorruptedPayloads) {
      expect(FlightOfferNormalizer.normalizeStoredOffer(corrupted)).toBeNull();
    }
  });
});

