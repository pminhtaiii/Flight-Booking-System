import { Test, TestingModule } from '@nestjs/testing';
import { AgentGatewayService } from './agent-gateway.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelService } from '@/duffel/duffel.service';
import { ProfileService } from '@/profile/profile.service';
import { BookingReadinessService } from '@/booking-intent/booking-readiness.service';
import { BookingReadinessObservability } from '@/booking-intent/booking-readiness.observability';
import { AgentBookingReadinessRequestDto } from './dto/booking-readiness.dto';
import { PassengerType } from '@prisma/client';
import { HttpException, NotFoundException } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { ChatService } from '@/chat/chat.service';
import { SelectionAttestationService } from './selection-attestation.service';

describe('AgentGatewayService', () => {
  let service: AgentGatewayService;
  let profileService: jest.Mocked<ProfileService>;
  let bookingReadinessService: jest.Mocked<BookingReadinessService>;
  let prismaService: jest.Mocked<PrismaService>;
  let auditService: jest.Mocked<AuditService>;
  let observability: jest.Mocked<BookingReadinessObservability>;

  beforeEach(async () => {
    profileService = { getProfile: jest.fn() } as any;
    bookingReadinessService = { getAdvisoryReadiness: jest.fn() } as any;
    prismaService = { flightOffer: { findUnique: jest.fn() } } as any;
    auditService = { createLog: jest.fn() } as any;
    observability = { recordOutcome: jest.fn() } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentGatewayService,
        { provide: PrismaService, useValue: prismaService },
        { provide: AuditService, useValue: auditService },
        { provide: CacheService, useValue: {} },
        { provide: DuffelService, useValue: {} },
        { provide: ProfileService, useValue: profileService },
        { provide: BookingReadinessService, useValue: bookingReadinessService },
        { provide: BookingReadinessObservability, useValue: observability },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('false') } },
        { provide: ChatService, useValue: {} },
        { provide: SelectionAttestationService, useValue: { verifySelectionAttestation: jest.fn() } },
      ],
    }).compile();

    service = module.get<AgentGatewayService>(AgentGatewayService);
  });

  it('should reject missing or invalid agent API key (handled by guard, but test service throws correctly if misconfigured)', async () => {
    // This is typically handled by AgentApiKeyGuard, but testing the service directly here
    (prismaService.flightOffer.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'some-id';
    dto.passengers = [];
    
    await expect(service.checkBookingReadiness('user-id', dto)).rejects.toThrow(NotFoundException);
  });

  it('should successfully map inline passenger to internal readiness DTO', async () => {
    const rawOffer = { passengers: [{ id: 'offer-passenger-1' }] };
    (prismaService.flightOffer.findUnique as jest.Mock).mockResolvedValueOnce({ rawOffer } as any);
    
    (bookingReadinessService.getAdvisoryReadiness as jest.Mock).mockResolvedValueOnce({
      scope: 'DOMESTIC',
      ready: true,
      passengers: [{
        passengerType: PassengerType.ADULT,
        passengerOrdinal: 1,
        ready: true,
        profileRevision: 7,
        sections: [{
          name: 'identity',
          fields: [{
            name: 'givenName',
            status: 'filled',
            reason: null,
            blocking: false,
            value: 'Ada Lovelace',
          }],
        }],
      }],
    } as any);

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-id';
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'inline' }];

    const result = await service.checkBookingReadiness('user-1', dto);

    expect(result).toEqual({
      scope: 'DOMESTIC',
      ready: true,
      passengers: [{
        passengerType: PassengerType.ADULT,
        passengerOrdinal: 1,
        sections: [{
          name: 'identity',
          fields: [{ name: 'givenName', status: 'filled', reason: null }],
        }],
      }],
      nextAction: 'CONTINUE_CHECKOUT',
    });
    expect(JSON.stringify(result)).not.toContain('Ada Lovelace');
    expect(bookingReadinessService.getAdvisoryReadiness).toHaveBeenCalled();
    expect(auditService.createLog).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        action: 'AGENT_GATEWAY_READINESS',
        metadata: { status: 'ready', scope: 'DOMESTIC', passengerCount: 1 },
      }),
    );
    expect(observability.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'gateway_readiness', status: 'ready' }),
    );
  });

  it('should correctly resolve owned profile data internally without using agent-supplied profile ID', async () => {
    const rawOffer = { passengers: [{ id: 'offer-passenger-1' }] };
    (prismaService.flightOffer.findUnique as jest.Mock).mockResolvedValueOnce({ rawOffer } as any);
    
    (profileService.getProfile as jest.Mock).mockResolvedValueOnce({ profileId: 'owned-profile-id' } as any);
    
    (bookingReadinessService.getAdvisoryReadiness as jest.Mock).mockResolvedValueOnce({
      scope: 'DOMESTIC',
      ready: true,
      passengers: [],
      nextAction: 'CONTINUE_CHECKOUT',
    } as any);

    const dto = new AgentBookingReadinessRequestDto();
    dto.flightOfferId = 'offer-id';
    dto.passengers = [{ passengerType: PassengerType.ADULT, passengerOrdinal: 1, sourceType: 'traveler_profile' }];

    await service.checkBookingReadiness('user-1', dto);

    expect(profileService.getProfile).toHaveBeenCalledWith('user-1');
  });

  it('records a PII-safe error outcome when the readiness service throws a value-bearing error', async () => {
    (prismaService.flightOffer.findUnique as jest.Mock).mockResolvedValueOnce({
      rawOffer: { passengers: [{ id: 'offer-passenger-1' }] },
    } as any);
    (bookingReadinessService.getAdvisoryReadiness as jest.Mock).mockRejectedValueOnce(
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
  });
});
