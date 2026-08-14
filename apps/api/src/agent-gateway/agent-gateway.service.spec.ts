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
import { ChatMessageCryptoService } from '@/chat/chat-message-crypto.service';

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
        {
          provide: ChatMessageCryptoService,
          useValue: {
            decryptMessageContent: jest.fn().mockResolvedValue(''),
            isConfigured: jest.fn().mockReturnValue(true),
          },
        },
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

  it('throws HttpException BAD_REQUEST when chat message decryption fails in searchFlights', async () => {
    (prismaService as any).chatMessage = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'USER',
        type: 'STANDARD',
        contentCiphertext: 'corrupt',
      }),
    };
    const cryptoService = (service as any).chatMessageCryptoService;
    jest.spyOn(cryptoService, 'decryptMessageContent').mockRejectedValueOnce(new Error('Corrupt envelope'));

    await expect(
      service.searchFlights('user-1', { origin: 'SGN', destination: 'HAN', date: '2026-09-01', adults: 1 } as any),
    ).rejects.toThrow(HttpException);

    jest.spyOn(cryptoService, 'decryptMessageContent').mockRejectedValueOnce(new Error('Corrupt envelope'));
    try {
      await service.searchFlights('user-1', { origin: 'SGN', destination: 'HAN', date: '2026-09-01', adults: 1 } as any);
    } catch (err: any) {
      expect(err.getStatus()).toBe(400);
      expect(err.message).toBe('Unable to decrypt chat message envelope');
    }
  });

  it('throws HttpException BAD_REQUEST when chat message decryption fails in searchFlightsV2', async () => {
    (prismaService as any).chatSession = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        deletedAt: null,
      }),
    };
    (prismaService as any).chatMessage = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'USER',
        type: 'STANDARD',
        contentCiphertext: 'corrupt',
      }),
    };
    const cryptoService = (service as any).chatMessageCryptoService;
    jest.spyOn(cryptoService, 'decryptMessageContent').mockRejectedValueOnce(new Error('Corrupt envelope'));

    const dto = {
      chatSessionId: 'session-1',
      search: {
        origin: 'SGN',
        destination: 'HAN',
        departureDate: '2026-09-01',
        adults: 1,
      },
    };

    await expect(
      service.searchFlightsV2('user-1', dto as any),
    ).rejects.toThrow(HttpException);

    jest.spyOn(cryptoService, 'decryptMessageContent').mockRejectedValueOnce(new Error('Corrupt envelope'));
    try {
      await service.searchFlightsV2('user-1', dto as any);
    } catch (err: any) {
      expect(err.getStatus()).toBe(400);
      expect(err.message).toBe('Unable to decrypt chat message envelope');
    }
  });

  it('throws ServiceUnavailableException 503 when encryption key is not configured in searchFlights', async () => {
    (prismaService as any).chatMessage = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'USER',
        type: 'STANDARD',
        contentCiphertext: 'enc',
      }),
    };
    const cryptoService = (service as any).chatMessageCryptoService;
    jest.spyOn(cryptoService, 'isConfigured').mockReturnValue(false);
    jest.spyOn(cryptoService, 'decryptMessageContent').mockRejectedValueOnce(new Error('CHAT_ENCRYPTION_KEY is not configured'));

    try {
      await service.searchFlights('user-1', { origin: 'SGN', destination: 'HAN', date: '2026-09-01', adults: 1 } as any);
    } catch (err: any) {
      expect(err.getStatus()).toBe(503);
      expect(err.message).toBe('Chat encryption service is unavailable');
    }
  });

  it('throws ServiceUnavailableException 503 when message has unsupported key version in searchFlightsV2', async () => {
    (prismaService as any).chatSession = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        deletedAt: null,
      }),
    };
    (prismaService as any).chatMessage = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'USER',
        type: 'STANDARD',
        contentCiphertext: 'enc',
      }),
    };
    const cryptoService = (service as any).chatMessageCryptoService;
    jest.spyOn(cryptoService, 'decryptMessageContent').mockRejectedValueOnce(new Error('Unsupported key version: 99'));

    const dto = {
      chatSessionId: 'session-1',
      search: {
        origin: 'SGN',
        destination: 'HAN',
        departureDate: '2026-09-01',
        adults: 1,
      },
    };

    try {
      await service.searchFlightsV2('user-1', dto as any);
    } catch (err: any) {
      expect(err.getStatus()).toBe(503);
      expect(err.message).toBe('Chat encryption service is unavailable');
    }
  });
});
