import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { JwtService } from '@nestjs/jwt';
import { DuffelService } from '@/duffel/duffel.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { DuffelOfferRequest } from '@/duffel/duffel.types';

describe('Flights Search (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let cacheService: CacheService;
  let jwtService: JwtService;
  let jwtToken: string;
  let userId: string;

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(assertion: () => Promise<void> | void, timeout = 2000, interval = 50) {
    const start = Date.now();
    for (;;) {
      try {
        await assertion();
        return;
      } catch (error) {
        if (Date.now() - start > timeout) {
          throw error;
        }
        await wait(interval);
      }
    }
  }

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'setTimeout'],
    }).setSystemTime(new Date('2026-07-08T12:00:00.000Z'));

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
  });

  afterAll(async () => {
    jest.useRealTimers();
    await app.close();
  });

  beforeEach(async () => {
    // Clean tables in dependent order
    await prisma.auditLog.deleteMany({});
    await prisma.offerRecovery.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.searchHistory.deleteMany({});
    await prisma.airport.deleteMany({});
    await prisma.user.deleteMany({});

    // Clear cache
    const keys = await cacheService.keys('*');
    for (const key of keys) {
      await cacheService.del(key);
    }

    // Seed mock airports
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
      ],
    });

    // Create active user
    const user = await prisma.user.create({
      data: {
        email: 'searchuser@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    userId = user.id;

    // Sign JWT
    jwtToken = jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '24h' });
  });

  describe('Authentication Check', () => {
    it('should return 401 Unauthorized when requesting without Bearer token', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          passengers: 2,
        })
        .expect(401);
    });
  });

  describe('Input Validation Checks', () => {
    it('should return 400 Bad Request when origin or destination is missing', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          destination: 'SGN',
          departureDate: '2026-07-15',
          passengers: 2,
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          departureDate: '2026-07-15',
          passengers: 2,
        })
        .expect(400);
    });

    it('should return 400 Bad Request when origin/destination has an invalid IATA code', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HANOI',
          destination: 'SGN',
          departureDate: '2026-07-15',
          passengers: 2,
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'sg',
          departureDate: '2026-07-15',
          passengers: 2,
        })
        .expect(400);
    });

    it('should return 400 Bad Request when origin and destination are the same', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'HAN',
          departureDate: '2026-07-15',
          passengers: 2,
        })
        .expect(400);
    });

    it('should return 400 Bad Request when passengers is out of range [1-9]', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          passengers: 0,
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          passengers: 10,
        })
        .expect(400);
    });

    it('should return 400 Bad Request when departureDate is in the past', async () => {
      // Current date in metadata is 2026-07-08. So 2026-07-07 is past.
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-07',
          passengers: 2,
        })
        .expect(400);
    });

    it('should return 400 Bad Request when returnDate is before departureDate', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          returnDate: '2026-07-14',
          passengers: 2,
        })
        .expect(400);
    });
  });

  describe('Successful Search & Side-Effects', () => {
    let sdkSpy: jest.SpyInstance;
    const mockDuffelResponse: DuffelOfferRequest = {
      id: 'or_mock_123',
      slices: [
        {
          id: 'sli_mock_1',
          duration: 'PT2H10M',
          origin: { id: 'HAN', name: 'Noi Bai International Airport', iata_code: 'HAN', type: 'airport' },
          destination: { id: 'SGN', name: 'Tan Son Nhat International Airport', iata_code: 'SGN', type: 'airport' },
          segments: [
            {
              id: 'seg_mock_1',
              duration: 'PT2H10M',
              departing_at: '2026-07-15T08:00:00',
              arriving_at: '2026-07-15T10:10:00',
              origin: { id: 'HAN', name: 'Noi Bai International Airport', iata_code: 'HAN', type: 'airport' },
              destination: { id: 'SGN', name: 'Tan Son Nhat International Airport', iata_code: 'SGN', type: 'airport' },
              operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
              marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
              marketing_carrier_flight_number: '123',
              aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
              passengers: [
                {
                  passenger_id: 'pas_mock_1',
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
        { id: 'pas_mock_1', type: 'adult' }
      ],
      offers: [
        {
          id: 'off_mock_123',
          total_amount: '125.50',
          total_currency: 'USD',
          slices: [
            {
              id: 'sli_mock_1',
              duration: 'PT2H10M',
              origin: { id: 'HAN', name: 'Noi Bai International Airport', iata_code: 'HAN', type: 'airport' },
              destination: { id: 'SGN', name: 'Tan Son Nhat International Airport', iata_code: 'SGN', type: 'airport' },
              segments: [
                {
                  id: 'seg_mock_1',
                  duration: 'PT2H10M',
                  departing_at: '2026-07-15T08:00:00',
                  arriving_at: '2026-07-15T10:10:00',
                  origin: { id: 'HAN', name: 'Noi Bai International Airport', iata_code: 'HAN', type: 'airport' },
                  destination: { id: 'SGN', name: 'Tan Son Nhat International Airport', iata_code: 'SGN', type: 'airport' },
                  operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                  marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                  marketing_carrier_flight_number: '123',
                  aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
                  passengers: [
                    {
                      passenger_id: 'pas_mock_1',
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
            { id: 'pas_mock_1', type: 'adult' }
          ],
          passenger_identity_documents_required: false
        }
      ]
    };

    let duffelService: DuffelService;

    beforeEach(() => {
      duffelService = app.get<DuffelService>(DuffelService);
      sdkSpy = jest.spyOn(duffelService['duffel'].offerRequests, 'create')
        .mockResolvedValue({
          data: mockDuffelResponse,
        } as unknown as { data: DuffelOfferRequest });
    });

    afterEach(() => {
      sdkSpy.mockRestore();
    });

    it('should perform a successful one-way search, mock DuffelService, verify return structure, async DB writes, and audit logs', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          passengers: 1,
        })
        .expect(200);

      // Verify return structure (results, meta)
      expect(res.body).toHaveProperty('results');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.results).toBeInstanceOf(Array);
      expect(res.body.results.length).toBe(1);

      const offer = res.body.results[0];
      expect(offer).toHaveProperty('id');
      expect(offer.airline).toBe('Vietnam Airlines');
      expect(offer.flightNumber).toBe('VN123');
      expect(offer.departureAirport).toBe('HAN');
      expect(offer.arrivalAirport).toBe('SGN');
      expect(offer.departureTime).toBe('2026-07-15T08:00:00');
      expect(offer.arrivalTime).toBe('2026-07-15T10:10:00');
      expect(offer.duration).toBe(130);
      expect(offer.stops).toBe(0);
      expect(offer.price).toBe(125.50);
      expect(offer.currency).toBe('USD');
      expect(offer.fareClass).toBe('Economy');
      expect(offer.baggageAllowance).toContain('1');

      const segment = offer.segments[0];
      expect(segment.carrierCode).toBe('VN');
      expect(segment.flightNumber).toBe('123');
      expect(segment.operatingCarrier).toBe('Vietnam Airlines');
      expect(segment.departureAirport).toBe('HAN');
      expect(segment.departureTime).toBe('2026-07-15T08:00:00');
      expect(segment.arrivalAirport).toBe('SGN');
      expect(segment.arrivalTime).toBe('2026-07-15T10:10:00');
      expect(segment.duration).toBe(130);
      expect(segment.aircraft).toBe('A321');

      expect(res.body.meta.totalResults).toBe(1);
      expect(res.body.meta.cached).toBe(false);
      expect(res.body.meta).toHaveProperty('searchHash');

      // Verify async DB writes (FlightOffer, SearchHistory, OfferRecovery)
      await waitFor(async () => {
        const history = await prisma.searchHistory.findFirst({
          where: { userId },
        });
        expect(history).toBeDefined();
        expect(history!.origin).toBe('HAN');
        expect(history!.destination).toBe('SGN');
        expect(history!.passengers).toBe(1);
        expect(history!.resultCount).toBe(1);
        expect(Number(history!.minPrice)).toBe(125.50);

        const offers = await prisma.flightOffer.findMany({
          where: { searchHash: history!.searchHash },
        });
        expect(offers.length).toBe(1);
        expect(offers[0].duffelOfferId).toBe('off_mock_123');

        const recovery = await prisma.offerRecovery.findUnique({
          where: { id: offers[0].id },
        });
        expect(recovery).toBeDefined();
        expect(recovery!.searchHash).toBe(history!.searchHash);
      });

      // Verify audit logs
      const auditLog = await prisma.auditLog.findFirst({
        where: { userId, action: 'flight_search' },
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.resourceType).toBe('Flight');
      const metadata = auditLog!.metadata as Record<string, unknown>;
      expect(metadata).toHaveProperty('origin', 'HAN');
      expect(metadata).toHaveProperty('destination', 'SGN');
      // No PII leak
      expect(metadata.email).toBeUndefined();
      expect(metadata.password).toBeUndefined();
    });

    it('should verify cache hit on repeated searches, bypassing DuffelService and not incrementing budget', async () => {
      // First Search (Cache Miss)
      const res1 = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          passengers: 1,
        })
        .expect(200);

      expect(res1.body.meta.cached).toBe(false);
      expect(sdkSpy).toHaveBeenCalledTimes(1);

      // Get budget key value
      const year = new Date().getFullYear();
      const month = String(new Date().getMonth() + 1).padStart(2, '0');
      const budgetKey = `budget:duffel:${year}-${month}`;
      const budgetValBefore = await cacheService.get(budgetKey);

      // Clear spy
      sdkSpy.mockClear();

      // Second Search (Cache Hit)
      const res2 = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          passengers: 1,
        })
        .expect(200);

      expect(res2.body.meta.cached).toBe(true);
      expect(sdkSpy).not.toHaveBeenCalled();

      const budgetValAfter = await cacheService.get(budgetKey);
      expect(budgetValAfter).toBe(budgetValBefore);
    });

    it('should return 429 TOO MANY REQUESTS when the search budget is exhausted', async () => {
      // Exhaust the budget key in Redis (Default limit is 1800 for user caller)
      const year = new Date().getFullYear();
      const month = String(new Date().getMonth() + 1).padStart(2, '0');
      const budgetKey = `budget:duffel:${year}-${month}`;
      await cacheService.set(budgetKey, '1800');

      const res = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          passengers: 1,
        })
        .expect(429);

      expect(res.body.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should return 502 BAD GATEWAY when the upstream Duffel API is down or unavailable', async () => {
      // Mock failure on the SDK spy
      sdkSpy.mockRejectedValueOnce(new Error('Upstream service connection timeout'));

      const res = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          passengers: 1,
        })
        .expect(502);

      expect(res.body.code).toBe('UPSTREAM_UNAVAILABLE');
      sdkSpy.mockRestore();
    });
  });
});
