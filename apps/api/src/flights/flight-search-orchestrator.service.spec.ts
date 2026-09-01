import { Test, TestingModule } from '@nestjs/testing';
import { DuffelOffer } from '@/duffel/duffel.types';
import { ProfileService } from '@/profile/profile.service';
import { FlightMatchScorerService } from '@/flight-match/flight-match-scorer.service';
import {
  FlightSearchOrchestratorService,
  OrchestratorParams,
} from './flight-search-orchestrator.service';

describe('FlightSearchOrchestratorService (T033)', () => {
  let service: FlightSearchOrchestratorService;
  let profileService: jest.Mocked<Pick<ProfileService, 'getScoringPreferences'>>;
  let scorer: jest.Mocked<Pick<FlightMatchScorerService, 'scoreAll'>>;

  const createMockDuffelOffer = (id: string, overrides: Partial<DuffelOffer> = {}): DuffelOffer => ({
    id,
    total_amount: '200.00',
    total_currency: 'USD',
    passenger_identity_documents_required: false,
    passengers: [{ id: 'pas_1', type: 'adult' }],
    slices: [
      {
        id: `sli_${id}`,
        duration: 'PT2H',
        origin: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
        destination: { id: 'plc_jfk', name: 'New York', iata_code: 'JFK', type: 'airport' },
        segments: [
          {
            id: `seg_${id}`,
            duration: 'PT2H',
            departing_at: '2026-09-01T08:00:00',
            arriving_at: '2026-09-01T10:00:00',
            origin: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'New York', iata_code: 'JFK', type: 'airport' },
            marketing_carrier: { id: 'arl_ba', name: 'British Airways', iata_code: 'BA' },
            operating_carrier: { id: 'arl_ba', name: 'British Airways', iata_code: 'BA' },
            marketing_carrier_flight_number: '100',
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
    ...overrides,
  });

  const defaultPreferences = {
    preferredAirlines: [] as string[],
    blacklistedAirlines: [] as string[],
    classPreference: null as string | null,
    preferredDepartureWindow: null as { start: number; end: number } | null,
    preferredArrivalWindow: null as { start: number; end: number } | null,
    maxStops: null as number | null,
    priceSensitivity: null as 'BUDGET' | 'MODERATE' | 'FLEXIBLE' | null,
    requiresCheckedBaggage: null as boolean | null,
  };

  const defaultQuery: OrchestratorParams['query'] = {
    origin: 'SFO',
    destination: 'JFK',
    departureDate: '2026-09-01',
    adults: 1,
  };

  beforeEach(async () => {
    profileService = {
      getScoringPreferences: jest.fn().mockResolvedValue(defaultPreferences),
    };

    scorer = {
      scoreAll: jest.fn().mockImplementation((offers) =>
        offers.map((offer: any) => ({
          offer,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 85,
            matchLevel: 'STRONG',
            breakdown: [],
            metadata: {
              scoringVersion: 'flight-match-v1',
              activeWeights: {
                PRICE: 0.25,
                AIRLINE: 0.15,
                ARRIVAL_SCHEDULE: 0.1,
                STOPS: 0.15,
                CABIN: 0.1,
                DEPARTURE_SCHEDULE: 0.1,
                BAGGAGE: 0.05,
                DURATION: 0.1,
              },
            },
          },
        })),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightSearchOrchestratorService,
        { provide: ProfileService, useValue: profileService },
        { provide: FlightMatchScorerService, useValue: scorer },
      ],
    }).compile();

    service = module.get<FlightSearchOrchestratorService>(FlightSearchOrchestratorService);
  });

  describe('Core Flow & Normalization', () => {
    it('normalizes raw offers and caps at 20 canonical valid offers', async () => {
      const rawOffers: DuffelOffer[] = [];
      for (let i = 0; i < 25; i++) {
        rawOffers.push(createMockDuffelOffer(`off_${i.toString().padStart(2, '0')}`));
      }

      const params: OrchestratorParams = {
        rawOffers,
        query: defaultQuery,
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(scorer.scoreAll).toHaveBeenCalledTimes(1);
      const passedOffers = scorer.scoreAll.mock.calls[0][0];
      expect(passedOffers).toHaveLength(20);
      expect(passedOffers[0].id).toBeDefined();
      expect(response.results).toHaveLength(20);
      expect(response.mode).toBe('MATCHED');
    });

    it('tracks dropped offers and rejection counts', async () => {
      const validOffer = createMockDuffelOffer('off_valid');
      const malformedOffer = { id: '', slices: [] } as unknown as DuffelOffer;

      const params: OrchestratorParams = {
        rawOffers: [validOffer, malformedOffer],
        query: defaultQuery,
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(response.droppedCount).toBe(1);
      expect(response.rejectionCounts['MALFORMED_OFFER']).toBe(1);
      expect(response.results).toHaveLength(1);
      expect(response.results[0].rawOffer.id).toBe('off_valid');
    });

    it('maps scored offers back to corresponding original raw offers by originalIndex', async () => {
      const offer0 = createMockDuffelOffer('off_0');
      const malformed = { id: '' } as unknown as DuffelOffer;
      const offer2 = createMockDuffelOffer('off_2');

      const params: OrchestratorParams = {
        rawOffers: [offer0, malformed, offer2],
        query: defaultQuery,
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      scorer.scoreAll.mockImplementation((offers) =>
        [...offers].reverse().map((offer: any) => ({
          offer,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: offer.originalIndex === 2 ? 90 : 70,
            matchLevel: 'STRONG',
            breakdown: [],
            metadata: {
              scoringVersion: 'flight-match-v1',
              activeWeights: {} as any,
            },
          },
        })),
      );

      const response = await service.orchestrateSearch(params);

      expect(response.results).toHaveLength(2);
      expect(response.results[0].rawOffer.id).toBe('off_2');
      expect(response.results[0].scoredOffer.offer.originalIndex).toBe(2);
      expect(response.results[1].rawOffer.id).toBe('off_0');
      expect(response.results[1].scoredOffer.offer.originalIndex).toBe(0);
    });
  });

  describe('Profile Fetching', () => {
    it('calls profileService.getScoringPreferences exactly once when userId is present', async () => {
      const params: OrchestratorParams = {
        rawOffers: [createMockDuffelOffer('off_1')],
        query: defaultQuery,
        userId: 'usr_123',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(profileService.getScoringPreferences).toHaveBeenCalledTimes(1);
      expect(profileService.getScoringPreferences).toHaveBeenCalledWith('usr_123');
    });

    it('uses default empty preferences and does not call profileService when userId is null', async () => {
      const params: OrchestratorParams = {
        rawOffers: [createMockDuffelOffer('off_1')],
        query: defaultQuery,
        userId: null,
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(profileService.getScoringPreferences).not.toHaveBeenCalled();
      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          preferredAirlines: [],
          blacklistedAirlines: [],
          classPreference: null,
        }),
      );
    });

    it('uses default empty preferences and does not call profileService when userId is undefined', async () => {
      const params: OrchestratorParams = {
        rawOffers: [createMockDuffelOffer('off_1')],
        query: defaultQuery,
        userId: undefined,
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(profileService.getScoringPreferences).not.toHaveBeenCalled();
      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          preferredAirlines: [],
          blacklistedAirlines: [],
          classPreference: null,
        }),
      );
    });

    it('uses default empty preferences and does not call profileService when userId is empty string', async () => {
      const params: OrchestratorParams = {
        rawOffers: [createMockDuffelOffer('off_1')],
        query: defaultQuery,
        userId: '   ',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(profileService.getScoringPreferences).not.toHaveBeenCalled();
    });
  });

  describe('Query Cabin Precedence (Decision 3)', () => {
    it('overrides profile classPreference with query.cabinClass when profile preference is set', async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...defaultPreferences,
        classPreference: 'economy',
      });

      const params: OrchestratorParams = {
        rawOffers: [createMockDuffelOffer('off_1')],
        query: { ...defaultQuery, cabinClass: 'business' },
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          classPreference: 'business',
        }),
      );
    });

    it('retains profile classPreference when query.cabinClass is not provided', async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...defaultPreferences,
        classPreference: 'premium_economy',
      });

      const params: OrchestratorParams = {
        rawOffers: [createMockDuffelOffer('off_1')],
        query: { ...defaultQuery, cabinClass: undefined },
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          classPreference: 'premium_economy',
        }),
      );
    });

    it('keeps effective classPreference null when profile classPreference is null, even if query.cabinClass is provided', async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...defaultPreferences,
        classPreference: null,
      });

      const params: OrchestratorParams = {
        rawOffers: [createMockDuffelOffer('off_1')],
        query: { ...defaultQuery, cabinClass: 'first' },
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          classPreference: null,
        }),
      );
    });
  });

  describe('Raw-Cache Hit Rescoring & Zero Persistence (T034)', () => {
    it('re-scores cached offers using requesting user profile preferences and sets meta.cached: true', async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...defaultPreferences,
        preferredAirlines: ['BA', 'VS'],
        maxStops: 0,
      });

      const params: OrchestratorParams = {
        rawOffers: [createMockDuffelOffer('off_cached_1')],
        query: defaultQuery,
        userId: 'usr_rescore_42',
        searchHash: 'hash_cached_rescore',
        cached: true,
      };

      const response = await service.orchestrateSearch(params);

      expect(profileService.getScoringPreferences).toHaveBeenCalledWith('usr_rescore_42');
      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          preferredAirlines: ['BA', 'VS'],
          maxStops: 0,
        }),
      );
      expect(response.meta.cached).toBe(true);
      expect(response.meta.searchHash).toBe('hash_cached_rescore');
    });

    it('enforces zero persistence invariant: orchestrator has zero persistence dependencies and performs 0 DB/cache writes', () => {
      expect(service).not.toHaveProperty('prisma');
      expect(service).not.toHaveProperty('prismaService');
      expect(service).not.toHaveProperty('cacheService');
      expect(service).not.toHaveProperty('redis');

      const propertyKeys = Object.getOwnPropertyNames(service);
      expect(propertyKeys).toEqual(
        expect.arrayContaining(['profileService', 'scorer', 'logger']),
      );
      expect(propertyKeys).not.toContain('prisma');
      expect(propertyKeys).not.toContain('prismaService');
      expect(propertyKeys).not.toContain('cacheService');
    });
  });

  describe('Aggregate Metadata Generation (T034)', () => {
    it('accurately counts all 4 match levels (STRONG, GOOD, FAIR, WEAK) in matchLevelCounts', async () => {
      const rawOffers = [
        createMockDuffelOffer('off_1'),
        createMockDuffelOffer('off_2'),
        createMockDuffelOffer('off_3'),
        createMockDuffelOffer('off_4'),
      ];

      scorer.scoreAll.mockReturnValueOnce([
        {
          offer: { id: 'uuid_1' } as any,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 95,
            matchLevel: 'STRONG',
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: {} as any },
          },
        },
        {
          offer: { id: 'uuid_2' } as any,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 75,
            matchLevel: 'GOOD',
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: {} as any },
          },
        },
        {
          offer: { id: 'uuid_3' } as any,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 55,
            matchLevel: 'FAIR',
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: {} as any },
          },
        },
        {
          offer: { id: 'uuid_4' } as any,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 35,
            matchLevel: 'WEAK',
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: {} as any },
          },
        },
      ]);

      const params: OrchestratorParams = {
        rawOffers,
        query: { ...defaultQuery, cabinClass: 'business' },
        userId: 'usr_meta',
        searchHash: 'hash_meta_full',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(response.meta).toEqual({
        totalResults: 4,
        searchHash: 'hash_meta_full',
        cached: false,
        requestedCabinClass: 'business',
        scoringVersion: 'flight-match-v1',
        eligibleCount: 4,
        matchLevelCounts: {
          STRONG: 1,
          GOOD: 1,
          FAIR: 1,
          WEAK: 1,
        },
      });
    });

    it('strictly excludes ineligible offers (eligible: false, matchLevel: null) from matchLevelCounts', async () => {
      const rawOffers = [
        createMockDuffelOffer('off_1'),
        createMockDuffelOffer('off_2'),
        createMockDuffelOffer('off_3'),
      ];

      scorer.scoreAll.mockReturnValueOnce([
        {
          offer: { id: 'uuid_1' } as any,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 85,
            matchLevel: 'STRONG',
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: {} as any },
          },
        },
        {
          offer: { id: 'uuid_2' } as any,
          matchResult: {
            eligibility: {
              eligible: false,
              violations: [
                {
                  constraint: 'BLACKLISTED_AIRLINE',
                  explanation: 'Airline is in blacklist' as any,
                },
              ],
            },
            score: null,
            matchLevel: null,
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: {} as any },
          },
        },
        {
          offer: { id: 'uuid_3' } as any,
          matchResult: {
            eligibility: {
              eligible: false,
              violations: [
                {
                  constraint: 'BLACKLISTED_AIRLINE',
                  explanation: 'Airline is in blacklist' as any,
                },
              ],
            },
            score: null,
            matchLevel: null,
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: {} as any },
          },
        },
      ]);

      const params: OrchestratorParams = {
        rawOffers,
        query: defaultQuery,
        userId: 'usr_ineligible',
        searchHash: 'hash_ineligible',
        cached: true,
      };

      const response = await service.orchestrateSearch(params);

      expect(response.meta.totalResults).toBe(3);
      expect(response.meta.eligibleCount).toBe(1);
      expect(response.meta.matchLevelCounts).toEqual({
        STRONG: 1,
        GOOD: 0,
        FAIR: 0,
        WEAK: 0,
      });
      expect(response.meta.scoringVersion).toBe('flight-match-v1');
    });

    it('returns zero counts for eligibleCount and all buckets when canonical offers are empty', async () => {
      const params: OrchestratorParams = {
        rawOffers: [],
        query: defaultQuery,
        userId: 'usr_empty',
        searchHash: 'hash_empty',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(response.results).toEqual([]);
      expect(response.droppedCount).toBe(0);
      expect(response.meta).toEqual({
        totalResults: 0,
        searchHash: 'hash_empty',
        cached: false,
        requestedCabinClass: 'economy',
        scoringVersion: 'flight-match-v1',
        eligibleCount: 0,
        matchLevelCounts: {
          STRONG: 0,
          GOOD: 0,
          FAIR: 0,
          WEAK: 0,
        },
      });
    });

    it('defaults requestedCabinClass to economy when query.cabinClass is not provided', async () => {
      const params: OrchestratorParams = {
        rawOffers: [createMockDuffelOffer('off_1')],
        query: { ...defaultQuery, cabinClass: undefined },
        userId: 'usr_default_cabin',
        searchHash: 'hash_cabin_default',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);
      expect(response.meta.requestedCabinClass).toBe('economy');
    });
  });

  describe('Invalid Offer Tracking & Telemetry (T034)', () => {
    it('logs telemetry when offers are dropped for invalid dates, negative price, currency mismatch without failing', async () => {
      const validOffer = createMockDuffelOffer('off_valid', {
        total_currency: 'USD',
      });

      const invalidDateOffer = createMockDuffelOffer('off_invalid_date', {
        total_currency: 'USD',
        slices: [
          {
            ...createMockDuffelOffer('off_invalid_date').slices[0],
            segments: [
              {
                ...createMockDuffelOffer('off_invalid_date').slices[0].segments[0],
                departing_at: 'invalid-iso-date',
              },
            ],
          },
        ],
      });

      const negativePriceOffer = createMockDuffelOffer('off_neg_price', {
        total_amount: '-150.00',
        total_currency: 'USD',
      });

      const currencyMismatchOffer = createMockDuffelOffer('off_curr_mismatch', {
        total_currency: 'EUR',
      });

      const params: OrchestratorParams = {
        rawOffers: [validOffer, invalidDateOffer, negativePriceOffer, currencyMismatchOffer],
        query: defaultQuery,
        userId: 'usr_telemetry',
        searchHash: 'hash_telemetry_test',
        cached: false,
      };

      const loggerWarnSpy = jest.spyOn((service as any).logger, 'warn');

      const response = await service.orchestrateSearch(params);

      expect(response.droppedCount).toBe(3);
      expect(response.rejectionCounts).toEqual({
        INVALID_TIMESTAMP: 1,
        INVALID_PRICE: 1,
        MIXED_CURRENCY: 1,
      });
      expect(response.results).toHaveLength(1);
      expect(response.results[0].rawOffer.id).toBe('off_valid');
      expect(response.meta.totalResults).toBe(1);

      expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('hash_telemetry_test'),
        expect.objectContaining({
          searchHash: 'hash_telemetry_test',
          droppedCount: 3,
          rejectionCounts: {
            INVALID_TIMESTAMP: 1,
            INVALID_PRICE: 1,
            MIXED_CURRENCY: 1,
          },
        }),
      );
    });

    it('does not log telemetry when droppedCount is 0', async () => {
      const validOffer = createMockDuffelOffer('off_clean');
      const params: OrchestratorParams = {
        rawOffers: [validOffer],
        query: defaultQuery,
        userId: 'usr_clean',
        searchHash: 'hash_clean',
        cached: false,
      };

      const loggerWarnSpy = jest.spyOn((service as any).logger, 'warn');

      const response = await service.orchestrateSearch(params);

      expect(response.droppedCount).toBe(0);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });
  });
});

