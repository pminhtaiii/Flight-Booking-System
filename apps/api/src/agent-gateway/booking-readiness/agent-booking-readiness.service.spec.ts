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
import type { FlightOffer as SupplierFlightOffer } from '@/supplier/search/flight-search.port';

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

describe('AgentBookingReadinessService raw-reader replacement parity (T015)', () => {
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

  function resolveOrdinalFromRawOffer(rawOffer: unknown, ordinal: number): string | null {
    if (
      typeof rawOffer !== 'object' ||
      rawOffer === null ||
      !('passengers' in rawOffer) ||
      !Array.isArray((rawOffer as { passengers: unknown }).passengers)
    ) {
      return null;
    }
    const passengers = (rawOffer as { passengers: Array<{ id?: string }> }).passengers;
    const index = ordinal - 1;
    return passengers[index]?.id ?? null;
  }

  function resolveOrdinalFromNormalizedOffer(
    offer: SupplierFlightOffer | null,
    ordinal: number,
  ): string | null {
    if (!offer || !Array.isArray(offer.passengers)) return null;
    const index = ordinal - 1;
    return offer.passengers[index]?.supplierPassengerId ?? null;
  }

  function buildNormalizedFlightOffer(
    passengers: Array<{ id: string; type: 'ADULT' | 'CHILD' | 'INFANT' }>,
  ): SupplierFlightOffer {
    return {
      id: 'offer-t015-agent',
      supplierOfferId: 'off_supp_1',
      totalAmount: '200.00',
      price: 200,
      currency: 'USD',
      offerExpiresAt: '2030-12-31T23:59:59Z',
      passengers: passengers.map((p) => ({
        supplierPassengerId: p.id,
        type: p.type,
      })),
      airline: 'Delta',
      flightNumber: 'DL123',
      departureAirport: 'SGN',
      arrivalAirport: 'NRT',
      departureTime: '2030-10-15T12:00:00Z',
      arrivalTime: '2030-10-15T18:00:00Z',
      duration: 360,
      stops: 0,
      fareClass: 'Y',
      baggageAllowance: '1 checked bag',
      segments: [],
      returnSegments: null,
      conditions: { refundable: true, changeable: true, changeBeforeDeparture: null },
      matchInput: {
        id: 'offer-t015-agent',
        price: 200,
        currency: 'USD',
        stops: 0,
        duration: 360,
        outboundDepartureHour: 12,
        outboundArrivalHour: 18,
        carrierCodes: ['DL'],
        cabinClass: 'economy',
        hasCheckedBaggage: true,
        originalIndex: 0,
      },
      rawSupplierPayload: {},
    };
  }

  describe('passenger ordinal to offerPassengerId mapping parity', () => {
    it('characterizes identical ordinal resolution between raw offer and normalized FlightOffer.passengers', async () => {
      const rawPassengers = [
        { id: 'pas_alpha', type: 'adult' },
        { id: 'pas_beta', type: 'child' },
      ];
      const rawOffer = { passengers: rawPassengers };
      const normalizedOffer = buildNormalizedFlightOffer([
        { id: 'pas_alpha', type: 'ADULT' },
        { id: 'pas_beta', type: 'CHILD' },
      ]);

      // Assert ordinal 1 parity
      const rawP1 = resolveOrdinalFromRawOffer(rawOffer, 1);
      const normP1 = resolveOrdinalFromNormalizedOffer(normalizedOffer, 1);
      expect(rawP1).toBe('pas_alpha');
      expect(normP1).toBe('pas_alpha');
      expect(rawP1).toBe(normP1);

      // Assert ordinal 2 parity
      const rawP2 = resolveOrdinalFromRawOffer(rawOffer, 2);
      const normP2 = resolveOrdinalFromNormalizedOffer(normalizedOffer, 2);
      expect(rawP2).toBe('pas_beta');
      expect(normP2).toBe('pas_beta');
      expect(rawP2).toBe(normP2);

      // Verify execution through checkBookingReadiness
      prismaService.flightOffer.findUnique.mockResolvedValueOnce({
        id: 'offer-parity-1',
        rawOffer,
      });

      bookingReadinessService.getAdvisoryReadiness.mockResolvedValueOnce({
        scope: 'INTERNATIONAL',
        ready: true,
        passengers: [
          {
            passengerType: PassengerType.ADULT,
            passengerOrdinal: 1,
            ready: true,
            sections: [],
          },
          {
            passengerType: PassengerType.CHILD,
            passengerOrdinal: 2,
            ready: true,
            sections: [],
          },
        ],
      });

      const dto = new AgentBookingReadinessRequestDto();
      dto.flightOfferId = 'offer-parity-1';
      dto.passengers = [
        { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
        { passengerType: PassengerType.CHILD, passengerOrdinal: 2, sourceType: 'inline' },
      ];

      const response = await service.checkBookingReadiness('user-1', dto);

      // Verify the internal DTO sent to bookingReadinessService mapped offerPassengerId identically
      const internalDto = bookingReadinessService.getAdvisoryReadiness.mock.calls[0][1] as {
        passengers: Array<{ offerPassengerId: string; passengerType: PassengerType }>;
      };
      expect(internalDto.passengers[0].offerPassengerId).toBe(normP1);
      expect(internalDto.passengers[1].offerPassengerId).toBe(normP2);

      // Verify identical AgentBookingReadinessResponseDto projection
      expect(response).toEqual({
        scope: 'INTERNATIONAL',
        ready: true,
        passengers: [
          { passengerType: PassengerType.ADULT, passengerOrdinal: 1, issues: [] },
          { passengerType: PassengerType.CHILD, passengerOrdinal: 2, issues: [] },
        ],
        nextAction: 'CONTINUE_CHECKOUT',
      });
    });

    it('characterizes identical failure code PASSENGER_MAPPING_INVALID when ordinal is missing or mismatched', async () => {
      const rawOffer = { passengers: [{ id: 'pas_only_one' }] };
      const normalizedOffer = buildNormalizedFlightOffer([{ id: 'pas_only_one', type: 'ADULT' }]);

      // Ordinal out of bounds (ordinal 2 on 1-passenger offer)
      const rawMissing = resolveOrdinalFromRawOffer(rawOffer, 2);
      const normMissing = resolveOrdinalFromNormalizedOffer(normalizedOffer, 2);
      expect(rawMissing).toBeNull();
      expect(normMissing).toBeNull();

      // Ordinal 0 (invalid 1-indexed ordinal)
      const rawZero = resolveOrdinalFromRawOffer(rawOffer, 0);
      const normZero = resolveOrdinalFromNormalizedOffer(normalizedOffer, 0);
      expect(rawZero).toBeNull();
      expect(normZero).toBeNull();

      prismaService.flightOffer.findUnique.mockResolvedValueOnce({
        id: 'offer-invalid-ordinal',
        rawOffer,
      });

      const dto = new AgentBookingReadinessRequestDto();
      dto.flightOfferId = 'offer-invalid-ordinal';
      dto.passengers = [
        { passengerType: PassengerType.ADULT, passengerOrdinal: 2, sourceType: 'inline' },
      ];

      let thrownError: unknown = null;
      try {
        await service.checkBookingReadiness('user-1', dto);
      } catch (err: unknown) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(HttpException);
      const httpErr = thrownError as HttpException;
      expect(httpErr.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      const res = httpErr.getResponse() as { code?: string; message?: string };
      expect(res.code).toBe('PASSENGER_MAPPING_INVALID');
      expect(res.message).toContain('ordinal 2');
    });

    it('characterizes identical failure code OFFER_MALFORMED when offer data is corrupted', async () => {
      const corruptedRawScenarios = [
        { label: 'missing passengers field', rawOffer: {} },
        { label: 'passengers is not an array', rawOffer: { passengers: 'corrupted-string' } },
        { label: 'rawOffer is null', rawOffer: null },
      ];

      for (const scenario of corruptedRawScenarios) {
        prismaService.flightOffer.findUnique.mockResolvedValueOnce({
          id: 'offer-corrupted',
          rawOffer: scenario.rawOffer,
        });

        // Corrupted offer yields null normalized offer
        const normResult = resolveOrdinalFromNormalizedOffer(null, 1);
        expect(normResult).toBeNull();

        const dto = new AgentBookingReadinessRequestDto();
        dto.flightOfferId = 'offer-corrupted';
        dto.passengers = [
          { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' },
        ];

        let thrownError: unknown = null;
        try {
          await service.checkBookingReadiness('user-1', dto);
        } catch (err: unknown) {
          thrownError = err;
        }

        expect(thrownError).toBeInstanceOf(HttpException);
        const httpErr = thrownError as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        const res = httpErr.getResponse() as { code?: string; message?: string };
        expect(res.code).toBe('OFFER_MALFORMED');
        expect(res.message).toBe('Stored offer data is malformed');
      }
    });

    it('characterizes traveler_profile passenger sourcing attestation parity', async () => {
      const rawOffer = { passengers: [{ id: 'pas_prof_1' }] };
      const normalizedOffer = buildNormalizedFlightOffer([{ id: 'pas_prof_1', type: 'ADULT' }]);

      const expectedOfferPassengerId = resolveOrdinalFromNormalizedOffer(normalizedOffer, 1);
      expect(expectedOfferPassengerId).toBe('pas_prof_1');

      profileService.getProfile.mockResolvedValueOnce({ profileId: 'profile-primary' });
      prismaService.flightOffer.findUnique.mockResolvedValueOnce({
        id: 'offer-profile-test',
        rawOffer,
      });

      bookingReadinessService.getAdvisoryReadiness.mockResolvedValueOnce({
        scope: 'DOMESTIC',
        ready: true,
        passengers: [
          {
            passengerType: PassengerType.ADULT,
            passengerOrdinal: 1,
            ready: true,
            sections: [],
          },
        ],
      });

      const dto = new AgentBookingReadinessRequestDto();
      dto.flightOfferId = 'offer-profile-test';
      dto.passengers = [
        { passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'traveler_profile' },
      ];

      const response = await service.checkBookingReadiness('user-1', dto);

      const internalDto = bookingReadinessService.getAdvisoryReadiness.mock.calls[0][1] as {
        passengers: Array<{
          offerPassengerId: string;
          passengerType: PassengerType;
          source: { type: string; travelerProfileId?: string };
        }>;
      };

      expect(internalDto.passengers[0].offerPassengerId).toBe(expectedOfferPassengerId);
      expect(internalDto.passengers[0].source).toEqual({
        type: 'traveler_profile',
        travelerProfileId: 'profile-primary',
      });
      expect(response.nextAction).toBe('CONTINUE_CHECKOUT');
    });
  });
});
