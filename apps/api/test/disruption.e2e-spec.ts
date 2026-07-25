process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.DUFFEL_WEBHOOK_SECRET = 'whsec_duffel_test_secret';
process.env.FEATURE_FLAG_DISRUPTION_INGRESS = 'true';
process.env.FEATURE_FLAG_DISRUPTION_PROCESSOR = 'true';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelService } from '@/duffel/duffel.service';
import { DuffelEventProcessor } from '@/disruption/webhook/duffel-event.processor';
import { DisruptionStatus, Prisma } from '@prisma/client';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import request from 'supertest';
import * as crypto from 'crypto';

describe('Disruption & Flight-Change Management (Webhook & Processor E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let processor: DuffelEventProcessor;
  let mockDuffelService: { retrieveCompleteOrder: jest.Mock };

  let userId: string;
  let bookingIntentId: string;
  let bookingId: string;
  let suffix: string;
  const webhookSecret = 'whsec_duffel_test_secret';

  beforeAll(async () => {
    mockDuffelService = {
      retrieveCompleteOrder: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DuffelService)
      .useValue(mockDuffelService)
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.setGlobalPrefix('api', { exclude: ['health'] });
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    processor = moduleFixture.get<DuffelEventProcessor>(DuffelEventProcessor);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    suffix = crypto.randomUUID();
    jest.clearAllMocks();

    const user = await prisma.user.create({
      data: {
        email: `test-webhook-e2e-user-${suffix}@example.com`,
        password: 'Password123!',
        role: 'USER',
        status: 'ACTIVE',
      },
    });
    userId = user.id;

    const intent = await prisma.bookingIntent.create({
      data: {
        userId,
        duffelOfferId: `off_fake_${suffix}`,
        originalPrice: new Prisma.Decimal('100.00'),
        confirmedPrice: new Prisma.Decimal('100.00'),
        currency: 'USD',
        pricedAt: new Date(),
        origin: 'HAN',
        destination: 'NRT',
        departureDate: new Date(),
        adults: 1,
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(Date.now() + 3600000),
      },
    });
    bookingIntentId = intent.id;

    const booking = await prisma.booking.create({
      data: {
        userId,
        bookingIntentId,
        totalAmount: new Prisma.Decimal('100.00'),
        currency: 'USD',
        status: 'CONFIRMED',
        duffelOrderId: `ord_fake_${suffix}`,
        flightSnapshot: {
          stops: 0,
          cabinClass: 'economy',
          totalDuration: 'PT2H',
          segments: [
            {
              airline: { name: 'Japan Airlines', iataCode: 'JL' },
              flightNumber: '752',
              departureAirport: { name: 'Noi Bai', iataCode: 'HAN', city: 'Hanoi', terminal: 'T2' },
              arrivalAirport: { name: 'Narita', iataCode: 'NRT', city: 'Tokyo', terminal: 'T2' },
              departureAt: '2026-08-01T12:00:00Z',
              arrivalAt: '2026-08-01T19:00:00Z',
              duration: 'PT7H',
              aircraftType: 'Boeing 787',
              duffelSegmentId: `seg_orig_${suffix}`,
              sliceOrder: 0,
              segmentOrder: 0,
              globalOrder: 0,
            },
          ],
        },
      },
    });
    bookingId = booking.id;
  });

  afterEach(async () => {
    await prisma.notificationOutbox.deleteMany({ where: { bookingId } });
    await prisma.disruptionAuditEvent.deleteMany({ where: { bookingId } });
    await prisma.itineraryRevisionSegment.deleteMany({ where: { revision: { bookingId } } });
    await prisma.itineraryRevision.deleteMany({ where: { bookingId } });
    await prisma.duffelWebhookEvent.deleteMany({ where: { duffelOrderId: `ord_fake_${suffix}` } });
    await prisma.booking.deleteMany({ where: { id: bookingId } });
    await prisma.bookingIntent.deleteMany({ where: { id: bookingIntentId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  const generateSignatureHeader = (timestamp: number, rawBody: string, secret: string) => {
    const message = `${timestamp}.${rawBody}`;
    const sig = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return `t=${timestamp},v1=${sig}`;
  };

  describe('POST /api/duffel/webhook (Ingestion)', () => {
    it('should fail if signature header is missing', async () => {
      const body = { id: `wev_fake_${suffix}`, type: 'order.airline_initiated_change_detected' };
      const response = await request(app.getHttpServer())
        .post('/api/duffel/webhook')
        .send(body);

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.error).toBe('WEBHOOK_SIGNATURE_MISSING');
    });

    it('should fail if signature timestamp is stale', async () => {
      const body = JSON.stringify({ id: `wev_fake_${suffix}`, type: 'order.airline_initiated_change_detected' });
      const staleTime = Math.floor(Date.now() / 1000) - 301;
      const signature = generateSignatureHeader(staleTime, body, webhookSecret);

      const response = await request(app.getHttpServer())
        .post('/api/duffel/webhook')
        .set('x-duffel-signature', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.error).toBe('WEBHOOK_SIGNATURE_INVALID');
    });

    it('should successfully ingest a supported event, persist to inbox, and return 200 quickly', async () => {
      const payload = {
        id: `wev_fake_${suffix}`,
        type: 'order.airline_initiated_change_detected',
        data: { object: { order_id: `ord_fake_${suffix}` } },
      };
      const body = JSON.stringify(payload);
      const now = Math.floor(Date.now() / 1000);
      const signature = generateSignatureHeader(now, body, webhookSecret);

      const startTime = Date.now();
      const response = await request(app.getHttpServer())
        .post('/api/duffel/webhook')
        .set('x-duffel-signature', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      const duration = Date.now() - startTime;
      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual({ received: true });
      expect(duration).toBeLessThan(500);

      const event = await prisma.duffelWebhookEvent.findUnique({
        where: { supplierEventId: `wev_fake_${suffix}` },
      });
      expect(event).toBeDefined();
      expect(event?.status).toBe('PENDING');
      expect(event?.duffelOrderId).toBe(`ord_fake_${suffix}`);
    });

    it('should return 200 and SKIPPED status for unsupported event type', async () => {
      const payload = {
        id: `wev_fake_${suffix}`,
        type: 'unsupported.event_type',
        data: { object: { order_id: `ord_fake_${suffix}` } },
      };
      const body = JSON.stringify(payload);
      const now = Math.floor(Date.now() / 1000);
      const signature = generateSignatureHeader(now, body, webhookSecret);

      const response = await request(app.getHttpServer())
        .post('/api/duffel/webhook')
        .set('x-duffel-signature', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(HttpStatus.OK);

      const event = await prisma.duffelWebhookEvent.findUnique({
        where: { supplierEventId: `wev_fake_${suffix}` },
      });
      expect(event).toBeDefined();
      expect(event?.status).toBe('SKIPPED');
    });

    it('should return 200 and not duplicate events on duplicate webhook delivery', async () => {
      const payload = {
        id: `wev_fake_${suffix}`,
        type: 'order.airline_initiated_change_detected',
        data: { object: { order_id: `ord_fake_${suffix}` } },
      };
      const body = JSON.stringify(payload);
      const now = Math.floor(Date.now() / 1000);
      const signature = generateSignatureHeader(now, body, webhookSecret);

      // First call
      await request(app.getHttpServer())
        .post('/api/duffel/webhook')
        .set('x-duffel-signature', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      // Duplicate call
      const response = await request(app.getHttpServer())
        .post('/api/duffel/webhook')
        .set('x-duffel-signature', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(HttpStatus.OK);

      const events = await prisma.duffelWebhookEvent.findMany({
        where: { supplierEventId: `wev_fake_${suffix}` },
      });
      expect(events.length).toBe(1);
    });
  });

  describe('DuffelEventProcessor (Async Processor)', () => {
    it('should process pending inbox event, invoke sync, and complete successfully', async () => {
      // 1. Create a pending webhook event in DB
      await prisma.duffelWebhookEvent.create({
        data: {
          supplierEventId: `wev_proc_${suffix}`,
          eventType: 'order.airline_initiated_change_detected',
          duffelOrderId: `ord_fake_${suffix}`,
          status: 'PENDING',
          rawPayload: {},
        },
      });

      mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
        id: `ord_fake_${suffix}`,
        slices: [
          {
            id: 'sli_1',
            segments: [
              {
                id: `seg_orig_${suffix}`,
                departing_at: '2026-08-01T15:00:00Z',
                arriving_at: '2026-08-01T22:00:00Z',
                origin: { iata_code: 'HAN', name: 'Noi Bai' },
                destination: { iata_code: 'NRT', name: 'Narita' },
                operating_carrier: { iata_code: 'JL', name: 'Japan Airlines' },
                marketing_carrier_flight_number: '752',
              },
            ],
          },
        ],
        passengers: [],
      });

      // 2. Trigger processor
      await processor.processInboxBatch();

      // 3. Confirm inbox event is PROCESSED
      const event = await prisma.duffelWebhookEvent.findUnique({
        where: { supplierEventId: `wev_proc_${suffix}` },
      });
      expect(event?.status).toBe('PROCESSED');
      expect(event?.processedAt).toBeDefined();

      // 4. Confirm booking status updated to DETECTED (due to material shift)
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      expect(booking?.disruptionStatus).toBe(DisruptionStatus.DETECTED);
    });

    it('should schedule retries for transient failures and escalate on 5th failure', async () => {
      // 1. Create a pending webhook event
      const dbEvent = await prisma.duffelWebhookEvent.create({
        data: {
          supplierEventId: `wev_fail_${suffix}`,
          eventType: 'order.airline_initiated_change_detected',
          duffelOrderId: `ord_fake_${suffix}`,
          status: 'PENDING',
          rawPayload: {},
          attempts: 0,
        },
      });

      // Cause syncBooking to fail
      mockDuffelService.retrieveCompleteOrder.mockRejectedValue(new Error('Duffel API timeout'));

      // Tick 1 (Attempt 1 fails -> RETRY_SCHEDULED)
      await processor.processInboxBatch();
      let event = await prisma.duffelWebhookEvent.findUnique({ where: { id: dbEvent.id } });
      expect(event?.status).toBe('RETRY_SCHEDULED');
      expect(event?.attempts).toBe(1);
      expect(event?.nextAttemptAt).toBeDefined();

      // For E2E simulation, reset nextAttemptAt so it can be claimed again
      await prisma.duffelWebhookEvent.update({
        where: { id: dbEvent.id },
        data: { nextAttemptAt: null },
      });

      // Tick 2, 3, 4
      for (let i = 2; i <= 4; i++) {
        await processor.processInboxBatch();
        await prisma.duffelWebhookEvent.update({
          where: { id: dbEvent.id },
          data: { nextAttemptAt: null },
        });
      }

      event = await prisma.duffelWebhookEvent.findUnique({ where: { id: dbEvent.id } });
      expect(event?.attempts).toBe(4);

      // Tick 5 (Attempt 5 fails -> Escalate to FAILED_NEEDS_ATTENTION)
      await processor.processInboxBatch();
      event = await prisma.duffelWebhookEvent.findUnique({ where: { id: dbEvent.id } });
      expect(event?.status).toBe('FAILED_NEEDS_ATTENTION');
      expect(event?.attempts).toBe(5);
      expect(event?.nextAttemptAt).toBeNull();
    });
  });
});
