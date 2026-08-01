process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { DuffelService } from '@/duffel/duffel.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { Prisma } from '@prisma/client';

describe('Ancillary Checkout Resilience & Observability (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let duffelService: DuffelService;

  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let tokenA: string;
  let tokenB: string;

  const mockSeatMapServices = (designator: string, amount: string) => [
    { serviceId: `srv_${designator}_p1`, passengerId: 'pas_1', amount, currency: 'USD' },
    { serviceId: `srv_${designator}_p2`, passengerId: 'pas_2', amount, currency: 'USD' },
  ];

  const mockCatalog = {
    fetchedAt: new Date().toISOString(),
    cache: { status: 'HIT', ttlSeconds: 50 },
    segments: [
      {
        segmentId: 'seg_1',
        origin: 'SGN',
        destination: 'SIN',
        seatMapAvailable: true,
        seatMap: {
          cabins: [
            {
              cabinClass: 'economy',
              rows: [
                {
                  rowNumber: 1,
                  elements: [
                    { type: 'seat', designator: '1A', availableServices: mockSeatMapServices('1a', '15.00') },
                    { type: 'aisle' },
                    { type: 'seat', designator: '1B', availableServices: mockSeatMapServices('1b', '15.00') },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
    baggageServices: [
      {
        serviceId: 'srv_bag_p1',
        passengerId: 'pas_1',
        segmentIds: ['seg_1'],
        type: 'checked',
        weightValue: 20,
        weightUnit: 'kg',
        maxQuantity: 2,
        amount: '25.00',
        currency: 'USD',
      },
    ],
  };

  beforeAll(async () => {
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
    app.setGlobalPrefix('api', { exclude: ['health'] });
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
    duffelService = moduleFixture.get<DuffelService>(DuffelService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    process.env.FEATURE_FLAG_ANCILLARY_CATALOG = 'true';
    process.env.FEATURE_FLAG_ANCILLARY_COMMIT = 'true';
    process.env.FEATURE_FLAG_ANCILLARY_PAYMENT = 'true';

    // Clean DB
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.baggageSelectionSegment.deleteMany({});
    await prisma.baggageSelection.deleteMany({});
    await prisma.seatSelection.deleteMany({});
    await prisma.ancillarySelection.deleteMany({});
    await prisma.bookingIntentPassenger.deleteMany({});
    await prisma.bookingIntent.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});

    // Users
    const uA = await prisma.user.create({
      data: { email: 'user.a@example.com', password: 'Password123!', status: 'ACTIVE' },
    });
    userA = { id: uA.id, email: uA.email };
    tokenA = jwtService.sign({ id: uA.id, email: uA.email }, { expiresIn: '24h' });

    const uB = await prisma.user.create({
      data: { email: 'user.b@example.com', password: 'Password123!', status: 'ACTIVE' },
    });
    userB = { id: uB.id, email: uB.email };
    tokenB = jwtService.sign({ id: uB.id, email: uB.email }, { expiresIn: '24h' });

    // Mock Duffel catalog read
    jest.spyOn(duffelService, 'getSeatMapsAndServices').mockResolvedValue(mockCatalog as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function createTestIntent(userId: string, overrides: Partial<Prisma.BookingIntentCreateInput> = {}) {
    const offer = await prisma.flightOffer.create({
      data: {
        searchHash: 'test-hash-' + Math.random(),
        duffelOfferId: 'off_duffel_test',
        rawOffer: {},
        origin: 'SGN',
        destination: 'SIN',
        departureDate: new Date('2026-10-10'),
        adults: 2,
        children: 0,
        infants: 0,
        price: new Prisma.Decimal(200.0),
        currency: 'USD',
      },
    });

    return prisma.bookingIntent.create({
      data: {
        userId,
        flightOfferId: offer.id,
        duffelOfferId: offer.duffelOfferId,
        status: 'PENDING',
        originalPrice: new Prisma.Decimal(200.0),
        confirmedPrice: new Prisma.Decimal(200.0),
        currency: 'USD',
        priceChanged: false,
        pricedAt: new Date(),
        origin: 'SGN',
        destination: 'SIN',
        departureDate: new Date('2026-10-10'),
        cabinClass: 'economy',
        adults: 2,
        children: 0,
        infants: 0,
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
        passengers: {
          create: [
            {
              position: 0,
              type: 'ADULT',
              givenName: 'Passenger',
              familyName: 'One',
              dateOfBirth: new Date('1990-01-01'),
              gender: 'm',
              duffelPassengerId: 'pas_1',
            },
            {
              position: 1,
              type: 'ADULT',
              givenName: 'Passenger',
              familyName: 'Two',
              dateOfBirth: new Date('1992-02-02'),
              gender: 'f',
              duffelPassengerId: 'pas_2',
            },
          ],
        },
        ...overrides,
      },
      include: { passengers: true },
    });
  }

  describe('Feature Flag Guarding & Access Control', () => {
    it('returns 404 when FEATURE_FLAG_ANCILLARY_CATALOG is false', async () => {
      process.env.FEATURE_FLAG_ANCILLARY_CATALOG = 'false';
      const intent = await createTestIntent(userA.id);

      const res = await request(app.getHttpServer())
        .get(`/api/bookings/intent/${intent.id}/ancillaries`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ANCILLARY_FEATURE_DISABLED');
    });

    it('returns 403 when FEATURE_FLAG_ANCILLARY_COMMIT is false', async () => {
      process.env.FEATURE_FLAG_ANCILLARY_COMMIT = 'false';
      const intent = await createTestIntent(userA.id);

      const res = await request(app.getHttpServer())
        .put(`/api/bookings/intent/${intent.id}/ancillaries`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', 'idemp-1')
        .send({
          expectedVersion: 0,
          catalogFingerprint: 'sha256:dummy',
          seats: [],
          baggage: [],
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ANCILLARY_COMMIT_DISABLED');
    });

    it('returns 403 when requesting non-owned intent', async () => {
      const intent = await createTestIntent(userA.id);

      const res = await request(app.getHttpServer())
        .get(`/api/bookings/intent/${intent.id}/ancillaries`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INTENT_FORBIDDEN');
    });

    it('returns 410 when intent is expired', async () => {
      const intent = await createTestIntent(userA.id, {
        intentExpiresAt: new Date(Date.now() - 1000),
      });

      const res = await request(app.getHttpServer())
        .get(`/api/bookings/intent/${intent.id}/ancillaries`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(410);
      expect(res.body.code).toBe('INTENT_EXPIRED');
    });
  });

  describe('Selection Commit, Optimistic Locking, and Idempotency', () => {
    it('commits selection, advances version, and logs structured audit telemetry', async () => {
      const intent = await createTestIntent(userA.id);
      const p1 = intent.passengers[0];

      // Get catalog first to obtain valid fingerprint
      const getRes = await request(app.getHttpServer())
        .get(`/api/bookings/intent/${intent.id}/ancillaries`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('x-trace-id', 'trace-123')
        .set('x-correlation-id', 'corr-123');

      expect(getRes.status).toBe(200);
      const fingerprint = getRes.body.catalog.fingerprint;

      const commitRes = await request(app.getHttpServer())
        .put(`/api/bookings/intent/${intent.id}/ancillaries`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', 'idemp-commit-1')
        .set('x-trace-id', 'trace-123')
        .set('x-correlation-id', 'corr-123')
        .send({
          expectedVersion: 0,
          catalogFingerprint: fingerprint,
          seats: [
            { intentPassengerId: p1.id, segmentId: 'seg_1', serviceId: 'srv_1a_p1' },
          ],
          baggage: [
            { intentPassengerId: p1.id, serviceId: 'srv_bag_p1', quantity: 1 },
          ],
        });

      expect(commitRes.status).toBe(200);
      expect(commitRes.body.selectionVersion).toBe(1);
      expect(commitRes.body.selectionStatus).toBe('DRAFT_COMMITTED');
      expect(commitRes.body.selection.totals.seats).toBe('15.00');
      expect(commitRes.body.selection.totals.baggage).toBe('25.00');
      expect(commitRes.body.selection.totals.ancillaries).toBe('40.00');

      // Verify audit logs created with traceId/correlationId and without PII
      const auditLog = await prisma.auditLog.findFirst({
        where: { action: 'ancillary_selection_committed' },
      });
      expect(auditLog).toBeDefined();
      expect(auditLog?.traceId).toBe('trace-123');
      expect(auditLog?.correlationId).toBe('corr-123');
      const metadataStr = JSON.stringify(auditLog?.metadata);
      expect(metadataStr).not.toMatch(/password|token|secret/i);
    });

    it('replays response when same idempotency key is submitted with same body', async () => {
      const intent = await createTestIntent(userA.id);

      const getRes = await request(app.getHttpServer())
        .get(`/api/bookings/intent/${intent.id}/ancillaries`)
        .set('Authorization', `Bearer ${tokenA}`);
      const fingerprint = getRes.body.catalog.fingerprint;

      const body = {
        expectedVersion: 0,
        catalogFingerprint: fingerprint,
        seats: [],
        baggage: [],
      };

      const res1 = await request(app.getHttpServer())
        .put(`/api/bookings/intent/${intent.id}/ancillaries`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', 'idemp-replay-key')
        .send(body);

      const res2 = await request(app.getHttpServer())
        .put(`/api/bookings/intent/${intent.id}/ancillaries`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', 'idemp-replay-key')
        .send(body);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body).toEqual(res2.body);
    });

    it('returns 409 ANCILLARY_VERSION_CONFLICT when expectedVersion does not match current version', async () => {
      const intent = await createTestIntent(userA.id);

      const getRes = await request(app.getHttpServer())
        .get(`/api/bookings/intent/${intent.id}/ancillaries`)
        .set('Authorization', `Bearer ${tokenA}`);
      const fingerprint = getRes.body.catalog.fingerprint;

      const res = await request(app.getHttpServer())
        .put(`/api/bookings/intent/${intent.id}/ancillaries`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', 'idemp-stale-ver')
        .send({
          expectedVersion: 5, // mismatched version
          catalogFingerprint: fingerprint,
          seats: [],
          baggage: [],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ANCILLARY_VERSION_CONFLICT');
    });
  });

  describe('Payment Validation & Resilience', () => {
    it('returns 400 when FEATURE_FLAG_ANCILLARY_PAYMENT is false and ancillary selection is present', async () => {
      process.env.FEATURE_FLAG_ANCILLARY_PAYMENT = 'false';
      const intent = await createTestIntent(userA.id);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', 'idemp-pay-disabled')
        .send({
          bookingIntentId: intent.id,
          ancillarySelectionId: '00000000-0000-0000-0000-000000000001',
          ancillarySelectionVersion: 1,
          paymentMethodId: 'pm_card_visa',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ANCILLARY_PAYMENT_DISABLED');
    });
  });
});
