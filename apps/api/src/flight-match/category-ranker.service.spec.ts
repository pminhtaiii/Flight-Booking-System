import { Test, TestingModule } from '@nestjs/testing';
import { CategoryRankerService } from './category-ranker.service';
import { FlightMatchScorerService } from './flight-match-scorer.service';
import { FlightMatchModule } from './flight-match.module';
import type { FlightMatchInput } from './flight-match.types';

describe('CategoryRankerService', () => {
  let service: CategoryRankerService;

  const createOffer = (overrides: Partial<FlightMatchInput> = {}): FlightMatchInput => ({
    id: 'offer-1',
    price: 300,
    currency: 'USD',
    stops: 0,
    duration: 180,
    outboundDepartureHour: 10,
    outboundArrivalHour: 13,
    carrierCodes: ['BA'],
    cabinClass: 'economy',
    hasCheckedBaggage: true,
    originalIndex: 0,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CategoryRankerService],
    }).compile();

    service = module.get<CategoryRankerService>(CategoryRankerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Degenerate Sets & Non-Mutation Invariants (T041)', () => {
    it('returns empty array as a new array reference when given empty input', () => {
      const input: readonly FlightMatchInput[] = Object.freeze([]);
      const result = service.rank(input);
      expect(result).toEqual([]);
      expect(result).not.toBe(input);
    });

    it('returns single offer without error and as a new array reference', () => {
      const offer = Object.freeze(createOffer({ id: 'single-1' }));
      const input: readonly FlightMatchInput[] = Object.freeze([offer]);
      const result = service.rank(input);

      expect(result).toEqual([offer]);
      expect(result).not.toBe(input);
      expect(result[0]).toBe(offer);
    });

    it('does not mutate frozen input array or offer objects', () => {
      const offerA = Object.freeze(createOffer({ id: 'a', stops: 2, originalIndex: 0 }));
      const offerB = Object.freeze(createOffer({ id: 'b', stops: 0, originalIndex: 1 }));
      const input = Object.freeze([offerA, offerB]);

      expect(() => {
        const result = service.rank(input);
        expect(result).not.toBe(input);
        expect(result[0].id).toBe('b');
        expect(result[1].id).toBe('a');
      }).not.toThrow();
    });

    it('strictly preserves deep immutability when sorting complex frozen sets', () => {
      const offers = Object.freeze([
        Object.freeze(createOffer({ id: 'f-3', stops: 1, price: 400, originalIndex: 2 })),
        Object.freeze(createOffer({ id: 'f-1', stops: 0, price: 500, originalIndex: 0 })),
        Object.freeze(createOffer({ id: 'f-2', stops: 0, price: 200, originalIndex: 1 })),
      ]);

      const result = service.rank(offers);

      expect(result).not.toBe(offers);
      expect(Object.isFrozen(offers)).toBe(true);
      offers.forEach((o) => expect(Object.isFrozen(o)).toBe(true));
      expect(result.map((o) => o.id)).toEqual(['f-2', 'f-1', 'f-3']);
    });
  });

  describe('Multi-Attribute Ties & Deterministic Permutations (T041)', () => {
    it('preserves supplier originalIndex order across all permutations when stops, price, duration, and red-eye penalty are identical', () => {
      const offer0 = Object.freeze(
        createOffer({ id: 'tie-0', stops: 0, price: 200, duration: 150, outboundDepartureHour: 10, originalIndex: 0 }),
      );
      const offer1 = Object.freeze(
        createOffer({ id: 'tie-1', stops: 0, price: 200, duration: 150, outboundDepartureHour: 14, originalIndex: 1 }),
      );
      const offer2 = Object.freeze(
        createOffer({ id: 'tie-2', stops: 0, price: 200, duration: 150, outboundDepartureHour: 18, originalIndex: 2 }),
      );
      const offer3 = Object.freeze(
        createOffer({ id: 'tie-3', stops: 0, price: 200, duration: 150, outboundDepartureHour: 22, originalIndex: 3 }),
      );

      const permutations: (readonly FlightMatchInput[])[] = [
        Object.freeze([offer0, offer1, offer2, offer3]),
        Object.freeze([offer3, offer2, offer1, offer0]),
        Object.freeze([offer2, offer0, offer3, offer1]),
        Object.freeze([offer1, offer3, offer0, offer2]),
        Object.freeze([offer3, offer0, offer2, offer1]),
        Object.freeze([offer1, offer2, offer0, offer3]),
      ];

      for (const p of permutations) {
        const result = service.rank(p);
        expect(result).not.toBe(p);
        expect(result.map((o) => o.id)).toEqual(['tie-0', 'tie-1', 'tie-2', 'tie-3']);
      }
    });

    it('preserves originalIndex among red-eye offers with identical stops, price, and duration', () => {
      const redEye0 = Object.freeze(
        createOffer({ id: 'redeye-0', stops: 1, price: 150, duration: 200, outboundDepartureHour: 1, originalIndex: 0 }),
      );
      const redEye1 = Object.freeze(
        createOffer({ id: 'redeye-1', stops: 1, price: 150, duration: 200, outboundDepartureHour: 3, originalIndex: 1 }),
      );
      const redEye2 = Object.freeze(
        createOffer({ id: 'redeye-2', stops: 1, price: 150, duration: 200, outboundDepartureHour: 4, originalIndex: 2 }),
      );

      const result = service.rank(Object.freeze([redEye2, redEye0, redEye1]));
      expect(result.map((o) => o.id)).toEqual(['redeye-0', 'redeye-1', 'redeye-2']);
    });

    it('preserves originalIndex when offers have identical exact departure hours and attributes', () => {
      const duplicateA = Object.freeze(
        createOffer({ id: 'dup-0', stops: 0, price: 100, duration: 60, outboundDepartureHour: 8, originalIndex: 0 }),
      );
      const duplicateB = Object.freeze(
        createOffer({ id: 'dup-1', stops: 0, price: 100, duration: 60, outboundDepartureHour: 8, originalIndex: 1 }),
      );

      const resultForward = service.rank(Object.freeze([duplicateA, duplicateB]));
      expect(resultForward.map((o) => o.id)).toEqual(['dup-0', 'dup-1']);

      const resultReverse = service.rank(Object.freeze([duplicateB, duplicateA]));
      expect(resultReverse.map((o) => o.id)).toEqual(['dup-0', 'dup-1']);
    });
  });

  describe('Tier 1: stops ascending', () => {
    it('ranks nonstop (0 stops) ahead of 1 stop and 2 stops', () => {
      const offer0 = createOffer({ id: 'stops-0', stops: 0, price: 500, originalIndex: 0 });
      const offer1 = createOffer({ id: 'stops-1', stops: 1, price: 200, originalIndex: 1 });
      const offer2 = createOffer({ id: 'stops-2', stops: 2, price: 100, originalIndex: 2 });

      const result = service.rank([offer2, offer0, offer1]);
      expect(result.map((o) => o.id)).toEqual(['stops-0', 'stops-1', 'stops-2']);
    });
  });

  describe('Tier 2: price ascending', () => {
    it('ranks cheaper flights ahead when stops are equal', () => {
      const offerLow = createOffer({ id: 'price-100', price: 100, stops: 0, duration: 300, originalIndex: 0 });
      const offerMid = createOffer({ id: 'price-200', price: 200, stops: 0, duration: 200, originalIndex: 1 });
      const offerHigh = createOffer({ id: 'price-300', price: 300, stops: 0, duration: 100, originalIndex: 2 });

      const result = service.rank([offerHigh, offerLow, offerMid]);
      expect(result.map((o) => o.id)).toEqual(['price-100', 'price-200', 'price-300']);
    });
  });

  describe('Tier 3: duration ascending', () => {
    it('ranks shorter duration ahead when stops and price are equal', () => {
      const offerFast = createOffer({ id: 'dur-120', stops: 1, price: 250, duration: 120, originalIndex: 0 });
      const offerMed = createOffer({ id: 'dur-180', stops: 1, price: 250, duration: 180, originalIndex: 1 });
      const offerSlow = createOffer({ id: 'dur-240', stops: 1, price: 250, duration: 240, originalIndex: 2 });

      const result = service.rank([offerSlow, offerFast, offerMed]);
      expect(result.map((o) => o.id)).toEqual(['dur-120', 'dur-180', 'dur-240']);
    });
  });

  describe('Tier 4: departure red-eye penalty ascending', () => {
    it('ranks daytime departures (penalty 0) ahead of red-eye departures (penalty 1) when stops, price, duration match', () => {
      const redEyeOffer = createOffer({
        id: 'redeye-03am',
        stops: 0,
        price: 200,
        duration: 150,
        outboundDepartureHour: 3, // Red-eye: 00:00-04:59 -> penalty 1
        originalIndex: 0,
      });
      const daytimeOffer = createOffer({
        id: 'daytime-09am',
        stops: 0,
        price: 200,
        duration: 150,
        outboundDepartureHour: 9, // Daytime: penalty 0
        originalIndex: 1,
      });

      const result = service.rank([redEyeOffer, daytimeOffer]);
      expect(result.map((o) => o.id)).toEqual(['daytime-09am', 'redeye-03am']);
    });

    it('treats 00:00 through 04:59 as red-eye (penalty 1) and 05:00 through 23:59 as non-red-eye (penalty 0)', () => {
      const redEye04 = createOffer({
        id: 'redeye-04',
        stops: 0,
        price: 200,
        duration: 150,
        outboundDepartureHour: 4, // red-eye boundary
        originalIndex: 0,
      });
      const day05 = createOffer({
        id: 'day-05',
        stops: 0,
        price: 200,
        duration: 150,
        outboundDepartureHour: 5, // daytime boundary
        originalIndex: 1,
      });
      const night23 = createOffer({
        id: 'night-23',
        stops: 0,
        price: 200,
        duration: 150,
        outboundDepartureHour: 23, // late evening
        originalIndex: 2,
      });

      const result = service.rank([redEye04, night23, day05]);
      // day05 (penalty 0, idx 1) -> night23 (penalty 0, idx 2) -> redEye04 (penalty 1, idx 0)
      expect(result.map((o) => o.id)).toEqual(['day-05', 'night-23', 'redeye-04']);
    });
  });

  describe('Tier 5: originalIndex ascending (stable tie-breaker)', () => {
    it('preserves supplier originalIndex order when all other tiers are identical', () => {
      const offer0 = createOffer({ id: 'idx-0', stops: 0, price: 200, duration: 150, outboundDepartureHour: 10, originalIndex: 0 });
      const offer1 = createOffer({ id: 'idx-1', stops: 0, price: 200, duration: 150, outboundDepartureHour: 10, originalIndex: 1 });
      const offer2 = createOffer({ id: 'idx-2', stops: 0, price: 200, duration: 150, outboundDepartureHour: 10, originalIndex: 2 });

      const result = service.rank([offer2, offer0, offer1]);
      expect(result.map((o) => o.id)).toEqual(['idx-0', 'idx-1', 'idx-2']);
    });
  });

  describe('Multi-tier composition and precedence', () => {
    it('strictly respects hierarchy: stops > price > duration > red-eye > originalIndex', () => {
      const offerA = createOffer({
        id: 'A-direct-expensive',
        stops: 0,
        price: 500,
        duration: 300,
        outboundDepartureHour: 2, // red-eye
        originalIndex: 5,
      });

      const offerB = createOffer({
        id: 'B-1stop-cheapest-fastest',
        stops: 1,
        price: 100,
        duration: 100,
        outboundDepartureHour: 10, // daytime
        originalIndex: 1,
      });

      const offerC = createOffer({
        id: 'C-direct-cheap-slow',
        stops: 0,
        price: 200,
        duration: 250,
        outboundDepartureHour: 14,
        originalIndex: 3,
      });

      const offerD = createOffer({
        id: 'D-direct-cheap-fast-redeye',
        stops: 0,
        price: 200,
        duration: 180,
        outboundDepartureHour: 1, // red-eye
        originalIndex: 2,
      });

      const offerE = createOffer({
        id: 'E-direct-cheap-fast-daytime-idx1',
        stops: 0,
        price: 200,
        duration: 180,
        outboundDepartureHour: 11, // daytime
        originalIndex: 1,
      });

      const offerF = createOffer({
        id: 'F-direct-cheap-fast-daytime-idx4',
        stops: 0,
        price: 200,
        duration: 180,
        outboundDepartureHour: 15, // daytime
        originalIndex: 4,
      });

      // Expected ranking:
      // Direct flights (stops: 0):
      // - Price 200:
      //   - Duration 180:
      //     - Daytime (penalty 0):
      //       - originalIndex 1 -> offerE
      //       - originalIndex 4 -> offerF
      //     - Red-eye (penalty 1):
      //       - offerD
      //   - Duration 250:
      //     - offerC
      // - Price 500:
      //   - offerA
      // 1 stop (stops: 1):
      // - offerB
      const result = service.rank([offerB, offerA, offerD, offerF, offerC, offerE]);
      expect(result.map((o) => o.id)).toEqual([
        'E-direct-cheap-fast-daytime-idx1',
        'F-direct-cheap-fast-daytime-idx4',
        'D-direct-cheap-fast-redeye',
        'C-direct-cheap-slow',
        'A-direct-expensive',
        'B-1stop-cheapest-fastest',
      ]);
    });
  });

  describe('FlightMatchModule registration & isolation (T041)', () => {
    it('resolves CategoryRankerService and FlightMatchScorerService from FlightMatchModule', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [FlightMatchModule],
      }).compile();

      const ranker = module.get<CategoryRankerService>(CategoryRankerService);
      const scorer = module.get<FlightMatchScorerService>(FlightMatchScorerService);

      expect(ranker).toBeDefined();
      expect(ranker).toBeInstanceOf(CategoryRankerService);
      expect(scorer).toBeDefined();
      expect(scorer).toBeInstanceOf(FlightMatchScorerService);
    });
  });
});
