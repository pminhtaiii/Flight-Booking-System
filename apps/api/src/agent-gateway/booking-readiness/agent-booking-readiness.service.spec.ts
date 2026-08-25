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
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' }];

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
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' }];

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
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 2, sourceType: 'inline' }];

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
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'traveler_profile' }];

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
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' }];

    const result = await service.checkBookingReadiness('user-1', dto, 'trace-1', 'corr-1');

    expect(result).toEqual({
      scope: 'DOMESTIC',
      ready: true,
      passengers: [
        {
          passengerType: PassengerType.ADULT,
          passengerOrdinal: 1,
          sections: [
            {
              name: 'identity',
              fields: [{ name: 'givenName', status: 'filled', reason: null }],
            },
          ],
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
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'traveler_profile' }];

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
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'traveler_profile' }];

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
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' }];

    const result = await service.checkBookingReadiness('user-1', dto);

    expect(result.ready).toBe(false);
    expect(result.nextAction).toBe('CONTINUE_CHECKOUT');
  });

  it('records a PII-safe error outcome when the readiness service throws a value-bearing error', async () => {
    prismaService.flightOffer.findUnique.mockResolvedValueOnce({
      rawOffer: { passengers: [{ id: 'offer-passenger-1' }] },
    });
    bookingReadinessService.getAdvisoryReadiness.mockRejectedValueOnce(
      new HttpException({ code: 'DEPENDENCY_ERROR', message: 'Ada Lovelace passport 123456789' }, 503),
    );

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-id';
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' }];

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
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' }];

    await expect(service.checkBookingReadiness('user-1', dto)).rejects.toThrow(HttpException);

    try {
      prismaService.flightOffer.findUnique.mockRejectedValueOnce(new Error('DB failure'));
      await service.checkBookingReadiness('user-1', dto);
    } catch (err: any) {
      expect(err.getStatus()).toBe(500);
      expect(err.getResponse()).toMatchObject({ code: 'READINESS_REQUEST_FAILED' });
    }
  });
});
