import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { FlightsService } from './flights.service';
import { FlightSearchOrchestratorService } from './flight-search-orchestrator.service';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelService } from '@/duffel/duffel.service';
import { AuditService } from '@/audit/audit.service';
import { DuffelOffer } from '@/duffel/duffel.types';
import { FlightMatchResult } from '@/flight-match/flight-match.types';
import { FlightSearchRequestDto } from './dto/search-flight.dto';

describe('FlightsService (T036)', () => {
  let service: FlightsService;
  let prisma: {
    airport: { findUnique: jest.Mock };
    searchHistory: { create: jest.Mock };
    flightOffer: { createMany: jest.Mock; findUnique: jest.Mock; delete: jest.Mock };
    offerRecovery: { createMany: jest.Mock; findUnique: jest.Mock };
    auditLog: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let cacheService: { get: jest.Mock; set: jest.Mock };
  let duffelService: { searchFlights: jest.Mock };
  let auditService: { createLog: jest.Mock };
  let orchestratorService: { orchestrateSearch: jest.Mock };

  const flushWriteBehind = () => new Promise((resolve) => setImmediate(resolve));

  const createMockDuffelOffer = (id: string, amount = '150.00', airline = 'Vietnam Airlines'): DuffelOffer => ({
    id,
    total_amount: amount,
    total_currency: 'USD',
    slices: [
      {
        id: `sli_${id}`,
        duration: 'PT2H0M',
        origin: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
        destination: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
        segments: [
          {
            id: `seg_${id}`,
            duration: 'PT2H0M',
            departing_at: '2026-10-01T08:00:00',
            arriving_at: '2026-10-01T10:00:00',
            origin: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
            destination: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
            marketing_carrier: { id: 'VN', name: airline, iata_code: 'VN' },
            operating_carrier: { id: 'VN', name: airline, iata_code: 'VN' },
            marketing_carrier_flight_number: '123',
            aircraft: { id: 'arc_1', name: 'A321', iata_code: '321' },
            passengers: [
              {
                passenger_id: 'pas_1',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
            ],
          },
        ],
      },
    ],
    passengers: [{ id: 'pas_1', type: 'adult' }],
    passenger_identity_documents_required: false,
  });

  const createMockMatchResult = (
    score = 88,
    matchLevel: 'STRONG' | 'GOOD' | 'FAIR' | 'WEAK' = 'STRONG',
  ): FlightMatchResult => ({
    eligibility: { eligible: true, violations: [] },
    score,
    matchLevel,
    breakdown: [
      {
        dimension: 'AIRLINE',
        score: 100,
        weight: 0.4,
        contribution: 40,
        signal: 'POSITIVE',
        explanation: {
          key: 'match.airline.preferred',
          params: { airline: 'Vietnam Airlines' },
        },
      },
    ],
    metadata: {
      scoringVersion: 'flight-match-v1',
      activeWeights: {
        PRICE: 0.1,
        AIRLINE: 0.4,
        ARRIVAL_SCHEDULE: 0.1,
        STOPS: 0.2,
        CABIN: 0.1,
        DEPARTURE_SCHEDULE: 0.1,
        BAGGAGE: 0,
        DURATION: 0,
      },
    },
  });

  beforeEach(async () => {
    prisma = {
      airport: {
        findUnique: jest.fn().mockImplementation(({ where }: { where: { iataCode: string } }) => {
          if (where.iataCode === 'HAN' || where.iataCode === 'SGN') {
            return Promise.resolve({ iataCode: where.iataCode, name: `${where.iataCode} Airport` });
          }
          return Promise.resolve(null);
        }),
      },
      searchHistory: { create: jest.fn().mockResolvedValue({ id: 'hist_1' }) },
      flightOffer: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      offerRecovery: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
      auditLog: { findFirst: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        if (typeof callback === 'function') {
          return callback(prisma);
        }
        return callback;
      }),
    };

    cacheService = {
      get: jest.fn(),
      set: jest.fn(),
    };

    duffelService = {
      searchFlights: jest.fn(),
    };

    auditService = {
      createLog: jest.fn().mockResolvedValue({ id: 'audit_1' }),
    };

    orchestratorService = {
      orchestrateSearch: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CacheService, useValue: cacheService },
        { provide: DuffelService, useValue: duffelService },
        { provide: AuditService, useValue: auditService },
        { provide: FlightSearchOrchestratorService, useValue: orchestratorService },
      ],
    }).compile();

    service = module.get<FlightsService>(FlightsService);
  });

  describe('Validation', () => {
    it('throws BadRequestException when origin and destination are identical', async () => {
      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'HAN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      await expect(service.search('user_1', query)).rejects.toThrow(
        new BadRequestException('Origin and destination must be different'),
      );
    });

    it('throws BadRequestException when returnDate is before departureDate', async () => {
      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-10',
        returnDate: '2026-10-05',
        adults: 1,
      };

      await expect(service.search('user_1', query)).rejects.toThrow(
        new BadRequestException('Return date must be on or after departure date'),
      );
    });

    it('throws BadRequestException when origin airport does not exist', async () => {
      const query: FlightSearchRequestDto = {
        origin: 'XYZ',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      await expect(service.search('user_1', query)).rejects.toThrow(
        new BadRequestException('Origin airport with code XYZ does not exist'),
      );
    });

    it('throws BadRequestException when destination airport does not exist', async () => {
      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'XYZ',
        departureDate: '2026-10-01',
        adults: 1,
      };

      await expect(service.search('user_1', query)).rejects.toThrow(
        new BadRequestException('Destination airport with code XYZ does not exist'),
      );
    });
  });

  describe('Delegation to FlightSearchOrchestratorService', () => {
    it('delegates result normalization, scoring, and metadata assembly with expected parameters', async () => {
      const rawOffer1 = createMockDuffelOffer('off_1', '250.00');
      const rawOffer2 = createMockDuffelOffer('off_2', '180.00');
      const searchHash = 'sha256_mock_hash_123';

      duffelService.searchFlights.mockResolvedValue({
        offerRequest: { id: 'req_1', offers: [rawOffer1, rawOffer2] },
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            rawOffer: rawOffer1,
            scoredOffer: {
              offer: { id: 'uuid-1', originalIndex: 0 },
              matchResult: createMockMatchResult(90),
            },
          },
          {
            rawOffer: rawOffer2,
            scoredOffer: {
              offer: { id: 'uuid-2', originalIndex: 1 },
              matchResult: createMockMatchResult(75),
            },
          },
        ],
        meta: {
          totalResults: 2,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 2,
          matchLevelCounts: { STRONG: 2, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        returnDate: '2026-10-15',
        adults: 2,
        children: 1,
        infants: 0,
        cabinClass: 'economy',
      };

      await service.search('user_123', query);

      expect(orchestratorService.orchestrateSearch).toHaveBeenCalledTimes(1);
      expect(orchestratorService.orchestrateSearch).toHaveBeenCalledWith({
        rawOffers: [rawOffer1, rawOffer2],
        query: {
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-10-01',
          returnDate: '2026-10-15',
          adults: 2,
          children: 1,
          infants: 0,
          cabinClass: 'economy',
        },
        userId: 'user_123',
        searchHash,
        cached: false,
      });
    });

    it('passes empty array when rawResult.offers is undefined', async () => {
      const searchHash = 'sha256_empty_offers';

      duffelService.searchFlights.mockResolvedValue({
        offerRequest: { id: 'req_empty' },
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [],
        meta: {
          totalResults: 0,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 0,
          matchLevelCounts: { STRONG: 0, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      await service.search('user_123', query);

      expect(orchestratorService.orchestrateSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          rawOffers: [],
        }),
      );
    });
  });

  describe('Order and matchResult preservation', () => {
    it('preserves orchestrator sort order and attaches matchResult and scoredOffer id to each FlightOfferDto', async () => {
      const rawOfferA = createMockDuffelOffer('off_A', '300.00');
      const rawOfferB = createMockDuffelOffer('off_B', '150.00');
      const matchResultA = createMockMatchResult(60, 'FAIR');
      const matchResultB = createMockMatchResult(95, 'STRONG');

      duffelService.searchFlights.mockResolvedValue({
        offerRequest: { id: 'req_1', offers: [rawOfferA, rawOfferB] },
        cached: false,
        searchHash: 'sha256_order_test',
      });

      // Orchestrator returns B first (higher match score), then A
      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            rawOffer: rawOfferB,
            scoredOffer: {
              offer: { id: 'deterministic-uuid-b', originalIndex: 1 },
              matchResult: matchResultB,
            },
          },
          {
            rawOffer: rawOfferA,
            scoredOffer: {
              offer: { id: 'deterministic-uuid-a', originalIndex: 0 },
              matchResult: matchResultA,
            },
          },
        ],
        meta: {
          totalResults: 2,
          searchHash: 'sha256_order_test',
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 2,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 1, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const response = await service.search('user_123', {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      });

      expect(response.results).toHaveLength(2);

      // Verify order: B first, then A
      expect(response.results[0].id).toBe('deterministic-uuid-b');
      expect(response.results[0].duffelOfferId).toBe('off_B');
      expect(response.results[0].matchResult).toEqual(matchResultB);

      expect(response.results[1].id).toBe('deterministic-uuid-a');
      expect(response.results[1].duffelOfferId).toBe('off_A');
      expect(response.results[1].matchResult).toEqual(matchResultA);
    });
  });

  describe('Offer Persistence on Cache-Miss and Cache-Hit', () => {
    it('on cache-miss (cached: false): persists SearchHistory, and missing FlightOffer & OfferRecovery with skipDuplicates: true and zero score fields', async () => {
      const rawOffer = createMockDuffelOffer('off_miss', '199.99');
      const searchHash = 'sha256_cache_miss';
      const matchResult = createMockMatchResult(82);

      duffelService.searchFlights.mockResolvedValue({
        offerRequest: { id: 'req_miss', offers: [rawOffer] },
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            rawOffer,
            scoredOffer: {
              offer: { id: 'uuid-offer-miss', originalIndex: 0 },
              matchResult,
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      await service.search('user_test', {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      });

      await flushWriteBehind();

      // Verify transaction called
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // Verify SearchHistory created
      expect(prisma.searchHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user_test',
          origin: 'HAN',
          destination: 'SGN',
          adults: 1,
          resultCount: 1,
          searchHash,
        }),
      });

      // Verify FlightOffer created with skipDuplicates: true
      expect(prisma.flightOffer.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            id: 'uuid-offer-miss',
            searchHash,
            duffelOfferId: 'off_miss',
            origin: 'HAN',
            destination: 'SGN',
          }),
        ],
        skipDuplicates: true,
      });

      // STRICT INVARIANT: ZERO score or dimension breakdown columns persisted to FlightOffer
      const persistedFlightOfferData = prisma.flightOffer.createMany.mock.calls[0][0].data[0];
      expect(persistedFlightOfferData).not.toHaveProperty('score');
      expect(persistedFlightOfferData).not.toHaveProperty('matchScore');
      expect(persistedFlightOfferData).not.toHaveProperty('matchResult');
      expect(persistedFlightOfferData).not.toHaveProperty('matchLevel');
      expect(persistedFlightOfferData).not.toHaveProperty('breakdown');
      expect(persistedFlightOfferData).not.toHaveProperty('scoringVersion');

      // Verify OfferRecovery created with skipDuplicates: true
      expect(prisma.offerRecovery.createMany).toHaveBeenCalledWith({
        data: [{ id: 'uuid-offer-miss', searchHash }],
        skipDuplicates: true,
      });
    });

    it('on cache-hit (cached: true): persists SearchHistory AND upserts missing FlightOffer & OfferRecovery with skipDuplicates: true', async () => {
      const rawOffer = createMockDuffelOffer('off_hit', '140.00');
      const searchHash = 'sha256_cache_hit';
      const matchResult = createMockMatchResult(91);

      duffelService.searchFlights.mockResolvedValue({
        offerRequest: { id: 'req_hit', offers: [rawOffer] },
        cached: true,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            rawOffer,
            scoredOffer: {
              offer: { id: 'uuid-offer-hit', originalIndex: 0 },
              matchResult,
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: true,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      await service.search('user_test', {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      });

      await flushWriteBehind();

      // On cache hit, SearchHistory must STILL be created
      expect(prisma.searchHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user_test',
          searchHash,
        }),
      });

      // AND crucially, FlightOffer and OfferRecovery must ALSO be upserted with skipDuplicates: true
      expect(prisma.flightOffer.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            id: 'uuid-offer-hit',
            searchHash,
            duffelOfferId: 'off_hit',
          }),
        ],
        skipDuplicates: true,
      });

      expect(prisma.offerRecovery.createMany).toHaveBeenCalledWith({
        data: [{ id: 'uuid-offer-hit', searchHash }],
        skipDuplicates: true,
      });
    });

    it('does not throw when write-behind transaction encounters an error', async () => {
      const rawOffer = createMockDuffelOffer('off_err');
      duffelService.searchFlights.mockResolvedValue({
        offerRequest: { id: 'req_err', offers: [rawOffer] },
        cached: false,
        searchHash: 'sha256_err',
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            rawOffer,
            scoredOffer: {
              offer: { id: 'uuid-err', originalIndex: 0 },
              matchResult: createMockMatchResult(),
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash: 'sha256_err',
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      prisma.$transaction.mockRejectedValue(new Error('DB connection dropped'));

      const response = await service.search('user_test', {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      });

      await flushWriteBehind();

      // Search response is returned cleanly despite write-behind failure
      expect(response.results).toHaveLength(1);
    });
  });

  describe('Audit Telemetry (T037)', () => {
    it('emits search.completed audit log with safe parameters and strictly zero PII', async () => {
      const rawOffer = createMockDuffelOffer('off_audit');
      const searchHash = 'sha256_audit_hash';

      duffelService.searchFlights.mockResolvedValue({
        offerRequest: { id: 'req_audit', offers: [rawOffer] },
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            rawOffer,
            scoredOffer: {
              offer: { id: 'uuid-audit', originalIndex: 0 },
              matchResult: createMockMatchResult(85),
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        returnDate: '2026-10-15',
        adults: 2,
        children: 1,
        infants: 1,
        cabinClass: 'economy',
      };

      const response = await service.search('user_123', query, 'trace-999', 'corr-888');

      // Verify response contains mode: 'MATCHED'
      expect(response.mode).toBe('MATCHED');

      // Find call for search.completed
      const searchCompletedCall = auditService.createLog.mock.calls.find(
        (call) => call[1]?.action === 'search.completed',
      );

      expect(searchCompletedCall).toBeDefined();
      const [tx, auditPayload] = searchCompletedCall!;
      expect(tx).toBe(prisma);
      expect(auditPayload).toMatchObject({
        userId: 'user_123',
        action: 'search.completed',
        resourceType: 'Flight',
        traceId: 'trace-999',
        correlationId: 'corr-888',
        metadata: {
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-10-01',
          returnDate: '2026-10-15',
          adults: 2,
          children: 1,
          infants: 1,
          cabinClass: 'economy',
          mode: 'MATCHED',
          resultCount: 1,
          eligibleCount: 1,
          duration: expect.any(Number),
          searchHash,
        },
      });

      // Assert zero PII or raw provider payloads leaked in metadata
      const metaJson = JSON.stringify(auditPayload.metadata);
      expect(metaJson).not.toContain('email');
      expect(metaJson).not.toContain('password');
      expect(metaJson).not.toContain('token');
      expect(metaJson).not.toContain('slices');
      expect(metaJson).not.toContain('offers');
    });
  });
});

