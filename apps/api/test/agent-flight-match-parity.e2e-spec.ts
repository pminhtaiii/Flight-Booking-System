import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as crypto from 'crypto';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { CacheService } from '@/cache/cache.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { DuffelOffer, DuffelOfferRequest } from '@/duffel/duffel.types';
import { DuffelService } from '@/duffel/duffel.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@prisma/client';

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

const SEARCH_BODY = {
  origin: 'HAN',
  destination: 'SGN',
  departureDate: '2026-10-15',
  adults: 1,
  cabinClass: 'economy',
};

function airport(iataCode: 'HAN' | 'SGN' | 'DAD'): {
  id: string;
  name: string;
  iata_code: string;
  type: string;
} {
  const names: Record<string, string> = {
    HAN: 'Noi Bai International Airport',
    SGN: 'Tan Son Nhat International Airport',
    DAD: 'Da Nang International Airport',
  };
  return {
    id: iataCode,
    name: names[iataCode] || iataCode,
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
      passenger_id: 'pas_parity_1',
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
  const segments =
    fixture.stops === 0
      ? [directSegment]
      : [
          {
            ...directSegment,
            arriving_at: '2026-10-15T11:00:00',
            destination: airport('DAD'),
            duration: 'PT1H20M',
          },
          {
            ...directSegment,
            id: `${fixture.id}_segment_2`,
            departing_at: '2026-10-15T12:00:00',
            origin: airport('DAD'),
            duration: 'PT1H30M',
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
    passengers: [{ id: 'pas_parity_1', type: 'adult' }],
    passenger_identity_documents_required: false,
  };
}

function createParityOfferRequest(): DuffelOfferRequest {
  const offers = [
    // Offer 1: VN direct, best departure & arrival time -> highest match
    createOffer({
      id: 'off_parity_vn101',
      carrierCode: 'VN',
      carrierName: 'Vietnam Airlines',
      flightNumber: '101',
      price: '100.00',
      departureAt: '2026-10-15T08:00:00',
      arrivalAt: '2026-10-15T10:10:00',
      duration: 'PT2H10M',
      stops: 0,
    }),
    // Offer 2: VN direct, departure in window, price moderate
    createOffer({
      id: 'off_parity_vn103',
      carrierCode: 'VN',
      carrierName: 'Vietnam Airlines',
      flightNumber: '103',
      price: '120.00',
      departureAt: '2026-10-15T09:00:00',
      arrivalAt: '2026-10-15T11:10:00',
      duration: 'PT2H10M',
      stops: 0,
    }),
    // Offer 3: SQ 1-stop, departure in window, higher price
    createOffer({
      id: 'off_parity_sq201',
      carrierCode: 'SQ',
      carrierName: 'Singapore Airlines',
      flightNumber: '201',
      price: '160.00',
      departureAt: '2026-10-15T08:30:00',
      arrivalAt: '2026-10-15T14:30:00',
      duration: 'PT4H30M',
      stops: 1,
    }),
    // Offer 4: BA direct, departure outside window (13:00)
    createOffer({
      id: 'off_parity_ba301',
      carrierCode: 'BA',
      carrierName: 'British Airways',
      flightNumber: '301',
      price: '130.00',
      departureAt: '2026-10-15T13:00:00',
      arrivalAt: '2026-10-15T15:15:00',
      duration: 'PT2H15M',
      stops: 0,
    }),
    // Offer 5: SQ 1-stop, early departure in window
    createOffer({
      id: 'off_parity_sq205',
      carrierCode: 'SQ',
      carrierName: 'Singapore Airlines',
      flightNumber: '205',
      price: '180.00',
      departureAt: '2026-10-15T07:30:00',
      arrivalAt: '2026-10-15T15:00:00',
      duration: 'PT5H00M',
      stops: 1,
    }),
    // Offer 6: BA 1-stop, afternoon departure outside window (should be 6th, excluded from agent top-5)
    createOffer({
      id: 'off_parity_ba305',
      carrierCode: 'BA',
      carrierName: 'British Airways',
      flightNumber: '305',
      price: '220.00',
      departureAt: '2026-10-15T14:00:00',
      arrivalAt: '2026-10-15T19:30:00',
      duration: 'PT5H30M',
      stops: 1,
    }),
    // Offer 7: VN evening departure outside window (should be 7th, excluded from agent top-5)
    createOffer({
      id: 'off_parity_vn109',
      carrierCode: 'VN',
      carrierName: 'Vietnam Airlines',
      flightNumber: '109',
      price: '250.00',
      departureAt: '2026-10-15T18:00:00',
      arrivalAt: '2026-10-15T23:30:00',
      duration: 'PT5H30M',
      stops: 1,
    }),
  ];

  return {
    id: 'or_parity_fixture',
    offers,
    slices: offers[0].slices,
    passengers: offers[0].passengers,
  };
}

function mintClaimToken(
  userId: string,
  iat: number,
  secret = 'test-parity-claim-secret',
): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();
  const base64UrlPayload = Buffer.from(payloadStr).toString('base64url');
  const base64UrlSignature = signature.toString('base64url');
  return `${base64UrlPayload}.${base64UrlSignature}`;
}

describe('Agent Flight Match Parity (E2E)', () => {
  jest.setTimeout(45000);

  let app: INestApplication;
  let prisma: PrismaService;
  let cacheService: CacheService;
  let jwtService: JwtService;
  let duffelService: DuffelService;
  let duffelSpy: jest.SpyInstance;
  let duffelDetailSpy: jest.SpyInstance;

  const apiKey = 'test-parity-agent-api-key';
  const claimSecret = 'test-parity-claim-secret';
  let jwtToken: string;
  let claimToken: string;
  let testUser: { id: string; email: string };
  let chatSession: { id: string };
  let searchesStarted = 0;

  beforeAll(async () => {
    process.env.AGENT_SERVICE_API_KEY = apiKey;
    process.env.CLAIM_TOKEN_SECRET = claimSecret;
    process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
    process.env.ATTESTATION_SECRET = 'test-parity-attestation-secret';
    process.env.CHAT_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    cacheService = moduleFixture.get<CacheService>(CacheService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
    duffelService = moduleFixture.get<DuffelService>(DuffelService);

    duffelSpy = jest.spyOn(duffelService['duffel'].offerRequests, 'create');
    duffelDetailSpy = jest.spyOn(duffelService['duffel'].offers, 'get');
  });

  afterAll(async () => {
    duffelSpy.mockRestore();
    duffelDetailSpy.mockRestore();
    await app.close();
  });

  async function waitForWriteBehind(): Promise<void> {
    const timeoutAt = Date.now() + 5000;
    while (Date.now() < timeoutAt) {
      if ((await prisma.searchHistory.count()) >= searchesStarted) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  afterEach(async () => {
    await waitForWriteBehind();
  });

  beforeEach(async () => {
    searchesStarted = 0;

    // Ordered cleanup to satisfy foreign key constraints
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatMessage.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.cancellationRefundObligation.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.bookingIntentPassenger.deleteMany({});
    await prisma.bookingIntent.deleteMany({});
    await prisma.itineraryRevisionSegment.deleteMany({});
    await prisma.itineraryRevision.deleteMany({});
    await prisma.disruptionAuditEvent.deleteMany({});
    await prisma.notificationOutbox.deleteMany({});
    await prisma.booking.deleteMany({});
    await prisma.offerRecovery.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.searchHistory.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.airport.deleteMany({});
    await prisma.user.deleteMany({});

    for (const key of await cacheService.keys('*')) {
      await cacheService.del(key);
    }

    // Seed airports
    await prisma.airport.createMany({
      data: [
        {
          iataCode: 'HAN',
          icaoCode: 'VVNB',
          name: 'Noi Bai International Airport',
          city: 'Hanoi',
          country: 'VN',
          region: 'VN-HN',
          latitude: 21.2212,
          longitude: 105.807,
          elevation: 39,
          type: 'LARGE_AIRPORT',
          timezone: 'Asia/Ho_Chi_Minh',
        },
        {
          iataCode: 'SGN',
          icaoCode: 'VVTS',
          name: 'Tan Son Nhat International Airport',
          city: 'Ho Chi Minh City',
          country: 'VN',
          region: 'VN-SG',
          latitude: 10.8184,
          longitude: 106.6633,
          elevation: 33,
          type: 'LARGE_AIRPORT',
          timezone: 'Asia/Ho_Chi_Minh',
        },
        {
          iataCode: 'DAD',
          icaoCode: 'VVDN',
          name: 'Da Nang International Airport',
          city: 'Da Nang',
          country: 'VN',
          region: 'VN-DN',
          latitude: 16.0439,
          longitude: 108.1994,
          elevation: 10,
          type: 'LARGE_AIRPORT',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      ],
    });

    // Seed user with active status
    testUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `parity-${crypto.randomUUID()}@example.test`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });

    // Seed traveler profile with preferred airlines, schedule windows, and max stops
    await prisma.travelerProfile.create({
      data: {
        userId: testUser.id,
        preferredAirlines: ['VN'],
        blacklistedAirlines: [],
        classPreference: 'economy',
        preferredDepartureWindow: { start: 7, end: 10 },
        preferredArrivalWindow: { start: 9, end: 16 },
        maxStops: 1,
        priceSensitivity: 'MODERATE',
        requiresCheckedBaggage: true,
      },
    });

    // Create ChatSession owned by user for agent gateway calls
    chatSession = await prisma.chatSession.create({
      data: {
        userId: testUser.id,
      },
    });

    // Generate authentication tokens
    jwtToken = jwtService.sign(
      { id: testUser.id, email: testUser.email },
      { expiresIn: '24h' },
    );

    claimToken = mintClaimToken(testUser.id, Math.floor(Date.now() / 1000), claimSecret);

    duffelSpy.mockReset();
    duffelDetailSpy.mockReset();
    // Jest mockResolvedValue requires Duffel SDK return shape; type assertion is required for synthetic test fixture
    duffelSpy.mockResolvedValue({ data: createParityOfferRequest() } as unknown as never);
    duffelDetailSpy.mockResolvedValue({
      data: createParityOfferRequest().offers[0],
    } as unknown as never);
  });

  describe('100% Parity between Public Web Search and Agent V2 Search', () => {
    it('asserts 100% parity: exact same MATCHED mode, exact top 5 offers, identical scores, match levels, active weights, and explanation keys in exact same rank order', async () => {
      // 1. Execute Public Web Search (POST /api/flights/search)
      searchesStarted += 1;
      const webRes = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send(SEARCH_BODY)
        .expect(200);

      // 2. Execute Agent V2 Search (POST /agent-gateway/v2/flights/search)
      searchesStarted += 1;
      const agentRes = await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({
          chatSessionId: chatSession.id,
          proposedSnapshotVersion: 1,
          search: SEARCH_BODY,
        })
        .expect(201);

      // Verify basic response structures
      expect(webRes.body.results.length).toBe(7); // Web search returns all 7 candidate offers
      expect(agentRes.body.results.length).toBe(5); // Agent search strictly limits to top 5 offers

      // 100% Parity Assertion 1: Exact same mode (MATCHED)
      expect(agentRes.body.mode).toBe('MATCHED');
      expect(webRes.body.mode).toBe('MATCHED');
      expect(agentRes.body.mode).toBe(webRes.body.mode);

      // 100% Parity Assertion 2: Meta scoringVersion match
      expect(agentRes.body.meta.scoringVersion).toBe('flight-match-v1');
      expect(webRes.body.meta.scoringVersion).toBe('flight-match-v1');

      // 100% Parity Assertion 3: Exact top 5 offers and exact rank order
      for (let i = 0; i < 5; i++) {
        const webOffer = webRes.body.results[i];
        const agentOffer = agentRes.body.results[i];

        // Identical flight attributes and scheduling facts
        expect(agentOffer.airline).toBe(webOffer.airline);
        expect(agentOffer.flightNumber).toBe(webOffer.flightNumber);
        expect(agentOffer.departureAirport).toBe(webOffer.departureAirport);
        expect(agentOffer.arrivalAirport).toBe(webOffer.arrivalAirport);
        expect(agentOffer.departureTime).toBe(webOffer.departureTime);
        expect(agentOffer.arrivalTime).toBe(webOffer.arrivalTime);
        expect(agentOffer.duration).toBe(webOffer.duration);
        expect(agentOffer.stops).toBe(webOffer.stops);
        expect(agentOffer.price).toBe(webOffer.price);
        expect(agentOffer.currency).toBe(webOffer.currency);
        expect(agentOffer.fareClass).toBe(webOffer.fareClass);
        expect(agentOffer.baggageAllowance).toBe(webOffer.baggageAllowance);

        // 100% Parity Assertion 4: Identical score numbers and match levels
        expect(agentOffer.matchResult).not.toBeNull();
        expect(webOffer.matchResult).not.toBeNull();
        expect(agentOffer.matchResult.score).toBe(webOffer.matchResult.score);
        expect(typeof agentOffer.matchResult.score).toBe('number');
        expect(agentOffer.matchResult.matchLevel).toBe(webOffer.matchResult.matchLevel);
        expect(typeof agentOffer.matchResult.matchLevel).toBe('string');

        // 100% Parity Assertion 5: Identical eligibility
        expect(agentOffer.matchResult.eligibility.eligible).toBe(
          webOffer.matchResult.eligibility.eligible,
        );
        expect(agentOffer.matchResult.eligibility.violations).toEqual(
          webOffer.matchResult.eligibility.violations,
        );

        // 100% Parity Assertion 6: Identical active weights
        expect(agentOffer.matchResult.metadata.scoringVersion).toBe(
          webOffer.matchResult.metadata.scoringVersion,
        );
        expect(agentOffer.matchResult.metadata.activeWeights).toEqual(
          webOffer.matchResult.metadata.activeWeights,
        );

        // 100% Parity Assertion 7: Identical explanation keys, sub-scores, weights, and contributions
        expect(agentOffer.matchResult.breakdown).toHaveLength(
          webOffer.matchResult.breakdown.length,
        );
        for (let b = 0; b < agentOffer.matchResult.breakdown.length; b++) {
          const agentBreakdown = agentOffer.matchResult.breakdown[b];
          const webBreakdown = webOffer.matchResult.breakdown[b];

          expect(agentBreakdown.dimension).toBe(webBreakdown.dimension);
          expect(agentBreakdown.score).toBe(webBreakdown.score);
          expect(agentBreakdown.weight).toBe(webBreakdown.weight);
          expect(agentBreakdown.contribution).toBe(webBreakdown.contribution);
          expect(agentBreakdown.signal).toBe(webBreakdown.signal);

          // Explanation key parity
          expect(agentBreakdown.explanation.key).toBe(webBreakdown.explanation.key);
          expect(agentBreakdown.explanation.params).toEqual(webBreakdown.explanation.params);
        }
      }

      // Rank order strictly decreasing or equal score
      for (let i = 0; i < 4; i++) {
        const currentScore = agentRes.body.results[i].matchResult.score;
        const nextScore = agentRes.body.results[i + 1].matchResult.score;
        expect(currentScore).toBeGreaterThanOrEqual(nextScore);
      }
    });

    it('asserts 100% parity for cold-start RANKED mode when user profile has no preferences', async () => {
      // Clear profile preferences to trigger RANKED mode
      await prisma.travelerProfile.update({
        where: { userId: testUser.id },
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

      searchesStarted += 1;
      const webRes = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send(SEARCH_BODY)
        .expect(200);

      searchesStarted += 1;
      const agentRes = await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({
          chatSessionId: chatSession.id,
          proposedSnapshotVersion: 1,
          search: SEARCH_BODY,
        })
        .expect(201);

      // Both must enter RANKED mode
      expect(agentRes.body.mode).toBe('RANKED');
      expect(webRes.body.mode).toBe('RANKED');
      expect(agentRes.body.mode).toBe(webRes.body.mode);

      expect(agentRes.body.meta.scoringVersion).toBeNull();
      expect(webRes.body.meta.scoringVersion).toBeNull();

      expect(agentRes.body.results.length).toBe(5);

      // Parity across all 5 ranked items
      for (let i = 0; i < 5; i++) {
        const webOffer = webRes.body.results[i];
        const agentOffer = agentRes.body.results[i];

        expect(agentOffer.airline).toBe(webOffer.airline);
        expect(agentOffer.flightNumber).toBe(webOffer.flightNumber);
        expect(agentOffer.price).toBe(webOffer.price);
        expect(agentOffer.matchResult).toBeNull();
        expect(webOffer.matchResult).toBeNull();
      }
    });
  });

  describe('Gateway Response Privacy Invariants', () => {
    it('asserts gateway response contains zero customer PII', async () => {
      searchesStarted += 1;
      const agentRes = await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({
          chatSessionId: chatSession.id,
          proposedSnapshotVersion: 1,
          search: SEARCH_BODY,
        })
        .expect(201);

      const responseJson = JSON.stringify(agentRes.body);

      // Must not leak user email, password, or profile identifiers
      expect(responseJson).not.toContain(testUser.email);
      expect(responseJson).not.toContain('Password123!');
      expect(responseJson).not.toContain('MODERATE');
      expect(responseJson).not.toContain('priceSensitivity');
      expect(responseJson).not.toContain('requiresCheckedBaggage');

      // Must not leak customer identity/contact fields
      for (const piiKeyword of [
        'passport',
        'passportNumber',
        'contactEmail',
        'contactPhone',
        'phoneNumber',
        'creditCard',
        'dateOfBirth',
      ]) {
        expect(responseJson).not.toContain(piiKeyword);
      }
    });

    it('asserts gateway response contains zero raw provider IDs (duffelOfferId) in matchResult, explanations, and meta', async () => {
      searchesStarted += 1;
      const agentRes = await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({
          chatSessionId: chatSession.id,
          proposedSnapshotVersion: 1,
          search: SEARCH_BODY,
        })
        .expect(201);

      // Root response has no duffelOfferId
      expect(agentRes.body).not.toHaveProperty('duffelOfferId');

      // Metadata contains no duffelOfferId or provider IDs
      expect(agentRes.body.meta).not.toHaveProperty('duffelOfferId');
      const metaJson = JSON.stringify(agentRes.body.meta);
      expect(metaJson).not.toContain('off_');
      expect(metaJson).not.toContain('duffel');

      // Every matchResult, breakdown, explanation, and constraint contains zero duffelOfferId
      for (const result of agentRes.body.results) {
        const matchResult = result.matchResult;
        expect(matchResult).not.toHaveProperty('duffelOfferId');

        // matchResult JSON must not contain any provider ID substring
        const matchResultJson = JSON.stringify(matchResult);
        expect(matchResultJson).not.toContain('duffelOfferId');
        expect(matchResultJson).not.toContain('off_');
        expect(matchResultJson).not.toContain('duffel');
        expect(matchResultJson).not.toContain(result.duffelOfferId);

        // Every breakdown parameter must be allowlisted primitives without provider IDs
        for (const breakdown of matchResult.breakdown) {
          expect(breakdown).not.toHaveProperty('duffelOfferId');
          const explanationJson = JSON.stringify(breakdown.explanation);
          expect(explanationJson).not.toContain('duffelOfferId');
          expect(explanationJson).not.toContain('off_');
          expect(explanationJson).not.toContain('duffel');
        }
      }
    });

    it('asserts V1 gateway response (/agent-gateway/flights/search) contains zero duffelOfferId anywhere', async () => {
      searchesStarted += 1;
      const v1Res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .query({
          origin: 'HAN',
          destination: 'SGN',
          date: '2026-10-15',
          adults: 1,
        })
        .expect(200);

      expect(v1Res.body.results).toHaveLength(5);
      expect(v1Res.body.mode).toBe('MATCHED');

      // In V1, duffelOfferId is stripped from results completely
      for (const result of v1Res.body.results) {
        expect(result).not.toHaveProperty('duffelOfferId');
        expect(result).not.toHaveProperty('flightOfferId');
      }

      const v1Json = JSON.stringify(v1Res.body);
      expect(v1Json).not.toContain('off_');
      expect(v1Json).not.toContain(testUser.email);
    });
  });
});
