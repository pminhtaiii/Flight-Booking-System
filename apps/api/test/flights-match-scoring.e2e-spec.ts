import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { CacheService } from '@/cache/cache.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { DuffelOffer, DuffelOfferRequest } from '@/duffel/duffel.types';
import { DuffelService } from '@/duffel/duffel.service';
import { PrismaService } from '@/prisma/prisma.service';

type FixtureOffer = {
  readonly id: string;
  readonly carrierCode: 'VN' | 'SQ' | 'BA';
  readonly carrierName: string;
  readonly flightNumber: string;
  readonly price: string;
  readonly departureAt: string;
  readonly arrivalAt: string;
  readonly duration: string;
  readonly stops: number;
};

type SearchResult = {
  readonly id: string;
  readonly segments: readonly { readonly carrierCode: string }[];
  readonly matchResult: {
    readonly eligibility: {
      readonly eligible: boolean;
      readonly violations: readonly {
        readonly constraint: string;
        readonly explanation: { readonly key: string; readonly params: Record<string, string | number | boolean> };
      }[];
    };
    readonly score: number | null;
    readonly matchLevel: string | null;
    readonly breakdown: readonly { readonly dimension: string; readonly contribution: number }[];
    readonly metadata: { readonly scoringVersion: string; readonly activeWeights: Record<string, number> };
  };
};

const SEARCH_BODY = {
  origin: 'HAN',
  destination: 'SGN',
  departureDate: '2026-10-15',
  adults: 1,
  cabinClass: 'economy',
};

function airport(iataCode: 'HAN' | 'SGN'): { id: string; name: string; iata_code: string; type: string } {
  return {
    id: iataCode,
    name: iataCode === 'HAN' ? 'Noi Bai International Airport' : 'Tan Son Nhat International Airport',
    iata_code: iataCode,
    type: 'airport',
  };
}

function createOffer(fixture: FixtureOffer): DuffelOffer {
  const carrier = {
    id: fixture.carrierCode,
    name: fixture.carrierName,
    iata_code: fixture.carrierCode,
  };
  const passengers = [
    {
      passenger_id: 'pas_match_1',
      cabin_class: 'economy',
      baggages: [{ type: 'checked', quantity: 1 }],
    },
  ];
  const directSegment = {
    id: `${fixture.id}_segment_1`,
    duration: fixture.duration,
    departing_at: fixture.departureAt,
    arriving_at: fixture.arrivalAt,
    origin: airport('HAN'),
    destination: airport('SGN'),
    operating_carrier: carrier,
    marketing_carrier: carrier,
    marketing_carrier_flight_number: fixture.flightNumber,
    aircraft: { id: 'arc_a321', name: 'Airbus A321', iata_code: '321' },
    passengers,
  };
  const segments = fixture.stops === 0
    ? [directSegment]
    : [
        {
          ...directSegment,
          arriving_at: '2026-10-15T11:00:00',
          destination: { id: 'BKK', name: 'Suvarnabhumi Airport', iata_code: 'BKK', type: 'airport' },
          duration: 'PT2H00M',
        },
        {
          ...directSegment,
          id: `${fixture.id}_segment_2`,
          departing_at: '2026-10-15T12:00:00',
          origin: { id: 'BKK', name: 'Suvarnabhumi Airport', iata_code: 'BKK', type: 'airport' },
          duration: 'PT2H30M',
        },
      ];

  return {
    id: fixture.id,
    total_amount: fixture.price,
    total_currency: 'USD',
    slices: [
      {
        id: `${fixture.id}_slice`,
        duration: fixture.duration,
        origin: airport('HAN'),
        destination: airport('SGN'),
        segments,
      },
    ],
    passengers: [{ id: 'pas_match_1', type: 'adult' }],
    passenger_identity_documents_required: false,
  };
}

function createOfferRequest(): DuffelOfferRequest {
  const offers = [
    createOffer({
      id: 'off_match_vn', carrierCode: 'VN', carrierName: 'Vietnam Airlines', flightNumber: '101',
      price: '100.00', departureAt: '2026-10-15T08:00:00', arrivalAt: '2026-10-15T10:10:00', duration: 'PT2H10M', stops: 0,
    }),
    createOffer({
      id: 'off_match_sq', carrierCode: 'SQ', carrierName: 'Singapore Airlines', flightNumber: '201',
      price: '160.00', departureAt: '2026-10-15T09:00:00', arrivalAt: '2026-10-15T14:30:00', duration: 'PT4H30M', stops: 1,
    }),
    createOffer({
      id: 'off_match_ba', carrierCode: 'BA', carrierName: 'British Airways', flightNumber: '301',
      price: '130.00', departureAt: '2026-10-15T13:00:00', arrivalAt: '2026-10-15T15:45:00', duration: 'PT2H45M', stops: 0,
    }),
  ];
  return { id: 'or_match_contract', offers, slices: offers[0].slices, passengers: offers[0].passengers };
}

function expectRequiredOfferShape(offer: Record<string, unknown>): void {
  for (const key of [
    'id', 'duffelOfferId', 'airline', 'flightNumber', 'departureAirport', 'arrivalAirport',
    'departureTime', 'arrivalTime', 'duration', 'stops', 'price', 'currency', 'fareClass',
    'baggageAllowance', 'requestedCabinClass', 'cabinClassMatch', 'cabinMismatchDetails',
    'segments', 'returnSegments', 'matchResult',
  ]) expect(offer).toHaveProperty(key);

  expect(offer.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(typeof offer.duffelOfferId).toBe('string');
  expect(typeof offer.price).toBe('number');
  expect(offer.price).toBeGreaterThan(0);
  expect(typeof offer.duration).toBe('number');
  expect(offer.duration).toBeGreaterThan(0);
  expect(offer.stops).toEqual(expect.any(Number));
  expect(offer.stops).toBeGreaterThanOrEqual(0);
  expect(offer.currency).toMatch(/^[A-Z]{3}$/);
  expect(offer.segments).toEqual(expect.any(Array));
  expect((offer.segments as unknown[]).length).toBeGreaterThan(0);
  expect(offer.returnSegments).toBeNull();

  for (const segment of offer.segments as Record<string, unknown>[]) {
    for (const key of [
      'carrierCode', 'flightNumber', 'operatingCarrier', 'departureAirport', 'departureTerminal',
      'departureTime', 'arrivalAirport', 'arrivalTerminal', 'arrivalTime', 'duration', 'aircraft', 'cabinClass',
    ]) expect(segment).toHaveProperty(key);
    expect(segment.carrierCode).toMatch(/^[A-Z]{2}$/);
    expect(typeof segment.duration).toBe('number');
    expect(segment.duration).toBeGreaterThan(0);
  }

  const matchResult = offer.matchResult as Record<string, unknown>;
  expect(matchResult).toEqual(expect.any(Object));
  expect(matchResult.eligibility).toEqual(expect.objectContaining({ eligible: expect.any(Boolean), violations: expect.any(Array) }));
  expect(matchResult.metadata).toEqual(expect.objectContaining({ scoringVersion: 'flight-match-v1', activeWeights: expect.any(Object) }));
  const activeWeights = (matchResult.metadata as Record<string, unknown>).activeWeights as Record<string, unknown>;
  const dimensions = ['PRICE', 'AIRLINE', 'ARRIVAL_SCHEDULE', 'STOPS', 'CABIN', 'DEPARTURE_SCHEDULE', 'BAGGAGE', 'DURATION'];
  for (const dimension of dimensions) {
    expect(activeWeights).toHaveProperty(dimension);
    expect(activeWeights[dimension]).toEqual(expect.any(Number));
    expect(activeWeights[dimension]).toBeGreaterThanOrEqual(0);
    expect(activeWeights[dimension]).toBeLessThanOrEqual(1);
  }

  const eligibility = matchResult.eligibility as Record<string, unknown>;
  if (eligibility.eligible === true) {
    expect(matchResult.score).toEqual(expect.any(Number));
    expect(matchResult.score).toBeGreaterThanOrEqual(0);
    expect(matchResult.score).toBeLessThanOrEqual(100);
    expect(matchResult.matchLevel).toMatch(/^(STRONG|GOOD|FAIR|WEAK)$/);
    expect(matchResult.breakdown).toHaveLength(8);
    for (const breakdown of matchResult.breakdown as Record<string, unknown>[]) {
      expect(dimensions).toContain(breakdown.dimension);
      expect(breakdown.score).toEqual(expect.any(Number));
      expect(breakdown.score).toBeGreaterThanOrEqual(0);
      expect(breakdown.score).toBeLessThanOrEqual(100);
      expect(breakdown.weight).toEqual(expect.any(Number));
      expect(breakdown.contribution).toEqual(expect.any(Number));
      expect(breakdown.signal).toMatch(/^(POSITIVE|NEUTRAL|NEGATIVE)$/);
      expect(breakdown.explanation).toEqual(expect.objectContaining({ key: expect.any(String), params: expect.any(Object) }));
    }
  } else {
    expect(matchResult.score).toBeNull();
    expect(matchResult.matchLevel).toBeNull();
    expect(matchResult.breakdown).toEqual([]);
  }
}

const MATCH_DIMENSIONS = [
  'PRICE',
  'AIRLINE',
  'ARRIVAL_SCHEDULE',
  'STOPS',
  'CABIN',
  'DEPARTURE_SCHEDULE',
  'BAGGAGE',
  'DURATION',
] as const;

function expectExactKeys(value: unknown, allowedKeys: readonly string[]): asserts value is Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  expect(Object.keys(value as Record<string, unknown>).sort()).toEqual([...allowedKeys].sort());
}

function expectPrimitiveExplanation(value: unknown): void {
  expectExactKeys(value, ['key', 'params']);
  expect(typeof value.key).toBe('string');
  expectExactKeys(value.params, Object.keys(value.params as Record<string, unknown>));
  for (const parameter of Object.values(value.params)) {
    expect(['string', 'number', 'boolean']).toContain(typeof parameter);
  }
}

const CABIN_CLASSES = ['economy', 'premium_economy', 'business', 'first'] as const;

function expectIntegerAtLeast(value: unknown, minimum: number): void {
  expect(typeof value).toBe('number');
  expect(Number.isInteger(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(minimum);
}

function expectNullableString(value: unknown): void {
  expect(value === null || typeof value === 'string').toBe(true);
}

function expectIsoDateTime(value: unknown): void {
  expect(typeof value).toBe('string');
  expect(value).toMatch(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/,
  );
  expect(Number.isNaN(Date.parse(value as string))).toBe(false);
}

function expectCabinClass(value: unknown): void {
  expect(typeof value).toBe('string');
  expect(CABIN_CLASSES).toContain(value);
}

function validateSegmentScalarConstraints(value: unknown): void {
  expectExactKeys(value, [
    'carrierCode',
    'flightNumber',
    'operatingCarrier',
    'departureAirport',
    'departureTerminal',
    'departureTime',
    'arrivalAirport',
    'arrivalTerminal',
    'arrivalTime',
    'duration',
    'aircraft',
    'cabinClass',
  ]);
  expect(typeof value.carrierCode).toBe('string');
  expect(typeof value.flightNumber).toBe('string');
  expect(typeof value.operatingCarrier).toBe('string');
  expect(value.departureAirport).toMatch(/^[A-Z]{3}$/);
  expectNullableString(value.departureTerminal);
  expectIsoDateTime(value.departureTime);
  expect(value.arrivalAirport).toMatch(/^[A-Z]{3}$/);
  expectNullableString(value.arrivalTerminal);
  expectIsoDateTime(value.arrivalTime);
  expectIntegerAtLeast(value.duration, 0);
  expectNullableString(value.aircraft);
  expectCabinClass(value.cabinClass);
}

function validateMatchedScalarAndCardinalityConstraints(value: unknown): void {
  expectExactKeys(value, ['mode', 'results', 'meta']);
  expect(value.mode).toBe('MATCHED');
  expect(Array.isArray(value.results)).toBe(true);
  expect((value.results as unknown[]).length).toBeLessThanOrEqual(20);

  expectExactKeys(value.meta, [
    'totalResults',
    'searchHash',
    'cached',
    'requestedCabinClass',
    'scoringVersion',
    'eligibleCount',
    'matchLevelCounts',
  ]);
  expectIntegerAtLeast(value.meta.totalResults, 0);
  expect(typeof value.meta.searchHash).toBe('string');
  expect(typeof value.meta.cached).toBe('boolean');
  expect(typeof value.meta.requestedCabinClass).toBe('string');
  expectNullableString(value.meta.scoringVersion);
  expectIntegerAtLeast(value.meta.eligibleCount, 0);
  expectExactKeys(value.meta.matchLevelCounts, ['STRONG', 'GOOD', 'FAIR', 'WEAK']);
  for (const count of Object.values(value.meta.matchLevelCounts)) {
    expectIntegerAtLeast(count, 0);
  }

  for (const rawOffer of value.results as unknown[]) {
    expectExactKeys(rawOffer, [
      'id',
      'duffelOfferId',
      'airline',
      'flightNumber',
      'departureAirport',
      'arrivalAirport',
      'departureTime',
      'arrivalTime',
      'duration',
      'stops',
      'price',
      'currency',
      'fareClass',
      'baggageAllowance',
      'requestedCabinClass',
      'cabinClassMatch',
      'cabinMismatchDetails',
      'segments',
      'returnSegments',
      'matchResult',
    ]);
    expect(typeof rawOffer.id).toBe('string');
    expect(typeof rawOffer.duffelOfferId).toBe('string');
    expect((rawOffer.duffelOfferId as string).length).toBeGreaterThanOrEqual(1);
    expect(typeof rawOffer.airline).toBe('string');
    expect(typeof rawOffer.flightNumber).toBe('string');
    expect(rawOffer.departureAirport).toMatch(/^[A-Z]{3}$/);
    expect(rawOffer.arrivalAirport).toMatch(/^[A-Z]{3}$/);
    expectIsoDateTime(rawOffer.departureTime);
    expectIsoDateTime(rawOffer.arrivalTime);
    expectIntegerAtLeast(rawOffer.duration, 0);
    expectIntegerAtLeast(rawOffer.stops, 0);
    expect(typeof rawOffer.price).toBe('number');
    expect(Number.isFinite(rawOffer.price)).toBe(true);
    expect(rawOffer.price).toBeGreaterThanOrEqual(0);
    expect(rawOffer.currency).toMatch(/^[A-Z]{3}$/);
    expectNullableString(rawOffer.fareClass);
    expectNullableString(rawOffer.baggageAllowance);
    expectCabinClass(rawOffer.requestedCabinClass);
    expect(['full', 'mixed', 'downgraded']).toContain(rawOffer.cabinClassMatch);

    expect(Array.isArray(rawOffer.segments)).toBe(true);
    expect((rawOffer.segments as unknown[]).length).toBeGreaterThanOrEqual(1);
    for (const segment of rawOffer.segments as unknown[]) {
      validateSegmentScalarConstraints(segment);
    }

    if (rawOffer.returnSegments === null) {
      expect(rawOffer.returnSegments).toBeNull();
    } else {
      expect(Array.isArray(rawOffer.returnSegments)).toBe(true);
      expect((rawOffer.returnSegments as unknown[]).length).toBeGreaterThanOrEqual(1);
      for (const segment of rawOffer.returnSegments as unknown[]) {
        validateSegmentScalarConstraints(segment);
      }
    }

    if (rawOffer.cabinMismatchDetails === null) {
      expect(rawOffer.cabinMismatchDetails).toBeNull();
    } else {
      expect(Array.isArray(rawOffer.cabinMismatchDetails)).toBe(true);
      for (const mismatch of rawOffer.cabinMismatchDetails as unknown[]) {
        expectExactKeys(mismatch, ['segmentIndex', 'leg', 'expected', 'actual', 'route']);
        expectIntegerAtLeast(mismatch.segmentIndex, 0);
        expect(['outbound', 'return']).toContain(mismatch.leg);
        expectCabinClass(mismatch.expected);
        expectCabinClass(mismatch.actual);
        expect(typeof mismatch.route).toBe('string');
      }
    }
  }
}

function validateMatchedSchemaEquivalent(value: unknown): void {
  expectExactKeys(value, ['mode', 'results', 'meta']);
  expect(value.mode).toBe('MATCHED');
  expect(Array.isArray(value.results)).toBe(true);
  expect((value.results as unknown[]).length).toBeLessThanOrEqual(20);
  expectExactKeys(value.meta, [
    'totalResults',
    'searchHash',
    'cached',
    'requestedCabinClass',
    'scoringVersion',
    'eligibleCount',
    'matchLevelCounts',
  ]);
  expectExactKeys(value.meta.matchLevelCounts, ['STRONG', 'GOOD', 'FAIR', 'WEAK']);

  for (const rawOffer of value.results as unknown[]) {
    expectExactKeys(rawOffer, [
      'id',
      'duffelOfferId',
      'airline',
      'flightNumber',
      'departureAirport',
      'arrivalAirport',
      'departureTime',
      'arrivalTime',
      'duration',
      'stops',
      'price',
      'currency',
      'fareClass',
      'baggageAllowance',
      'requestedCabinClass',
      'cabinClassMatch',
      'cabinMismatchDetails',
      'segments',
      'returnSegments',
      'matchResult',
    ]);
    for (const rawSegment of [
      ...(rawOffer.segments as unknown[]),
      ...((rawOffer.returnSegments as unknown[] | null) ?? []),
    ]) {
      expectExactKeys(rawSegment, [
        'carrierCode',
        'flightNumber',
        'operatingCarrier',
        'departureAirport',
        'departureTerminal',
        'departureTime',
        'arrivalAirport',
        'arrivalTerminal',
        'arrivalTime',
        'duration',
        'aircraft',
        'cabinClass',
      ]);
    }
    for (const rawMismatch of (rawOffer.cabinMismatchDetails as unknown[] | null) ?? []) {
      expectExactKeys(rawMismatch, ['segmentIndex', 'leg', 'expected', 'actual', 'route']);
    }

    expectExactKeys(rawOffer.matchResult, ['eligibility', 'score', 'matchLevel', 'breakdown', 'metadata']);
    const matchResult = rawOffer.matchResult;
    expectExactKeys(matchResult.eligibility, ['eligible', 'violations']);
    expectExactKeys(matchResult.metadata, ['scoringVersion', 'activeWeights']);
    expect(matchResult.metadata.scoringVersion).toBe('flight-match-v1');
    expectExactKeys(matchResult.metadata.activeWeights, MATCH_DIMENSIONS);
    for (const weight of Object.values(matchResult.metadata.activeWeights)) {
      expect(typeof weight).toBe('number');
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(1);
    }

    if (matchResult.eligibility.eligible === true) {
      expect(matchResult.eligibility.violations).toEqual([]);
      expect(Number.isInteger(matchResult.score)).toBe(true);
      expect(matchResult.score).toBeGreaterThanOrEqual(0);
      expect(matchResult.score).toBeLessThanOrEqual(100);
      expect(matchResult.matchLevel).toMatch(/^(STRONG|GOOD|FAIR|WEAK)$/);
      expect(matchResult.breakdown).toHaveLength(MATCH_DIMENSIONS.length);
      for (const rawDimension of matchResult.breakdown as unknown[]) {
        expectExactKeys(rawDimension, ['dimension', 'score', 'weight', 'contribution', 'signal', 'explanation']);
        expect(MATCH_DIMENSIONS).toContain(rawDimension.dimension);
        for (const boundedValue of [rawDimension.score, rawDimension.weight, rawDimension.contribution]) {
          expect(typeof boundedValue).toBe('number');
          expect(boundedValue).toBeGreaterThanOrEqual(0);
          expect(boundedValue).toBeLessThanOrEqual(1);
        }
        expect(rawDimension.signal).toMatch(/^(POSITIVE|NEUTRAL|NEGATIVE)$/);
        expectPrimitiveExplanation(rawDimension.explanation);
      }
    } else {
      expect(matchResult.eligibility.eligible).toBe(false);
      expect(matchResult.score).toBeNull();
      expect(matchResult.matchLevel).toBeNull();
      expect(matchResult.breakdown).toEqual([]);
      expect((matchResult.eligibility.violations as unknown[]).length).toBeGreaterThan(0);
      for (const rawViolation of matchResult.eligibility.violations as unknown[]) {
        expectExactKeys(rawViolation, ['constraint', 'explanation']);
        expect(rawViolation.constraint).toBe('BLACKLISTED_AIRLINE');
        expectPrimitiveExplanation(rawViolation.explanation);
      }
    }
  }
}

function expectRankedOfferShape(offer: Record<string, unknown>): void {
  for (const key of [
    'id', 'duffelOfferId', 'airline', 'flightNumber', 'departureAirport', 'arrivalAirport',
    'departureTime', 'arrivalTime', 'duration', 'stops', 'price', 'currency', 'fareClass',
    'baggageAllowance', 'requestedCabinClass', 'cabinClassMatch', 'cabinMismatchDetails',
    'segments', 'returnSegments', 'matchResult',
  ]) expect(offer).toHaveProperty(key);

  expect(offer.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(typeof offer.duffelOfferId).toBe('string');
  expect(typeof offer.price).toBe('number');
  expect(offer.price).toBeGreaterThan(0);
  expect(typeof offer.duration).toBe('number');
  expect(offer.duration).toBeGreaterThan(0);
  expect(offer.stops).toEqual(expect.any(Number));
  expect(offer.stops).toBeGreaterThanOrEqual(0);
  expect(offer.currency).toMatch(/^[A-Z]{3}$/);
  expect(offer.segments).toEqual(expect.any(Array));
  expect((offer.segments as unknown[]).length).toBeGreaterThan(0);
  expect(offer.returnSegments).toBeNull();
  expect(offer.matchResult).toBeNull();

  for (const segment of offer.segments as Record<string, unknown>[]) {
    validateSegmentScalarConstraints(segment);
  }
}

function validateRankedSchemaEquivalent(value: unknown): void {
  expectExactKeys(value, ['mode', 'results', 'meta']);
  expect(value.mode).toBe('RANKED');
  expect(Array.isArray(value.results)).toBe(true);

  expectExactKeys(value.meta, [
    'totalResults',
    'searchHash',
    'cached',
    'requestedCabinClass',
    'scoringVersion',
  ]);
  expect(value.meta.scoringVersion).toBeNull();
  expect(value.meta.eligibleCount).toBeUndefined();
  expect(value.meta.matchLevelCounts).toBeUndefined();
  expectIntegerAtLeast(value.meta.totalResults, 0);
  expect(typeof value.meta.searchHash).toBe('string');
  expect(typeof value.meta.cached).toBe('boolean');
  expect(typeof value.meta.requestedCabinClass).toBe('string');

  for (const rawOffer of value.results as unknown[]) {
    expectRankedOfferShape(rawOffer as Record<string, unknown>);
  }
}

function expectNoScoringPersistenceTables(tables: readonly { readonly table_name: string }[]): void {
  const scoringTablePattern = /(?:^|_)(?:flight_match(?:es)?|match_scores?|scores?|scoring)(?:_|$)/i;
  expect(tables.map(({ table_name }) => table_name).filter((name) => scoringTablePattern.test(name)))
    .toEqual([]);
}

async function warmRawCacheAsAgent(duffelService: DuffelService): Promise<void> {
  const warmed = await duffelService.searchFlights(
    {
      ...SEARCH_BODY,
      children: 0,
      infants: 0,
    },
    'agent',
  );
  expect(warmed.cached).toBe(false);
  expect(warmed.offerRequest.offers).toHaveLength(3);
}

describe('Flight match scoring (E2E)', (): void => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cacheService: CacheService;
  let jwtService: JwtService;
  let duffelService: DuffelService;
  let jwtToken: string;
  let duffelSpy: jest.SpyInstance;
  let duffelDetailSpy: jest.SpyInstance;
  let searchesStarted: number;

  async function waitForWriteBehind(): Promise<void> {
    const timeoutAt = Date.now() + 5_000;
    while (Date.now() < timeoutAt) {
      if ((await prisma.searchHistory.count()) >= searchesStarted) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The flight search write-behind did not finish before teardown.');
  }

  function search(): request.Test {
    searchesStarted += 1;
    return request(app.getHttpServer())
      .post('/api/flights/search')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send(SEARCH_BODY);
  }

  async function testUserId(): Promise<string> {
    return (await prisma.user.findUniqueOrThrow({ where: { email: 'match-contract@example.test' } })).id;
  }

  function scoreProjection(results: readonly SearchResult[]): Array<{ id: string; score: number | null }> {
    return results.map((result) => ({ id: result.id, score: result.matchResult.score }));
  }

  beforeAll(async (): Promise<void> => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    prisma = moduleFixture.get<PrismaService>(PrismaService);
    cacheService = moduleFixture.get<CacheService>(CacheService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
    duffelService = moduleFixture.get<DuffelService>(DuffelService);
    duffelSpy = jest.spyOn(duffelService['duffel'].offerRequests, 'create');
    duffelDetailSpy = jest.spyOn(duffelService['duffel'].offers, 'get');
  });

  afterAll(async (): Promise<void> => {
    duffelSpy.mockRestore();
    duffelDetailSpy.mockRestore();
    await app.close();
  });

  afterEach(async (): Promise<void> => {
    await waitForWriteBehind();
  });

  beforeEach(async (): Promise<void> => {
    searchesStarted = 0;
    await prisma.offerRecovery.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.searchHistory.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.airport.deleteMany({});
    await prisma.user.deleteMany({});
    for (const key of await cacheService.keys('*')) await cacheService.del(key);
    await prisma.airport.createMany({ data: [
      { iataCode: 'HAN', icaoCode: 'VVNB', name: 'Noi Bai International Airport', city: 'Hanoi', country: 'VN', region: 'VN-HN', latitude: 21.2212, longitude: 105.807, elevation: 39, type: 'LARGE_AIRPORT', timezone: 'Asia/Ho_Chi_Minh' },
      { iataCode: 'SGN', icaoCode: 'VVTS', name: 'Tan Son Nhat International Airport', city: 'Ho Chi Minh City', country: 'VN', region: 'VN-SG', latitude: 10.8184, longitude: 106.6633, elevation: 33, type: 'LARGE_AIRPORT', timezone: 'Asia/Ho_Chi_Minh' },
    ] });
    const user = await prisma.user.create({ data: { email: 'match-contract@example.test', password: 'Password123!', status: 'ACTIVE' } });
    await prisma.travelerProfile.create({ data: { userId: user.id, preferredAirlines: ['VN'], blacklistedAirlines: [], classPreference: 'economy', preferredDepartureWindow: { start: 7, end: 10 }, preferredArrivalWindow: { start: 9, end: 16 }, maxStops: 1, priceSensitivity: 'MODERATE', requiresCheckedBaggage: true } });
    jwtToken = jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '24h' });
    duffelSpy.mockReset();
    duffelDetailSpy.mockReset();
    // Duffel's SDK response type is external and wider than the local adapter contract.
    duffelSpy.mockResolvedValue({ data: createOfferRequest() } as unknown as never);
    duffelDetailSpy.mockResolvedValue({ data: createOfferRequest().offers[0] } as unknown as never);
  });

  it('returns the matched OpenAPI contract with private no-store headers', async (): Promise<void> => {
    const response = await search().expect(200);

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.etag).toBeUndefined();
    expect(response.body.mode).toBe('MATCHED');
    expect(response.body.results).toHaveLength(3);
    expect(response.body.results.length).toBeLessThanOrEqual(20);
    expect(response.body.meta).toEqual(expect.objectContaining({ scoringVersion: 'flight-match-v1', totalResults: 3, eligibleCount: 3 }));
    expect(response.body.meta.matchLevelCounts).toEqual(expect.objectContaining({ STRONG: expect.any(Number), GOOD: expect.any(Number), FAIR: expect.any(Number), WEAK: expect.any(Number) }));
    // Supertest exposes JSON response bodies as unknown; the preceding runtime assertion establishes this numeric map.
    const matchLevelCounts = response.body.meta.matchLevelCounts as Record<string, number>;
    expect(Object.values(matchLevelCounts).reduce((sum, count): number => sum + count, 0)).toBe(3);
    for (const offer of response.body.results as Record<string, unknown>[]) expectRequiredOfferShape(offer);
  });

  it('matches the strict MATCHED schema for eligible and ineligible offers', async (): Promise<void> => {
    const eligibleResponse = await search().expect(200);
    validateMatchedSchemaEquivalent(eligibleResponse.body);

    await prisma.travelerProfile.update({
      where: { userId: await testUserId() },
      data: { blacklistedAirlines: ['VN'] },
    });

    const mixedResponse = await search().expect(200);
    validateMatchedSchemaEquivalent(mixedResponse.body);
    expect((mixedResponse.body.results as SearchResult[]).some(
      (result) => result.matchResult.eligibility.eligible === false,
    )).toBe(true);
  });

  it('matches every remaining OpenAPI scalar, format, enum, minimum, and array constraint', async (): Promise<void> => {
    searchesStarted += 1;
    const response = await request(app.getHttpServer())
      .post('/api/flights/search')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({ ...SEARCH_BODY, cabinClass: 'business' })
      .expect(200);

    validateMatchedScalarAndCardinalityConstraints(response.body);
    expect(response.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        cabinClassMatch: 'downgraded',
        cabinMismatchDetails: expect.arrayContaining([
          expect.objectContaining({
            segmentIndex: expect.any(Number),
            leg: 'outbound',
            expected: 'business',
            actual: 'economy',
            route: expect.any(String),
          }),
        ]),
      }),
    ]));
  });

  it('returns identical matched scoring details from a repeated raw-cache search', async (): Promise<void> => {
    const firstResponse = await search().expect(200);
    const secondResponse = await search().expect(200);
    const project = (result: SearchResult) => ({
      id: result.id,
      score: result.matchResult.score,
      breakdown: result.matchResult.breakdown.map(({ dimension, contribution }) => ({
        dimension,
        contribution,
      })),
      activeWeights: result.matchResult.metadata.activeWeights,
    });

    expect((secondResponse.body.results as SearchResult[]).map(project))
      .toEqual((firstResponse.body.results as SearchResult[]).map(project));
    expect(duffelSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps a blacklisted carrier visible after every eligible offer', async (): Promise<void> => {
    await prisma.travelerProfile.update({
      where: { userId: await testUserId() },
      data: { blacklistedAirlines: ['VN'] },
    });

    const response = await search().expect(200);
    const results = response.body.results as SearchResult[];
    const vnIndex = results.findIndex((result) => result.segments[0].carrierCode === 'VN');
    const vn = results[vnIndex];

    expect(vnIndex).toBe(results.length - 1);
    expect(vn.matchResult).toMatchObject({
      eligibility: { eligible: false },
      score: null,
      matchLevel: null,
      breakdown: [],
      metadata: { scoringVersion: 'flight-match-v1' },
    });
    expect(vn.matchResult.eligibility.violations).toEqual([
      expect.objectContaining({
        constraint: 'BLACKLISTED_AIRLINE',
        explanation: expect.objectContaining({ key: expect.any(String), params: expect.any(Object) }),
      }),
    ]);
    for (const result of results.slice(0, -1)) expect(result.matchResult.eligibility.eligible).toBe(true);
  });

  it('reapplies the current profile when rescoring a cached raw search', async (): Promise<void> => {
    const firstResponse = await search().expect(200);
    const firstResults = firstResponse.body.results as SearchResult[];
    const firstVn = firstResults.find((result) => result.segments[0].carrierCode === 'VN')!;
    const firstSq = firstResults.find((result) => result.segments[0].carrierCode === 'SQ')!;

    await prisma.travelerProfile.update({
      where: { userId: await testUserId() },
      data: { preferredAirlines: ['SQ'] },
    });

    const secondResponse = await search().expect(200);
    const secondResults = secondResponse.body.results as SearchResult[];
    const secondVn = secondResults.find((result) => result.segments[0].carrierCode === 'VN')!;
    const secondSq = secondResults.find((result) => result.segments[0].carrierCode === 'SQ')!;

    expect(firstResponse.body.meta.cached).toBe(false);
    expect(secondResponse.body.meta.cached).toBe(true);
    expect(duffelSpy).toHaveBeenCalledTimes(1);
    expect(secondSq.matchResult.score).toBeGreaterThan(firstSq.matchResult.score!);
    expect(secondVn.matchResult.score).toBeLessThan(firstVn.matchResult.score!);
    expect(scoreProjection(secondResults)).not.toEqual(scoreProjection(firstResults));
  });

  it('recovers an agent-warmed raw cache offer for browser persistence and public detail', async (): Promise<void> => {
    await warmRawCacheAsAgent(duffelService);

    expect(await prisma.flightOffer.count()).toBe(0);
    expect(await prisma.offerRecovery.count()).toBe(0);

    const browserResponse = await search().expect(200);
    expect(browserResponse.body.meta.cached).toBe(true);
    expect(duffelSpy).toHaveBeenCalledTimes(1);
    await waitForWriteBehind();

    const selected = (browserResponse.body.results as SearchResult[])[0];
    expect(await prisma.flightOffer.findUnique({ where: { id: selected.id } }))
      .toEqual(expect.objectContaining({ id: selected.id }));
    expect(await prisma.offerRecovery.findUnique({ where: { id: selected.id } }))
      .toEqual(expect.objectContaining({ id: selected.id }));

    const detailResponse = await request(app.getHttpServer())
      .get(`/api/flights/${selected.id}`)
      .set('Authorization', `Bearer ${jwtToken}`)
      .expect(200);
    expect(detailResponse.body).toEqual(expect.objectContaining({
      id: selected.id,
      confirmedPrice: expect.any(Number),
      priceChanged: false,
    }));
    expect(duffelDetailSpy).toHaveBeenCalledTimes(1);
  });

  it('persists no scoring details in database rows or cache entries', async (): Promise<void> => {
    await search().expect(200);
    await waitForWriteBehind();

    const [flightOffers, searchHistory, offerRecoveries, columns] = await Promise.all([
      prisma.flightOffer.findMany(),
      prisma.searchHistory.findMany(),
      prisma.offerRecovery.findMany(),
      prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('flight_offers', 'search_history', 'offer_recoveries')
      `,
    ]);
    const serializedKeys = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(serializedKeys);
      if (value === null || typeof value !== 'object') return [];
      return Object.entries(value).flatMap(([key, nestedValue]) => [key, ...serializedKeys(nestedValue)]);
    };
    const forbiddenPersistenceKeys = new Set([
      'score', 'matchLevel', 'activeWeight', 'activeWeights', 'breakdown', 'explanation', 'scoringVersion', 'matchResult',
    ]);
    const persistedKeys = serializedKeys([flightOffers, searchHistory, offerRecoveries]);
    const cacheKeys = await cacheService.keys('*');
    const cacheValues = await Promise.all(cacheKeys.map((key) => cacheService.get(key)));

    expect(persistedKeys.some((key) => forbiddenPersistenceKeys.has(key))).toBe(false);
    expect(columns.map(({ column_name }) => column_name)).not.toEqual(expect.arrayContaining([
      'score', 'match_level', 'active_weight', 'active_weights', 'breakdown', 'explanation', 'scoring_version',
    ]));
    expect(cacheKeys).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/(?:^|:)(?:score|scores|match-score|scoring)(?:$|:)/),
    ]));
    for (const value of cacheValues) {
      expect(value).not.toMatch(/"(?:score|matchResult|matchLevel|activeWeight|activeWeights|breakdown|explanation|scoringVersion)"\s*:/);
    }
  });

  it('has no score- or scoring-specific table anywhere in the PostgreSQL public schema', async (): Promise<void> => {
    const publicTables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;

    expectNoScoringPersistenceTables(publicTables);
  });

  it('returns 200 mode RANKED with matchResult null and clean meta for authenticated user with empty traveler profile', async (): Promise<void> => {
    await prisma.travelerProfile.update({
      where: { userId: await testUserId() },
      data: {
        preferredAirlines: [],
        blacklistedAirlines: [],
        classPreference: null,
        preferredDepartureWindow: Prisma.DbNull,
        preferredArrivalWindow: Prisma.DbNull,
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      },
    });

    const response = await search().expect(200);

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.etag).toBeUndefined();
    validateRankedSchemaEquivalent(response.body);
    expect(response.body.mode).toBe('RANKED');
    expect(response.body.results).toHaveLength(3);
    expect(response.body.meta.scoringVersion).toBeNull();
    expect(response.body.meta.eligibleCount).toBeUndefined();
    expect(response.body.meta.matchLevelCounts).toBeUndefined();
    for (const offer of response.body.results as Record<string, unknown>[]) {
      expect(offer.matchResult).toBeNull();
    }
  });

  it('returns 200 mode RANKED with matchResult null for authenticated user with no traveler profile row', async (): Promise<void> => {
    await prisma.travelerProfile.deleteMany({
      where: { userId: await testUserId() },
    });

    const response = await search().expect(200);

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.etag).toBeUndefined();
    validateRankedSchemaEquivalent(response.body);
    expect(response.body.mode).toBe('RANKED');
    expect(response.body.results).toHaveLength(3);
    expect(response.body.meta.scoringVersion).toBeNull();
    expect(response.body.meta.eligibleCount).toBeUndefined();
    expect(response.body.meta.matchLevelCounts).toBeUndefined();
    for (const offer of response.body.results as Record<string, unknown>[]) {
      expect(offer.matchResult).toBeNull();
    }
  });

  it('returns 200 mode RANKED with empty results array and totalResults 0 when search returns 0 offers', async (): Promise<void> => {
    await prisma.travelerProfile.update({
      where: { userId: await testUserId() },
      data: {
        preferredAirlines: [],
        blacklistedAirlines: [],
        classPreference: null,
        preferredDepartureWindow: Prisma.DbNull,
        preferredArrivalWindow: Prisma.DbNull,
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      },
    });
    duffelSpy.mockResolvedValueOnce({
      data: { id: 'or_empty_offers', offers: [], slices: [], passengers: [] },
    } as unknown as never);

    const response = await search().expect(200);

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.etag).toBeUndefined();
    expect(response.body.mode).toBe('RANKED');
    expect(response.body.results).toEqual([]);
    expect(response.body.meta).toEqual(expect.objectContaining({
      totalResults: 0,
      scoringVersion: null,
      cached: false,
      requestedCabinClass: 'economy',
    }));
    expect(response.body.meta.eligibleCount).toBeUndefined();
    expect(response.body.meta.matchLevelCounts).toBeUndefined();
  });

  it('strictly orders cold-start search results by the stable 5-tier category order', async (): Promise<void> => {
    await prisma.travelerProfile.update({
      where: { userId: await testUserId() },
      data: {
        preferredAirlines: [],
        blacklistedAirlines: [],
        classPreference: null,
        preferredDepartureWindow: Prisma.DbNull,
        preferredArrivalWindow: Prisma.DbNull,
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      },
    });

    const tieOffers = [
      // Offer A (idx 0): 1 stop, $100, 120 min, 10:00 (daytime) -> tier 1 (stops) places it 6th
      createOffer({
        id: 'off_tie_a', carrierCode: 'VN', carrierName: 'Vietnam Airlines', flightNumber: '101',
        price: '100.00', departureAt: '2026-10-15T10:00:00', arrivalAt: '2026-10-15T14:30:00', duration: 'PT2H00M', stops: 1,
      }),
      // Offer B (idx 1): 0 stops, $200, 120 min, 10:00 (daytime) -> tier 2 (price) places it 5th
      createOffer({
        id: 'off_tie_b', carrierCode: 'VN', carrierName: 'Vietnam Airlines', flightNumber: '102',
        price: '200.00', departureAt: '2026-10-15T10:00:00', arrivalAt: '2026-10-15T12:00:00', duration: 'PT2H00M', stops: 0,
      }),
      // Offer C (idx 2): 0 stops, $100, 180 min, 10:00 (daytime) -> tier 3 (duration) places it 4th
      createOffer({
        id: 'off_tie_c', carrierCode: 'VN', carrierName: 'Vietnam Airlines', flightNumber: '103',
        price: '100.00', departureAt: '2026-10-15T10:00:00', arrivalAt: '2026-10-15T13:00:00', duration: 'PT3H00M', stops: 0,
      }),
      // Offer D (idx 3): 0 stops, $100, 120 min, 02:00 (red-eye) -> tier 4 (red-eye penalty) places it 3rd
      createOffer({
        id: 'off_tie_d', carrierCode: 'VN', carrierName: 'Vietnam Airlines', flightNumber: '104',
        price: '100.00', departureAt: '2026-10-15T02:00:00', arrivalAt: '2026-10-15T04:00:00', duration: 'PT2H00M', stops: 0,
      }),
      // Offer E (idx 4): 0 stops, $100, 120 min, 10:00 (daytime) -> tier 5 (index 4 < 5) places it 1st
      createOffer({
        id: 'off_tie_e', carrierCode: 'VN', carrierName: 'Vietnam Airlines', flightNumber: '105',
        price: '100.00', departureAt: '2026-10-15T10:00:00', arrivalAt: '2026-10-15T12:00:00', duration: 'PT2H00M', stops: 0,
      }),
      // Offer F (idx 5): 0 stops, $100, 120 min, 10:00 (daytime) -> tier 5 (index 5 > 4) places it 2nd
      createOffer({
        id: 'off_tie_f', carrierCode: 'VN', carrierName: 'Vietnam Airlines', flightNumber: '106',
        price: '100.00', departureAt: '2026-10-15T10:00:00', arrivalAt: '2026-10-15T12:00:00', duration: 'PT2H00M', stops: 0,
      }),
    ];

    duffelSpy.mockResolvedValueOnce({
      data: { id: 'or_tie_test', offers: tieOffers, slices: tieOffers[0].slices, passengers: tieOffers[0].passengers },
    } as unknown as never);

    const response = await search().expect(200);

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.etag).toBeUndefined();
    expect(response.body.mode).toBe('RANKED');
    expect(response.body.results).toHaveLength(6);
    validateRankedSchemaEquivalent(response.body);

    const resultOfferIds = (response.body.results as Array<{ duffelOfferId: string }>).map((r) => r.duffelOfferId);
    expect(resultOfferIds).toEqual([
      'off_tie_e',
      'off_tie_f',
      'off_tie_d',
      'off_tie_c',
      'off_tie_b',
      'off_tie_a',
    ]);
  });
});
