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

  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadStr)
    .digest();

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

  beforeEach(async () => {
    // Clear databases
    await prisma.auditLog.deleteMany({});
    await prisma.booking.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.user.deleteMany({});

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
      date: '2026-07-20',
      adults: '2',
    };

    it('should retrieve search results from Cache directly on cache hit without calling Duffel service', async () => {
      const normalizedQuery = {
        origin: 'HAN',
        destination: 'NRT',
        date: '2026-07-20',
        adults: 2,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
      };
      const queryStr = JSON.stringify(normalizedQuery);
      const sha256 = crypto.createHash('sha256').update(queryStr).digest('hex');
      const cacheKey = `flights:search:${sha256}`;

      // Mock cached results
      const mockCachedResults = {
        results: [
          {
            airline: 'Vietnam Airlines',
            flightNumber: 'VN310',
            departureAirport: 'HAN',
            arrivalAirport: 'NRT',
            departureTime: '2026-07-20T08:30:00',
            arrivalTime: '2026-07-20T15:00:00',
            duration: 330,
            stops: 0,
            price: 904.0,
            currency: 'USD',
            fareClass: 'Economy',
            baggageAllowance: '23kg checked',
          },
        ],
      };

      await cacheService.set(cacheKey, JSON.stringify(mockCachedResults), 900);

      // Spy on DuffelService.searchFlights
      const searchSpy = jest.spyOn(duffelService, 'searchFlights');

      // Make search request
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .query(query)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      expect(res.body).toEqual(mockCachedResults);
      expect(searchSpy).not.toHaveBeenCalled();

      searchSpy.mockRestore();
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
                destination: { id: 'NRT', name: 'Narita Airport', iata_code: 'NRT', type: 'airport' },
                segments: [
                  {
                    id: 'seg_1',
                    duration: 'PT5H30M',
                    departing_at: '2026-07-20T08:30:00',
                    arriving_at: '2026-07-20T15:00:00',
                    origin: { id: 'HAN', name: 'Hanoi Airport', iata_code: 'HAN', type: 'airport' },
                    destination: { id: 'NRT', name: 'Narita Airport', iata_code: 'NRT', type: 'airport' },
                    operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                    marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                    marketing_carrier_flight_number: '310',
                    passengers: [
                      {
                        passenger_id: 'pas_1',
                        cabin_class: 'economy',
                        baggages: [
                          { type: 'checked', quantity: 1 }
                        ]
                      }
                    ]
                  }
                ]
              }
            ],
            passengers: [
              { id: 'pas_1', type: 'adult' }
            ],
            passenger_identity_documents_required: false,
          }
        ]
      };

      const searchSpy = jest
        .spyOn(duffelService, 'searchFlights')
        .mockResolvedValue({
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
      expect(mapped.price).toBe(452.00);
      expect(mapped.currency).toBe('USD');
      expect(mapped.fareClass).toBe('Economy');
      expect(mapped.baggageAllowance).toBe('1 checked bag(s)');

      // PII exclusions checks
      expect(mapped.pnrCode).toBeUndefined();
      expect(mapped.eTicketNumber).toBeUndefined();
      expect(mapped.passportNumber).toBeUndefined();

      searchSpy.mockRestore();
    });

    it('should create an AuditLog with ACTION = TOOL_CALL when flight search succeeds', async () => {
      const searchSpy = jest
        .spyOn(duffelService, 'searchFlights')
        .mockResolvedValue({
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
        where: { userId: user.id, action: 'TOOL_CALL' },
      });
      expect(logs.length).toBe(1);
      expect(logs[0].resourceId).toBe('flights/search');

      searchSpy.mockRestore();
    });

    it('should create an AuditLog with ACTION = TOOL_CALL when flight search fails', async () => {
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
        where: { userId: user.id, action: 'TOOL_CALL' },
      });
      expect(logs.length).toBe(1);
      expect(logs[0].resourceId).toBe('flights/search');

      searchSpy.mockRestore();
    });
  });
});
