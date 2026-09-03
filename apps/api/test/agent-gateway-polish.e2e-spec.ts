import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelService } from '@/duffel/duffel.service';
import { DuffelOfferRequest } from '@/duffel/duffel.types';
import * as crypto from 'crypto';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { User } from '@prisma/client';

function mintClaimToken(userId: string, iat: number, secret = 'test-claim-token-secret'): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);

  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();

  const base64UrlPayload = Buffer.from(payloadStr).toString('base64url');
  const base64UrlSignature = signature.toString('base64url');

  return `${base64UrlPayload}.${base64UrlSignature}`;
}

describe('Agent Gateway Polish (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let cacheService: CacheService;
  let duffelService: DuffelService;

  const apiKey = 'test-agent-api-key';
  let token: string;
  let user: User;

  beforeAll(async () => {
    process.env.AGENT_SERVICE_API_KEY = apiKey;
    process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';
    process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
    process.env.DUFFEL_ACCESS_TOKEN = 'mock-token';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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
    duffelService = moduleFixture.get<DuffelService>(DuffelService);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    // Clear databases
    await prisma.chatHandoff.deleteMany({});
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
    await prisma.travelerProfile.deleteMany({});
    await prisma.offerRecovery.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.searchHistory.deleteMany({});
    await prisma.airport.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});

    // User-requested CI repair: canonical search validates the airport reference table.
    await prisma.airport.createMany({
      data: [
        {
          iataCode: 'HAN',
          name: 'Noi Bai',
          city: 'Hanoi',
          country: 'VN',
          latitude: 21.2212,
          longitude: 105.807,
          type: 'LARGE_AIRPORT',
        },
        {
          iataCode: 'NRT',
          name: 'Narita',
          city: 'Tokyo',
          country: 'JP',
          latitude: 35.7647,
          longitude: 140.3864,
          type: 'LARGE_AIRPORT',
        },
      ],
    });

    // Reset Redis cache keys
    const keys = await cacheService.keys('*');
    for (const key of keys) {
      await cacheService.del(key);
    }

    // Create Active User
    user = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: 'agent-polish@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });

    const iat = Math.floor(Date.now() / 1000);
    token = mintClaimToken(user.id, iat);
  });

  describe('GET /flights/search Cache & Rate Limiting & Error Polish', () => {
    const query = {
      origin: 'HAN',
      destination: 'NRT',
      date: '2026-12-20',
      adults: '2',
    };

    it('should reuse raw cached offers without supplier calls and score them for each user', async () => {
      // User-requested CI repair: Phase 022 removed the mapped cache so user scores stay isolated.
      const normalizedQuery = {
        origin: 'HAN',
        destination: 'NRT',
        departureDate: '2026-12-20',
        returnDate: null,
        adults: 2,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
      };
      const queryStr = JSON.stringify(normalizedQuery);
      const sha256 = crypto.createHash('sha256').update(queryStr).digest('hex');
      const cacheKey = `flights:raw:${sha256}`;

      // Cache supplier data only; equal objective inputs retain supplier order for cold start.
      const mockCachedResults = {
        offers: [
          { code: 'VN', name: 'Vietnam Airlines', number: '310' },
          { code: 'NH', name: 'ANA', number: '858' },
        ].map((carrier) => ({
          id: `off_cache_${carrier.code}`,
          total_amount: '904.00',
          total_currency: 'USD',
          slices: [
            {
              duration: 'PT5H30M',
              segments: [
                {
                  duration: 'PT5H30M',
                  departing_at: '2026-12-20T08:30:00',
                  arriving_at: '2026-12-20T15:00:00',
                  origin: { iata_code: 'HAN' },
                  destination: { iata_code: 'NRT' },
                  operating_carrier: { iata_code: carrier.code, name: carrier.name },
                  marketing_carrier: { iata_code: carrier.code, name: carrier.name },
                  marketing_carrier_flight_number: carrier.number,
                  passengers: [
                    { cabin_class: 'economy', baggages: [{ type: 'checked', quantity: 1 }] },
                  ],
                },
              ],
            },
          ],
        })),
      };

      await cacheService.set(cacheKey, JSON.stringify(mockCachedResults), 900);
      // An exhausted budget makes a cache miss fail before any supplier request.
      const now = new Date();
      const budgetKey = `budget:duffel:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      await cacheService.set(budgetKey, '2000');

      // Make search request
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .query(query)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      expect(res.body.mode).toBe('RANKED');
      expect(res.body.meta.cached).toBe(true);
      expect(
        res.body.results.map((result: { flightNumber: string }) => result.flightNumber),
      ).toEqual(['VN310', 'NH858']);
      expect(res.body.results[0]).toMatchObject({
        airline: 'Vietnam Airlines',
        flightNumber: 'VN310',
        departureAirport: 'HAN',
        arrivalAirport: 'NRT',
        departureTime: '2026-12-20T08:30:00',
        arrivalTime: '2026-12-20T15:00:00',
        duration: 330,
        stops: 0,
        price: 904,
        currency: 'USD',
        fareClass: 'Economy',
        baggageAllowance: '1 checked bag(s)',
        matchResult: null,
      });

      const otherUser = await prisma.user.create({
        data: {
          email: 'agent-polish-other@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });
      await prisma.travelerProfile.create({
        data: { userId: otherUser.id, preferredAirlines: ['NH'], blacklistedAirlines: [] },
      });
      const personalized = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .query(query)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', mintClaimToken(otherUser.id, Math.floor(Date.now() / 1000)))
        .expect(200);

      expect(personalized.body.mode).toBe('MATCHED');
      expect(personalized.body.meta.cached).toBe(true);
      expect(
        personalized.body.results.map((result: { flightNumber: string }) => result.flightNumber),
      ).toEqual(['NH858', 'VN310']);
      expect(personalized.body.results[0].matchResult).not.toBeNull();
      expect(await cacheService.get(budgetKey)).toBe('2000');
      expect(JSON.parse((await cacheService.get(cacheKey))!)).toEqual(mockCachedResults);
    });

    it('should enforce budget limit and return 429 RATE_LIMIT_EXCEEDED if monthly budget is exceeded', async () => {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const budgetKey = `budget:duffel:${year}-${month}`;

      // Seed budget key with 1200 (which is the limit for agent, so any next increment exceeds it)
      await cacheService.set(budgetKey, '1200');

      // Make search request
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .query(query)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(429);

      expect(res.body.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should return 502 UPSTREAM_UNAVAILABLE on any upstream HTTP or Duffel client error', async () => {
      // Mock DuffelService.searchFlights to reject/throw an error
      const searchSpy = jest
        .spyOn(duffelService, 'searchFlights')
        .mockRejectedValue(new Error('Duffel API down'));

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .query(query)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(502);

      expect(res.body.code).toBe('UPSTREAM_UNAVAILABLE');

      searchSpy.mockRestore();
    });

    it('should perform PII stripping and map raw Duffel responses correctly to FlightResultDto', async () => {
      // Mock Duffel flight search raw output
      const rawDuffelResponse = {
        offers: [
          {
            id: '1',
            total_amount: '452.00',
            total_currency: 'USD',
            slices: [
              {
                id: 'sli_1',
                duration: 'PT5H30M',
                origin: { id: 'HAN', name: 'Hanoi Airport', iata_code: 'HAN', type: 'airport' },
                destination: {
                  id: 'NRT',
                  name: 'Narita Airport',
                  iata_code: 'NRT',
                  type: 'airport',
                },
                segments: [
                  {
                    id: 'seg_1',
                    duration: 'PT5H30M',
                    departing_at: '2026-07-20T08:30:00',
                    arriving_at: '2026-07-20T15:00:00',
                    origin: { id: 'HAN', name: 'Hanoi Airport', iata_code: 'HAN', type: 'airport' },
                    destination: {
                      id: 'NRT',
                      name: 'Narita Airport',
                      iata_code: 'NRT',
                      type: 'airport',
                    },
                    operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                    marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                    marketing_carrier_flight_number: '310',
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
          },
        ],
      };

      const searchSpy = jest.spyOn(duffelService, 'searchFlights').mockResolvedValue({
        offerRequest: rawDuffelResponse as unknown as DuffelOfferRequest,
        cached: false,
        searchHash: 'mock-hash',
      });

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .query(query)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      // Verify mapping
      expect(res.body.results.length).toBe(1);
      const mapped = res.body.results[0];

      expect(mapped.airline).toBe('Vietnam Airlines');
      expect(mapped.flightNumber).toBe('VN310');
      expect(mapped.departureAirport).toBe('HAN');
      expect(mapped.arrivalAirport).toBe('NRT');
      expect(mapped.departureTime).toBe('2026-07-20T08:30:00');
      expect(mapped.arrivalTime).toBe('2026-07-20T15:00:00');
      expect(mapped.duration).toBe(330);
      expect(mapped.stops).toBe(0);
      expect(mapped.price).toBe(452.0);
      expect(mapped.currency).toBe('USD');
      expect(mapped.fareClass).toBe('Economy');
      expect(mapped.baggageAllowance).toBe('1 checked bag(s)');

      // PII exclusions checks
      expect(mapped.pnrCode).toBeUndefined();
      expect(mapped.eTicketNumber).toBeUndefined();
      expect(mapped.passportNumber).toBeUndefined();

      searchSpy.mockRestore();
    });

    it('should create an AuditLog with ACTION = AGENT_TOOL_CALL when flight search succeeds', async () => {
      const searchSpy = jest.spyOn(duffelService, 'searchFlights').mockResolvedValue({
        offerRequest: {
          offers: [],
        } as unknown as DuffelOfferRequest,
        cached: false,
        searchHash: 'mock-hash',
      });

      await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .query(query)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      const logs = await prisma.auditLog.findMany({
        where: { userId: user.id, action: 'AGENT_TOOL_CALL' },
      });
      expect(logs.length).toBe(1);
      expect(logs[0].resourceId).toBe('flights/search');
      expect((logs[0].metadata as any).outcome).toBe('SUCCESS');
      expect((logs[0].metadata as any).parameters).toBeUndefined();

      searchSpy.mockRestore();
    });

    it('should create an AuditLog with ACTION = AGENT_TOOL_CALL when flight search fails', async () => {
      const searchSpy = jest
        .spyOn(duffelService, 'searchFlights')
        .mockRejectedValue(new Error('Duffel API down'));

      await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .query(query)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(502);

      const logs = await prisma.auditLog.findMany({
        where: { userId: user.id, action: 'AGENT_TOOL_CALL' },
      });
      expect(logs.length).toBe(1);
      expect(logs[0].resourceId).toBe('flights/search');
      expect((logs[0].metadata as any).outcome).toBe('FAILURE');
      expect((logs[0].metadata as any).parameters).toBeUndefined();

      searchSpy.mockRestore();
    });
  });
});
