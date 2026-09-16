process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import Stripe from 'stripe';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { DuffelOrder } from '@/duffel/duffel.types';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import {
  Prisma,
  PaymentStatus,
  BookingStatus,
  FlightOffer,
  BookingIntent,
  Payment,
} from '@prisma/client';
import * as crypto from 'crypto';

interface MockDuffelOrder {
  id: string;
  booking_reference: string;
  slices: Array<{
    duration: string;
    segments: Array<{
      id: string;
      duration: string;
      departing_at: string;
      arriving_at: string;
      origin: {
        iata_code: string;
        name: string;
        city_name: string;
      };
      destination: {
        iata_code: string;
        name: string;
        city_name: string;
      };
      operating_carrier: {
        iata_code: string;
        name: string;
      };
      marketing_carrier: {
        iata_code: string;
        name: string;
      };
      marketing_carrier_flight_number: string;
      passengers: Array<{ cabin_class: string }>;
    }>;
  }>;
  passengers: Array<{
    id: string;
    type: string;
    given_name: string;
    family_name: string;
  }>;
}

describe('Payment Fulfillment (E2E Characterization)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let stripeService: StripeService;
  let duffelService: DuffelService;

  let testUser: { id: string; email: string };
  let testToken: string;

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
    stripeService = moduleFixture.get<StripeService>(StripeService);
    duffelService = moduleFixture.get<DuffelService>(DuffelService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.bookingAgentProjection.deleteMany({});
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

    const user = await prisma.user.create({
      data: {
        email: `fulfillment-test-${Date.now()}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    testUser = { id: user.id, email: user.email };
    testToken = jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '24h' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function createFlightOffer(): Promise<FlightOffer> {
    return prisma.flightOffer.create({
      data: {
        searchHash: `search-${Date.now()}-${crypto.randomUUID()}`,
        duffelOfferId: `off_test_${Date.now()}_${crypto.randomUUID()}`,
        rawOffer: {},
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-08-01'),
        adults: 1,
        children: 0,
        infants: 0,
        price: new Prisma.Decimal(100.0),
        currency: 'USD',
      },
    });
  }

  async function createBookingIntent(
    userId: string,
    flightOfferId: string,
  ): Promise<BookingIntent> {
    const now = new Date();
    return prisma.bookingIntent.create({
      data: {
        userId,
        flightOfferId,
        duffelOfferId: `off_intent_${Date.now()}_${crypto.randomUUID()}`,
        status: 'AWAITING_PAYMENT',
        originalPrice: new Prisma.Decimal(100.0),
        confirmedPrice: new Prisma.Decimal(125.5),
        currency: 'USD',
        priceChanged: false,
        pricedAt: now,
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-08-01'),
        cabinClass: 'economy',
        adults: 1,
        children: 0,
        infants: 0,
        rawOfferSnapshot: {
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  arriving_at: '2026-08-01T12:00:00Z',
                  operating_carrier: { iata_code: 'VN' },
                  marketing_carrier: { iata_code: 'VN' },
                  operating_carrier_flight_number: '123',
                },
              ],
            },
          ],
        },
        intentExpiresAt: new Date(now.getTime() + 3600 * 1000),
        paymentAttemptCount: 0,
        passengers: {
          create: [
            {
              position: 0,
              type: 'ADULT',
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: new Date('1990-01-01'),
              gender: 'male',
              title: 'mr',
              email: 'john.doe@example.com',
              phoneCountryCode: '+1',
              phoneNumber: '5551234567',
            },
          ],
        },
      },
    });
  }

  async function createPaymentFixture(
    userId: string,
    intentId: string,
  ): Promise<Payment> {
    const createIdemKey = await prisma.idempotencyKey.create({
      data: {
        key: `idem-create-${crypto.randomUUID()}`,
        requestHash: 'seed-hash',
        customerId: userId,
        requestPath: '/api/bookings/payment/create',
        recoveryPoint: 'started',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    return prisma.payment.create({
      data: {
        bookingIntentId: intentId,
        attemptNumber: 1,
        idempotencyKeyId: createIdemKey.id,
        stripePaymentIntentId: `pi_test_${crypto.randomUUID()}`,
        amount: 12550,
        currency: 'usd',
        status: PaymentStatus.CREATED,
        version: 0,
      },
    });
  }

  function getMockDuffelOrder(
    orderId = 'ord_char_200',
    reference = 'REF200',
  ): MockDuffelOrder {
    return {
      id: orderId,
      booking_reference: reference,
      slices: [
        {
          duration: 'PT2H0M',
          segments: [
            {
              id: 'seg_1',
              duration: 'PT2H0M',
              departing_at: '2026-08-01T10:00:00Z',
              arriving_at: '2026-08-01T12:00:00Z',
              origin: {
                iata_code: 'SGN',
                name: 'Tan Son Nhat International Airport',
                city_name: 'Ho Chi Minh City',
              },
              destination: {
                iata_code: 'HAN',
                name: 'Noi Bai International Airport',
                city_name: 'Hanoi',
              },
              operating_carrier: {
                iata_code: 'VN',
                name: 'Vietnam Airlines',
              },
              marketing_carrier: {
                iata_code: 'VN',
                name: 'Vietnam Airlines',
              },
              marketing_carrier_flight_number: 'VN123',
              passengers: [{ cabin_class: 'economy' }],
            },
          ],
        },
      ],
      passengers: [
        {
          id: 'pas_1',
          type: 'adult',
          given_name: 'John',
          family_name: 'Doe',
        },
      ],
    };
  }

  describe('Scenario 1: HTTP 200 Immediate Success', () => {
    it('successfully confirms payment, creates duffel order, captures payment intent and marks booking CONFIRMED', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_char_200', 'REF200');

      // Mock Stripe PaymentIntent with subset properties required by payment confirmation
      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      // Mock Duffel createOrder and retrieveCompleteOrder with required slice/segment snapshot fields
      jest
        .spyOn(duffelService, 'createOrder')
        .mockResolvedValue(mockOrder as unknown as Record<string, unknown>);
      jest
        .spyOn(duffelService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder as unknown as DuffelOrder);

      // Mock Stripe capturePaymentIntent with succeeded status
      jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'succeeded',
      } as unknown as Stripe.PaymentIntent);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-confirm-${crypto.randomUUID()}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        status: 'SUCCEEDED',
        paymentId: payment.id,
        bookingReference: 'REF200',
        duffelOrderId: 'ord_char_200',
      });

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.SUCCEEDED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.CONFIRMED);
    });
  });

  describe('Scenario 2: HTTP 202 Tier 2 Handoff', () => {
    it('returns HTTP 202 with PENDING status and polling URL when execution exceeds 25s threshold', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const paymentFixture = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_char_202', 'REF202');

      // Mock Stripe retrievePaymentIntent with requires_capture status
      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: paymentFixture.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      // Mock Duffel retrieveCompleteOrder with required snapshot fields
      jest
        .spyOn(duffelService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder as unknown as DuffelOrder);

      // Mock Stripe capturePaymentIntent with succeeded status
      jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
        id: paymentFixture.stripePaymentIntentId,
        status: 'succeeded',
      } as unknown as Stripe.PaymentIntent);

      const origSetTimeout = global.setTimeout;
      const timeoutSpy = jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((fn: Parameters<typeof setTimeout>[0], ms?: number) => {
          if (ms === 25000) {
            return origSetTimeout(fn, 10);
          }
          return origSetTimeout(fn, ms);
        });

      // Make createOrder hang for 50ms so the 10ms Tier-2 handoff threshold fires first
      jest.spyOn(duffelService, 'createOrder').mockImplementation(
        () =>
          new Promise((resolve) =>
            origSetTimeout(
              () => resolve(mockOrder as unknown as Record<string, unknown>),
              50,
            ),
          ),
      );

      try {
        const res = await request(app.getHttpServer())
          .post('/api/bookings/payment/confirm')
          .set('Authorization', `Bearer ${testToken}`)
          .set('Idempotency-Key', `idem-confirm-${crypto.randomUUID()}`)
          .send({ paymentId: paymentFixture.id, bookingId })
          .expect(202);

        expect(res.body).toEqual({
          status: 'PENDING',
          message: 'Booking is being confirmed. Please poll status.',
          pollUrl: expect.stringContaining(
            `/api/bookings/payment/${paymentFixture.id}/status`,
          ),
        });

        // Wait for background fulfillment to complete before teardown/restoring mocks
        for (let i = 0; i < 100; i++) {
          const payment = await prisma.payment.findUnique({
            where: { id: paymentFixture.id },
          });
          if (payment?.status === PaymentStatus.SUCCEEDED) {
            break;
          }
          await new Promise((resolve) => origSetTimeout(resolve, 50));
        }
      } finally {
        timeoutSpy.mockRestore();
      }
    });
  });

  describe('Scenario 3: Idempotency Replay Asymmetry', () => {
    it('replays cached HTTP 200 response without duplicating Stripe or Duffel calls', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_char_replay', 'REFREPLAY');
      const idempotencyKey = `idem-confirm-${crypto.randomUUID()}`;

      // Mock Stripe retrievePaymentIntent with requires_capture status
      const retrieveSpy = jest
        .spyOn(stripeService, 'retrievePaymentIntent')
        .mockResolvedValue({
          id: payment.stripePaymentIntentId,
          status: 'requires_capture',
        } as unknown as Stripe.PaymentIntent);

      // Mock Duffel createOrder and retrieveCompleteOrder with required snapshot fields
      const createOrderSpy = jest
        .spyOn(duffelService, 'createOrder')
        .mockResolvedValue(mockOrder as unknown as Record<string, unknown>);

      jest
        .spyOn(duffelService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder as unknown as DuffelOrder);

      // Mock Stripe capturePaymentIntent with succeeded status
      const captureSpy = jest
        .spyOn(stripeService, 'capturePaymentIntent')
        .mockResolvedValue({
          id: payment.stripePaymentIntentId,
          status: 'succeeded',
        } as unknown as Stripe.PaymentIntent);

      const payload = { paymentId: payment.id, bookingId };

      // First call succeeds (HTTP 200)
      const firstRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(200);

      expect(firstRes.body).toEqual({
        success: true,
        status: 'SUCCEEDED',
        paymentId: payment.id,
        bookingReference: 'REFREPLAY',
        duffelOrderId: 'ord_char_replay',
      });

      expect(retrieveSpy).toHaveBeenCalledTimes(1);
      expect(createOrderSpy).toHaveBeenCalledTimes(1);
      expect(captureSpy).toHaveBeenCalledTimes(1);

      // Replay call with identical Idempotency-Key and request payload
      const secondRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(200);

      expect(secondRes.body).toEqual(firstRes.body);

      // Assert no second Stripe/Duffel calls
      expect(retrieveSpy).toHaveBeenCalledTimes(1);
      expect(createOrderSpy).toHaveBeenCalledTimes(1);
      expect(captureSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Scenario 4: Validation Rejection', () => {
    it('rejects with 400 when Idempotency-Key header is missing', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(400);

      expect(res.body.message).toContain('Idempotency-Key header is required');
    });

    it('rejects with 400 when request payload is invalid or missing paymentId', async () => {
      const bookingId = crypto.randomUUID();

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-confirm-${crypto.randomUUID()}`)
        .send({ bookingId })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });
  });

  describe('Scenario 5: Controlled Compensation', () => {
    it('cancels Stripe hold, sets payment CANCELLED and booking FAILED on Duffel order failure', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();

      // Mock Stripe retrievePaymentIntent with requires_capture status
      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      jest
        .spyOn(duffelService, 'createOrder')
        .mockRejectedValue(new Error('Duffel booking failed'));

      // Mock Stripe cancelPaymentIntent on Duffel failure compensation
      const cancelSpy = jest
        .spyOn(stripeService, 'cancelPaymentIntent')
        .mockResolvedValue({
          id: payment.stripePaymentIntentId,
          status: 'canceled',
        } as unknown as Stripe.PaymentIntent);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-confirm-${crypto.randomUUID()}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(502);

      expect(res.body.success).toBe(false);
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy).toHaveBeenCalledWith(payment.stripePaymentIntentId);

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.CANCELLED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.FAILED);
    });
  });
});
