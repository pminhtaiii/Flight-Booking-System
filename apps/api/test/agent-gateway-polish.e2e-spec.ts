import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { AmadeusService } from '@/agent-gateway/amadeus/amadeus.service';
import { AmadeusFlightSearchResponse } from '@/agent-gateway/amadeus/amadeus.types';
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
  let amadeusService: AmadeusService;

  const apiKey = 'test-agent-api-key';
  let token: string;
  let user: User;

  beforeAll(async () => {
    process.env.AGENT_SERVICE_API_KEY = apiKey;
    process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';
    process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
    process.env.AMADEUS_API_KEY = 'mock-key';
    process.env.AMADEUS_API_SECRET = 'mock-secret';

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
    amadeusService = moduleFixture.get<AmadeusService>(AmadeusService);
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
      passengers: '2',
    };

    it('should retrieve search results from Cache directly on cache hit without calling Amadeus service', async () => {
      // 1. Build expected key
      // query properties will be parsed to origin, destination, date, passengers (as number or string? Query params in NestJS with transform can be string/number, let's check DTO: passengers is number, others are string)
      const normalizedQuery = {
        origin: 'HAN',
        destination: 'NRT',
        date: '2026-07-20',
        passengers: 2,
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
            departureTime: '2026-07-20T08:30:00Z',
            arrivalTime: '2026-07-20T15:00:00Z',
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

      // Spy on AmadeusService.searchFlights
      const searchSpy = jest.spyOn(amadeusService, 'searchFlights');

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
      const budgetKey = `budget:amadeus:${year}-${month}`;

      // Seed budget key with 2000 (which is the limit, so any next increment exceeds it)
      await cacheService.set(budgetKey, '2000');

      // Make search request
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .query(query)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(429);

      expect(res.body.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should return 502 UPSTREAM_UNAVAILABLE on any upstream HTTP or Amadeus client error', async () => {
      // Mock AmadeusService.searchFlights to reject/throw an error
      const searchSpy = jest
        .spyOn(amadeusService, 'searchFlights')
        .mockRejectedValue(new Error('Amadeus API down'));

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .query(query)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(502);

      expect(res.body.code).toBe('UPSTREAM_UNAVAILABLE');

      searchSpy.mockRestore();
    });

    it('should perform PII stripping and map raw Amadeus responses correctly to FlightResultDto', async () => {
      // Mock Amadeus flight search raw output
      const rawAmadeusResponse = {
        data: [
          {
            type: 'flight-offer',
            id: '1',
            source: 'GDS',
            instantTicketingRequired: false,
            nonHomogeneous: false,
            oneWay: false,
            lastTicketingDate: '2026-07-19',
            numberOfBookableSeats: 9,
            itineraries: [
              {
                duration: 'PT5H30M',
                segments: [
                  {
                    departure: {
                      iataCode: 'HAN',
                      at: '2026-07-20T08:30:00',
                    },
                    arrival: {
                      iataCode: 'NRT',
                      at: '2026-07-20T15:00:00',
                    },
                    carrierCode: 'VN',
                    number: '310',
                    duration: 'PT5H30M',
                    numberOfStops: 0,
                  },
                ],
              },
            ],
            price: {
              currency: 'USD',
              total: '452.00',
              base: '400.00',
            },
            pricingOptions: {
              fareType: ['PUBLISHED'],
              includedCheckedBagsOnly: true,
            },
            validatingCarrierCodes: ['VN'],
            travelerPricings: [
              {
                travelerId: '1',
                fareOption: 'STANDARD',
                travelerType: 'ADULT',
                price: {
                  currency: 'USD',
                  total: '452.00',
                  base: '400.00',
                },
                fareDetailsBySegment: [
                  {
                    segmentId: '1',
                    cabin: 'ECONOMY',
                    fareBasis: 'EOW',
                    class: 'E',
                    includedCheckedBags: {
                      quantity: 1,
                    },
                  },
                ],
              },
            ],
          },
        ],
        dictionaries: {
          carriers: {
            VN: 'VIETNAM AIRLINES',
          },
        },
      };

      const searchSpy = jest
        .spyOn(amadeusService, 'searchFlights')
        .mockResolvedValue(rawAmadeusResponse as unknown as AmadeusFlightSearchResponse);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search')
        .query(query)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      // Verify mapping
      expect(res.body.results.length).toBe(1);
      const mapped = res.body.results[0];

      // Convert carrier IATA code to title-cased airline name
      expect(mapped.airline).toBe('Vietnam Airlines');
      expect(mapped.flightNumber).toBe('VN310');
      expect(mapped.departureAirport).toBe('HAN');
      expect(mapped.arrivalAirport).toBe('NRT');
      expect(mapped.departureTime).toBe('2026-07-20T08:30:00'); // ISO 8601 string
      expect(mapped.arrivalTime).toBe('2026-07-20T15:00:00');
      expect(mapped.duration).toBe(330); // 5h 30m = 330 mins
      expect(mapped.stops).toBe(0);
      expect(mapped.price).toBe(452.00); // 452.00 as number
      expect(mapped.currency).toBe('USD');
      expect(mapped.fareClass).toBe('Economy'); // Cabin title cased
      expect(mapped.baggageAllowance).toBe('1 checked bag(s)'); // formatted bag

      // PII exclusions checks
      expect(mapped.pnrCode).toBeUndefined();
      expect(mapped.eTicketNumber).toBeUndefined();
      expect(mapped.passportNumber).toBeUndefined();

      searchSpy.mockRestore();
    });

    it('should create an AuditLog with ACTION = TOOL_CALL when flight search succeeds or fails', async () => {
      // Mock Amadeus success
      const searchSpy = jest
        .spyOn(amadeusService, 'searchFlights')
        .mockResolvedValue({
          data: [],
          dictionaries: { carriers: {} },
        } as unknown as AmadeusFlightSearchResponse);

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
  });
});
