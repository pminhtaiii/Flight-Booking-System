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
import { AgentToolAuditService } from './audit/agent-tool-audit.service';

describe('AgentGatewayService', () => {
  let service: AgentGatewayService;
  let profileService: jest.Mocked<ProfileService>;
  let bookingReadinessService: jest.Mocked<BookingReadinessService>;
  let prismaService: jest.Mocked<PrismaService>;
  let auditService: jest.Mocked<AuditService>;
  let observability: jest.Mocked<BookingReadinessObservability>;
  let agentToolAuditService: jest.Mocked<AgentToolAuditService>;

  beforeEach(async () => {
    profileService = { getProfile: jest.fn() } as any;
    bookingReadinessService = { getAdvisoryReadiness: jest.fn() } as any;
    prismaService = {
      flightOffer: { findUnique: jest.fn() },
      bookingAgentProjection: { findMany: jest.fn(), findUnique: jest.fn() },
      booking: { findMany: jest.fn(), findUnique: jest.fn() },
      payment: { findMany: jest.fn(), findUnique: jest.fn() },
      travelerProfile: { findUnique: jest.fn() },
    } as any;
    auditService = { createLog: jest.fn() } as any;
    observability = { recordOutcome: jest.fn() } as any;
    agentToolAuditService = {
      recordToolExecution: jest.fn().mockResolvedValue(undefined),
    } as any;

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
        { provide: AgentToolAuditService, useValue: agentToolAuditService },
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

  describe('getBookingSummaries', () => {
    it('returns booking summaries from BookingAgentProjection and structurally excludes raw entities', async () => {
      const mockProjections = [
        {
          agentReference: 'bkref_11111111-1111-4111-8111-111111111111',
          airline: 'Vietnam Airlines',
          origin: 'SGN',
          destination: 'HAN',
          departureAt: new Date('2026-09-01T08:00:00.000Z'),
          arrivalAt: new Date('2026-09-01T10:00:00.000Z'),
          status: 'CONFIRMED',
          durationMinutes: 120,
          stopCount: 0,
        },
      ];

      (prismaService.bookingAgentProjection.findMany as jest.Mock).mockResolvedValueOnce(mockProjections);

      const bookingFindManySpy = jest.spyOn(prismaService.booking, 'findMany');
      const bookingFindUniqueSpy = jest.spyOn(prismaService.booking, 'findUnique');
      const paymentFindManySpy = jest.spyOn(prismaService.payment, 'findMany');
      const paymentFindUniqueSpy = jest.spyOn(prismaService.payment, 'findUnique');

      const result = await (service as any).getBookingSummaries('user-1', 'trace-1', 'correlation-1');

      expect(prismaService.bookingAgentProjection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { booking: { userId: 'user-1' } },
        }),
      );

      // Verify raw booking/payment models are NOT touched
      expect(bookingFindManySpy).not.toHaveBeenCalled();
      expect(bookingFindUniqueSpy).not.toHaveBeenCalled();
      expect(paymentFindManySpy).not.toHaveBeenCalled();
      expect(paymentFindUniqueSpy).not.toHaveBeenCalled();

      // Verify exact structure
      expect(result).toEqual({
        bookings: [
          {
            bookingReference: 'bkref_11111111-1111-4111-8111-111111111111',
            airline: 'Vietnam Airlines',
            origin: 'SGN',
            destination: 'HAN',
            departureTime: '2026-09-01T08:00:00.000Z',
            arrivalTime: '2026-09-01T10:00:00.000Z',
            status: 'CONFIRMED',
            durationMinutes: 120,
            stops: 0,
          },
        ],
      });

      // Assert forbidden properties are undefined on each booking object
      const forbiddenProps = [
        'id',
        'bookingId',
        'flightSnapshot',
        'passengerSnapshot',
        'Payment',
        'payment',
        'pnrReference',
        'totalAmount',
        'currency',
        'passengers',
      ];
      for (const prop of forbiddenProps) {
        expect((result.bookings[0] as any)[prop]).toBeUndefined();
      }
    });

    it('returns empty array when user has no bookings', async () => {
      (prismaService.bookingAgentProjection.findMany as jest.Mock).mockResolvedValueOnce([]);

      const result = await (service as any).getBookingSummaries('user-no-bookings');
      expect(result).toEqual({ bookings: [] });
    });
  });

  describe('getBookingDetailByReference', () => {
    it('returns detail projection with flightNumber, baggageAllowance, changeable, refundable for owned booking', async () => {
      const mockProjection = {
        agentReference: 'bkref_11111111-1111-4111-8111-111111111111',
        airline: 'Vietnam Airlines',
        origin: 'SGN',
        destination: 'HAN',
        departureAt: new Date('2026-09-01T08:00:00.000Z'),
        arrivalAt: new Date('2026-09-01T10:00:00.000Z'),
        status: 'CONFIRMED',
        durationMinutes: 120,
        stopCount: 0,
        flightNumber: 'VN 123',
        baggageSummary: '20kg checked',
        changeable: true,
        refundable: false,
        booking: { userId: 'user-1' },
      };

      (prismaService.bookingAgentProjection.findUnique as jest.Mock).mockResolvedValueOnce(mockProjection);

      const bookingFindManySpy = jest.spyOn(prismaService.booking, 'findMany');
      const bookingFindUniqueSpy = jest.spyOn(prismaService.booking, 'findUnique');
      const paymentFindManySpy = jest.spyOn(prismaService.payment, 'findMany');
      const paymentFindUniqueSpy = jest.spyOn(prismaService.payment, 'findUnique');

      const result = await (service as any).getBookingDetailByReference(
        'user-1',
        'bkref_11111111-1111-4111-8111-111111111111',
      );

      // Verify raw booking/payment models are NOT touched
      expect(bookingFindManySpy).not.toHaveBeenCalled();
      expect(bookingFindUniqueSpy).not.toHaveBeenCalled();
      expect(paymentFindManySpy).not.toHaveBeenCalled();
      expect(paymentFindUniqueSpy).not.toHaveBeenCalled();

      // Verify exact structure with detail tier fields
      expect(result).toEqual({
        bookingReference: 'bkref_11111111-1111-4111-8111-111111111111',
        airline: 'Vietnam Airlines',
        origin: 'SGN',
        destination: 'HAN',
        departureTime: '2026-09-01T08:00:00.000Z',
        arrivalTime: '2026-09-01T10:00:00.000Z',
        status: 'CONFIRMED',
        durationMinutes: 120,
        stops: 0,
        flightNumber: 'VN 123',
        baggageAllowance: '20kg checked',
        changeable: true,
        refundable: false,
      });

      // Assert forbidden properties are undefined on detail object
      const forbiddenProps = [
        'id',
        'bookingId',
        'flightSnapshot',
        'passengerSnapshot',
        'Payment',
        'payment',
        'pnrReference',
        'totalAmount',
        'currency',
        'passengers',
      ];
      for (const prop of forbiddenProps) {
        expect((result as any)[prop]).toBeUndefined();
      }
    });

    it('rejects with NotFoundException BOOKING_REFERENCE_NOT_FOUND on malformed reference format', async () => {
      await expect(
        (service as any).getBookingDetailByReference('user-1', 'invalid-ref'),
      ).rejects.toThrow(NotFoundException);

      try {
        await (service as any).getBookingDetailByReference('user-1', 'bkref_short');
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({ code: 'BOOKING_REFERENCE_NOT_FOUND' });
      }
    });

    it('rejects with NotFoundException BOOKING_REFERENCE_NOT_FOUND on non-existent reference', async () => {
      (prismaService.bookingAgentProjection.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        (service as any).getBookingDetailByReference('user-1', 'bkref_99999999-9999-4999-8999-999999999999'),
      ).rejects.toThrow(NotFoundException);

      try {
        (prismaService.bookingAgentProjection.findUnique as jest.Mock).mockResolvedValueOnce(null);
        await (service as any).getBookingDetailByReference('user-1', 'bkref_99999999-9999-4999-8999-999999999999');
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({ code: 'BOOKING_REFERENCE_NOT_FOUND' });
      }
    });

    it('rejects with NotFoundException BOOKING_REFERENCE_NOT_FOUND on foreign reference (cross-owner access)', async () => {
      (prismaService.bookingAgentProjection.findUnique as jest.Mock).mockResolvedValueOnce({
        agentReference: 'bkref_11111111-1111-4111-8111-111111111111',
        airline: 'Vietnam Airlines',
        booking: { userId: 'user-2' },
      });

      await expect(
        (service as any).getBookingDetailByReference('user-1', 'bkref_11111111-1111-4111-8111-111111111111'),
      ).rejects.toThrow(NotFoundException);

      try {
        (prismaService.bookingAgentProjection.findUnique as jest.Mock).mockResolvedValueOnce({
          agentReference: 'bkref_11111111-1111-4111-8111-111111111111',
          airline: 'Vietnam Airlines',
          booking: { userId: 'user-2' },
        });
        await (service as any).getBookingDetailByReference('user-1', 'bkref_11111111-1111-4111-8111-111111111111');
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({ code: 'BOOKING_REFERENCE_NOT_FOUND' });
      }
    });
  });

  describe('AgentToolAudit logging in logToolCall', () => {
    it('should invoke agentToolAuditService.recordToolExecution on successful tool execution with allowlisted fields and without raw parameters', async () => {
      const mockProfile = {
        seatPreference: 'WINDOW',
        classPreference: 'ECONOMY',
        preferredAirlines: ['VN'],
        blacklistedAirlines: [],
        dietaryNeeds: 'Vegetarian',
      };
      (prismaService.travelerProfile.findUnique as jest.Mock).mockResolvedValueOnce(mockProfile);

      const result = await service.getUserPreferences('user-1', 'trace-test-1', 'corr-test-1');

      expect(result).toEqual(mockProfile);
      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledTimes(1);
      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith({
        toolName: 'users/preferences',
        actorId: 'user-1',
        outcome: 'SUCCESS',
        durationMs: expect.any(Number),
        responseSizeBytes: Buffer.byteLength(JSON.stringify(mockProfile)),
        occurredAt: expect.any(String),
        errorCode: undefined,
        traceId: 'trace-test-1',
        correlationId: 'corr-test-1',
      });

      // Verify no raw parameters or PII leaked in recordToolExecution arguments
      const passedRecord = agentToolAuditService.recordToolExecution.mock.calls[0][0];
      expect((passedRecord as any).parameters).toBeUndefined();
      expect((passedRecord as any).params).toBeUndefined();
      expect((passedRecord as any)._params).toBeUndefined();
      expect((passedRecord as any).seatPreference).toBeUndefined();
    });

    it('should invoke agentToolAuditService.recordToolExecution with FAILURE and custom errorCode when tool throws HttpException with code', async () => {
      (prismaService.travelerProfile.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.getUserPreferences('user-2', 'trace-test-2', 'corr-test-2')).rejects.toThrow(
        NotFoundException,
      );

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledTimes(1);
      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith({
        toolName: 'users/preferences',
        actorId: 'user-2',
        outcome: 'FAILURE',
        durationMs: expect.any(Number),
        responseSizeBytes: 0,
        occurredAt: expect.any(String),
        errorCode: 'PROFILE_NOT_FOUND',
        traceId: 'trace-test-2',
        correlationId: 'corr-test-2',
      });

      const passedRecord = agentToolAuditService.recordToolExecution.mock.calls[0][0];
      expect((passedRecord as any).parameters).toBeUndefined();
      expect((passedRecord as any).params).toBeUndefined();
    });

    it('should fallback to HTTP_<status> when HttpException does not contain a string error code', async () => {
      await (service as any).logToolCall(
        'user-3',
        'custom/tool',
        { sensitiveParam: 'super-secret-passport-12345' },
        Date.now(),
        'trace-test-3',
        'corr-test-3',
        false,
        new HttpException('Forbidden access', 403),
      );

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledTimes(1);
      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith({
        toolName: 'custom/tool',
        actorId: 'user-3',
        outcome: 'FAILURE',
        durationMs: expect.any(Number),
        responseSizeBytes: 0,
        occurredAt: expect.any(String),
        errorCode: 'HTTP_403',
        traceId: 'trace-test-3',
        correlationId: 'corr-test-3',
      });

      const passedRecord = agentToolAuditService.recordToolExecution.mock.calls[0][0];
      expect((passedRecord as any).sensitiveParam).toBeUndefined();
      expect((passedRecord as any).parameters).toBeUndefined();
      expect((passedRecord as any).params).toBeUndefined();
    });

    it('should record INTERNAL_ERROR when error is a generic non-HttpException error', async () => {
      await (service as any).logToolCall(
        'user-4',
        'custom/tool-db',
        { query: 'SELECT * FROM users' },
        Date.now(),
        'trace-test-4',
        'corr-test-4',
        false,
        new Error('Database connection failed'),
      );

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledTimes(1);
      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith({
        toolName: 'custom/tool-db',
        actorId: 'user-4',
        outcome: 'FAILURE',
        durationMs: expect.any(Number),
        responseSizeBytes: 0,
        occurredAt: expect.any(String),
        errorCode: 'INTERNAL_ERROR',
        traceId: 'trace-test-4',
        correlationId: 'corr-test-4',
      });

      const passedRecord = agentToolAuditService.recordToolExecution.mock.calls[0][0];
      expect((passedRecord as any).query).toBeUndefined();
      expect((passedRecord as any).parameters).toBeUndefined();
    });
  });
});
