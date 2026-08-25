import { Test, TestingModule } from '@nestjs/testing';
import { AttestedFlightSearchService } from './attested-flight-search.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelService } from '@/duffel/duffel.service';
import { SelectionAttestationService } from '../selection-attestation.service';
import { ChatMessageCryptoService } from '@/chat/chat-message-crypto.service';
import { AgentToolAuditService } from '../audit/agent-tool-audit.service';
import { HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { FlightSearchQueryDto } from '../dto/flight-search-query.dto';
import { AttestedFlightSearchDto } from '../dto/attested-flight-search.dto';

describe('AttestedFlightSearchService', () => {
  let service: AttestedFlightSearchService;
  let prismaService: any;
  let auditService: any;
  let cacheService: any;
  let duffelService: any;
  let selectionAttestationService: any;
  let chatMessageCryptoService: any;
  let agentToolAuditService: any;

  beforeEach(async () => {
    prismaService = {
      chatMessage: { findFirst: jest.fn() },
      chatSession: { findFirst: jest.fn() },
      flightOffer: { createMany: jest.fn(), findMany: jest.fn() },
    };
    auditService = { createLog: jest.fn().mockResolvedValue({}) };
    cacheService = { get: jest.fn(), set: jest.fn().mockResolvedValue(undefined) };
    duffelService = { searchFlights: jest.fn() };
    selectionAttestationService = {
      signSelectionAttestation: jest.fn().mockResolvedValue('sel_v1_mock_attestation.mock_signature'),
    };
    chatMessageCryptoService = {
      decryptMessageContent: jest.fn().mockResolvedValue('I want to fly to Hanoi'),
      isConfigured: jest.fn().mockReturnValue(true),
    };
    agentToolAuditService = {
      recordToolExecution: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttestedFlightSearchService,
        { provide: PrismaService, useValue: prismaService },
        { provide: AuditService, useValue: auditService },
        { provide: CacheService, useValue: cacheService },
        { provide: DuffelService, useValue: duffelService },
        { provide: SelectionAttestationService, useValue: selectionAttestationService },
        { provide: ChatMessageCryptoService, useValue: chatMessageCryptoService },
        { provide: AgentToolAuditService, useValue: agentToolAuditService },
      ],
    }).compile();

    service = module.get<AttestedFlightSearchService>(AttestedFlightSearchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('searchFlights (V1)', () => {
    const validQuery: FlightSearchQueryDto = {
      origin: 'SGN',
      destination: 'HAN',
      date: '2026-09-01',
      adults: 1,
      cabinClass: 'economy',
    };

    it('returns cached results on cache hit without calling Duffel', async () => {
      const cachedResult = {
        results: [
          {
            airline: 'Vietnam Airlines',
            flightNumber: 'VN123',
            departureAirport: 'SGN',
            arrivalAirport: 'HAN',
            departureTime: '2026-09-01T08:00:00',
            arrivalTime: '2026-09-01T10:00:00',
            duration: 120,
            stops: 0,
            price: 150,
            currency: 'USD',
            fareClass: 'Economy',
            baggageAllowance: '1 checked bag(s)',
          },
        ],
      };
      cacheService.get.mockResolvedValueOnce(JSON.stringify(cachedResult));

      const result = await service.searchFlights('user-1', validQuery, 'trace-1', 'corr-1');

      expect(result).toEqual(cachedResult);
      expect(duffelService.searchFlights).not.toHaveBeenCalled();
      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith({
        toolName: 'flights/search',
        actorId: 'user-1',
        outcome: 'SUCCESS',
        durationMs: expect.any(Number),
        responseSizeBytes: Buffer.byteLength(JSON.stringify(cachedResult)),
        occurredAt: expect.any(String),
        errorCode: undefined,
        traceId: 'trace-1',
        correlationId: 'corr-1',
      });
    });

    it('searches Duffel on cache miss, caches results with 900s TTL, and records tool execution', async () => {
      cacheService.get.mockResolvedValueOnce(null);
      duffelService.searchFlights.mockResolvedValueOnce({
        offerRequest: {
          offers: [
            {
              id: 'off_123',
              total_amount: '120.50',
              total_currency: 'USD',
              slices: [
                {
                  duration: 'PT2H15M',
                  segments: [
                    {
                      operating_carrier: { name: 'Vietnam Airlines' },
                      marketing_carrier: { iata_code: 'VN' },
                      marketing_carrier_flight_number: '210',
                      origin: { iata_code: 'SGN' },
                      destination: { iata_code: 'HAN' },
                      departing_at: '2026-09-01T07:00:00Z',
                      arriving_at: '2026-09-01T09:15:00Z',
                      passengers: [
                        {
                          cabin_class: 'economy',
                          baggages: [{ type: 'checked', quantity: 1 }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      });

      const result = await service.searchFlights('user-1', validQuery, 'trace-1', 'corr-1');

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        airline: 'Vietnam Airlines',
        flightNumber: 'VN210',
        departureAirport: 'SGN',
        arrivalAirport: 'HAN',
        departureTime: '2026-09-01T07:00:00',
        arrivalTime: '2026-09-01T09:15:00',
        duration: 135,
        stops: 0,
        price: 120.5,
        currency: 'USD',
        fareClass: 'Economy',
        baggageAllowance: '1 checked bag(s)',
      });

      expect(cacheService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^flights:search:/),
        JSON.stringify(result),
        900,
      );

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'flights/search',
          actorId: 'user-1',
          outcome: 'SUCCESS',
        }),
      );
    });

    it('rejects missing adults count', async () => {
      await expect(
        service.searchFlights('user-1', { origin: 'SGN', destination: 'HAN', date: '2026-09-01' } as any),
      ).rejects.toThrow(HttpException);

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'flights/search',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'HTTP_400',
        }),
      );
    });

    it('rejects missing date', async () => {
      await expect(
        service.searchFlights('user-1', { origin: 'SGN', destination: 'HAN', adults: 1 } as any),
      ).rejects.toThrow(HttpException);

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'flights/search',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'HTTP_400',
        }),
      );
    });

    it('triggers honest degradation on keyword match in user chat message', async () => {
      prismaService.chatMessage.findFirst.mockResolvedValueOnce({
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'USER',
        contentCiphertext: 'enc',
      });
      chatMessageCryptoService.decryptMessageContent.mockResolvedValueOnce('I want first class tickets');

      await expect(
        service.searchFlights('user-1', validQuery, 'trace-1', 'session-1'),
      ).rejects.toThrow(HttpException);

      expect(auditService.createLog).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          userId: 'user-1',
          action: 'AGENT_KEYWORD_TRIGGER',
          resourceType: 'agent-gateway',
          metadata: expect.objectContaining({
            matchedKeywords: ['first'],
            messageId: 'msg-1',
          }),
        }),
      );
    });

    it('throws 400 when chat decryption fails', async () => {
      prismaService.chatMessage.findFirst.mockResolvedValueOnce({
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'USER',
        contentCiphertext: 'corrupt',
      });
      chatMessageCryptoService.decryptMessageContent.mockRejectedValueOnce(new Error('Corrupt envelope'));

      await expect(
        service.searchFlights('user-1', validQuery, 'trace-1', 'session-1'),
      ).rejects.toThrow(new HttpException('Unable to decrypt chat message envelope', HttpStatus.BAD_REQUEST));
    });

    it('throws 503 when chat encryption is not configured', async () => {
      prismaService.chatMessage.findFirst.mockResolvedValueOnce({
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'USER',
        contentCiphertext: 'enc',
      });
      chatMessageCryptoService.isConfigured.mockReturnValueOnce(false);
      chatMessageCryptoService.decryptMessageContent.mockRejectedValueOnce(new Error('CHAT_ENCRYPTION_KEY is missing'));

      await expect(
        service.searchFlights('user-1', validQuery, 'trace-1', 'session-1'),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('wraps upstream errors in 502 UPSTREAM_UNAVAILABLE', async () => {
      cacheService.get.mockResolvedValueOnce(null);
      duffelService.searchFlights.mockRejectedValueOnce(new Error('Duffel API timeout'));

      await expect(
        service.searchFlights('user-1', validQuery, 'trace-1', 'corr-1'),
      ).rejects.toThrow(HttpException);

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'flights/search',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'UPSTREAM_UNAVAILABLE',
        }),
      );
    });
  });

  describe('searchFlightsV2', () => {
    const validV2Dto: AttestedFlightSearchDto = {
      chatSessionId: 'sess_123',
      proposedSnapshotVersion: 1,
      search: {
        origin: 'SGN',
        destination: 'HAN',
        departureDate: '2026-09-01',
        adults: 1,
        cabinClass: 'economy',
      },
    };

    it('searches flights V2, stores offers, generates selection attestation, and audits tool execution', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_123',
        userId: 'user-1',
        deletedAt: null,
      });
      prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);

      duffelService.searchFlights.mockResolvedValueOnce({
        searchHash: 'hash_abc',
        offerRequest: {
          offers: [
            {
              id: 'off_v2_1',
              total_amount: '200.00',
              total_currency: 'USD',
              slices: [
                {
                  duration: 'PT2H00M',
                  segments: [
                    {
                      operating_carrier: { name: 'Bamboo Airways' },
                      marketing_carrier: { iata_code: 'QH' },
                      marketing_carrier_flight_number: '201',
                      origin: { iata_code: 'SGN' },
                      destination: { iata_code: 'HAN' },
                      departing_at: '2026-09-01T06:00:00Z',
                      arriving_at: '2026-09-01T08:00:00Z',
                      passengers: [
                        {
                          cabin_class: 'economy',
                          baggages: [{ type: 'checked', quantity: 1 }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      });

      prismaService.flightOffer.findMany.mockResolvedValueOnce([
        {
          id: 'fo_db_1',
          duffelOfferId: 'off_v2_1',
          searchHash: 'hash_abc',
        },
      ]);

      const result = await service.searchFlightsV2('user-1', validV2Dto, 'trace-v2', 'corr-v2');

      expect(result.selectionAttestation).toBe('sel_v1_mock_attestation.mock_signature');
      expect(result.snapshotVersion).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        flightOfferId: 'fo_db_1',
        duffelOfferId: 'off_v2_1',
        airline: 'Bamboo Airways',
        flightNumber: 'QH201',
      });

      expect(prismaService.flightOffer.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            searchHash: 'hash_abc',
            duffelOfferId: 'off_v2_1',
            origin: 'SGN',
            destination: 'HAN',
          }),
        ],
        skipDuplicates: true,
      });

      expect(selectionAttestationService.signSelectionAttestation).toHaveBeenCalledWith(
        'user-1',
        'sess_123',
        1,
        expect.any(String),
        [{ flightOfferId: 'fo_db_1', duffelOfferId: 'off_v2_1' }],
      );

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith({
        toolName: 'v2/flights/search',
        actorId: 'user-1',
        outcome: 'SUCCESS',
        durationMs: expect.any(Number),
        responseSizeBytes: expect.any(Number),
        occurredAt: expect.any(String),
        errorCode: undefined,
        traceId: 'trace-v2',
        correlationId: 'corr-v2',
      });
    });

    it('rejects when chatSession does not exist or belong to user', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.searchFlightsV2('user-1', validV2Dto),
      ).rejects.toThrow(new HttpException('Chat session not found', HttpStatus.NOT_FOUND));

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'v2/flights/search',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'HTTP_404',
        }),
      );
    });

    it('rejects missing search adults / passengers', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_123',
        userId: 'user-1',
        deletedAt: null,
      });

      const invalidDto: any = {
        chatSessionId: 'sess_123',
        search: {
          origin: 'SGN',
          destination: 'HAN',
          departureDate: '2026-09-01',
        },
      };

      await expect(
        service.searchFlightsV2('user-1', invalidDto),
      ).rejects.toThrow(new HttpException('At least one of adults or passengers must be provided', HttpStatus.BAD_REQUEST));
    });

    it('rejects missing search date / departureDate', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_123',
        userId: 'user-1',
        deletedAt: null,
      });

      const invalidDto: any = {
        chatSessionId: 'sess_123',
        search: {
          origin: 'SGN',
          destination: 'HAN',
          adults: 1,
        },
      };

      await expect(
        service.searchFlightsV2('user-1', invalidDto),
      ).rejects.toThrow(new HttpException('At least one of date or departureDate must be provided', HttpStatus.BAD_REQUEST));
    });
  });
});
