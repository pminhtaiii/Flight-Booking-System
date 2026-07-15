process.env.ENCRYPTION_KEY = 'a'.repeat(64);

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';
import { PassengerType, Prisma } from '@prisma/client';
import { PaymentStatus, LedgerEntryType, PaymentEventSource } from '@shared/types';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { PaymentLedgerService } from '@/payment/payment-ledger.service';

describe('Payment System (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let stripeService: StripeService;
  let duffelService: DuffelService;

  let userA: { id: string; email: string };
  let tokenA: string;
  let tokenB: string;

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
  });

  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    await prisma.bookingIntentPassenger.deleteMany({});
    await prisma.bookingIntent.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.user.deleteMany({});

    // Create test users
    const uA = await prisma.user.create({
      data: {
        email: 'usera@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
        stripeCustomerId: 'cus_test_123',
      },
    });
    userA = { id: uA.id, email: uA.email };
    tokenA = jwtService.sign({ id: uA.id, email: uA.email }, { expiresIn: '24h' });

    const uB = await prisma.user.create({
      data: {
        email: 'userb@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
        stripeCustomerId: 'cus_test_456',
      },
    });
    tokenB = jwtService.sign({ id: uB.id, email: uB.email }, { expiresIn: '24h' });
  });

  async function createMockFlightOffer(data: Partial<Prisma.FlightOfferCreateInput> = {}) {
    return prisma.flightOffer.create({
      data: {
        searchHash: 'test-search-hash',
        duffelOfferId: 'off_duffel_123',
        rawOffer: {},
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-08-01'),
        adults: 1,
        children: 0,
        infants: 0,
        price: new Prisma.Decimal(125.50),
        currency: 'USD',
        ...data,
      },
    });
  }

  async function createMockBookingIntent(flightOfferId: string, status = 'PENDING') {
    const now = new Date();
    const intent = await prisma.bookingIntent.create({
      data: {
        userId: userA.id,
        flightOfferId,
        duffelOfferId: 'off_duffel_123',
        originalPrice: new Prisma.Decimal(125.50),
        confirmedPrice: new Prisma.Decimal(125.50),
        currency: 'USD',
        pricedAt: now,
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-08-01'),
        adults: 1,
        rawOfferSnapshot: {
          passengers: [{ id: 'pas_1', type: 'adult' }]
        },
        intentExpiresAt: new Date(now.getTime() + 30 * 60 * 1000),
        status: status as any,
      },
    });

    await prisma.bookingIntentPassenger.create({
      data: {
        intentId: intent.id,
        position: 0,
        type: PassengerType.ADULT,
        givenName: 'John',
        familyName: 'Doe',
        dateOfBirth: new Date('1990-01-01'),
        gender: 'male',
        nationality: 'US',
      }
    });

    return intent;
  }

  describe('POST /api/payments/create', () => {
    it('creates a payment row and stripe payment intent, returns client secret (201)', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id);

      const stripeSpy = jest.spyOn(stripeService, 'createPaymentIntent').mockResolvedValue({
        id: 'pi_test_123',
        client_secret: 'pi_test_123_secret_xyz',
        amount: 12550,
        currency: 'usd',
        status: 'requires_payment_method',
      } as any);

      const res = await request(app.getHttpServer())
        .post('/api/payments/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idemp-key-create-1')
        .send({
          bookingIntentId: intent.id,
          saveCard: false,
        })
        .expect(201);

      expect(stripeSpy).toHaveBeenCalled();
      stripeSpy.mockRestore();

      expect(res.body).toHaveProperty('paymentId');
      expect(res.body.stripeClientSecret).toBe('pi_test_123_secret_xyz');
      expect(res.body.status).toBe('CREATED');
      expect(res.body.amount).toBe(12550);

      // Verify db Payment row
      const payment = await prisma.payment.findUnique({
        where: { id: res.body.paymentId },
      });
      expect(payment).toBeDefined();
      expect(payment!.status).toBe(PaymentStatus.CREATED);
      expect(payment!.stripePaymentIntentId).toBe('pi_test_123');

      // Verify booking intent attempt count is incremented to 1, status to AWAITING_PAYMENT
      const updatedIntent = await prisma.bookingIntent.findUnique({
        where: { id: intent.id },
      });
      expect(updatedIntent!.paymentAttemptCount).toBe(1);
      expect(updatedIntent!.status).toBe('AWAITING_PAYMENT');
    });

    it('rejects creation if booking intent belongs to another user (403)', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id);

      await request(app.getHttpServer())
        .post('/api/payments/create')
        .set('Authorization', `Bearer ${tokenB}`)
        .set('Idempotency-Key', 'idemp-key-create-2')
        .send({
          bookingIntentId: intent.id,
        })
        .expect(403);
    });

    it('rejects creation if duplicate attempts concurrently hit pipeline (409)', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id);

      // We will implement the concurrent test inside payment.service.spec.ts or E2E, 
      // but here we can just verify that trying to create a payment when one is already CREATED/active throws 409
      await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          stripePaymentIntentId: 'pi_active_123',
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.CREATED,
          idempotencyKeyId: (await prisma.idempotencyKey.create({
            data: {
              key: 'key-existing-1',
              requestHash: 'hash',
              customerId: userA.id,
              requestPath: '/api/payments/create',
              expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
            }
          })).id,
        }
      });

      await request(app.getHttpServer())
        .post('/api/payments/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idemp-key-create-3')
        .send({
          bookingIntentId: intent.id,
        })
        .expect(409);
    });

    it('rejects if attempts exhausted (429)', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id);

      await prisma.bookingIntent.update({
        where: { id: intent.id },
        data: { paymentAttemptCount: 2, status: 'PAYMENT_EXHAUSTED' }
      });

      await request(app.getHttpServer())
        .post('/api/payments/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idemp-key-create-4')
        .send({
          bookingIntentId: intent.id,
        })
        .expect(429);
    });

    it('supports retry payment up to 2 attempts and blocks a third attempt (US3)', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id);

      let attempt = 1;
      const stripeSpy = jest.spyOn(stripeService, 'createPaymentIntent').mockImplementation(async () => {
        return {
          id: `pi_test_retry_${attempt++}`,
          client_secret: `pi_test_retry_secret_${attempt}`,
          amount: 12550,
          currency: 'usd',
          status: 'requires_payment_method',
        } as any;
      });

      // 1. Create first payment attempt with idempotency key 1
      const res1 = await request(app.getHttpServer())
        .post('/api/payments/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idemp-key-retry-1')
        .send({
          bookingIntentId: intent.id,
          saveCard: false,
        })
        .expect(201);

      expect(res1.body.attemptNumber).toBe(1);

      // 2. Update the first payment's status in the DB to FAILED (simulating failure).
      await prisma.payment.update({
        where: { id: res1.body.paymentId },
        data: { status: PaymentStatus.FAILED },
      });

      // 3. Create second payment attempt with idempotency key 2
      const res2 = await request(app.getHttpServer())
        .post('/api/payments/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idemp-key-retry-2')
        .send({
          bookingIntentId: intent.id,
          saveCard: false,
        })
        .expect(201);

      expect(res2.body.attemptNumber).toBe(2);

      // 4. Verify booking intent's paymentAttemptCount in the DB is 2.
      const updatedIntent = await prisma.bookingIntent.findUnique({
        where: { id: intent.id },
      });
      expect(updatedIntent!.paymentAttemptCount).toBe(2);

      // 5. Update the second payment's status in the DB to FAILED.
      await prisma.payment.update({
        where: { id: res2.body.paymentId },
        data: { status: PaymentStatus.FAILED },
      });

      // 6. Create a third payment attempt with idempotency key 3 -> should fail with 429
      await request(app.getHttpServer())
        .post('/api/payments/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idemp-key-retry-3')
        .send({
          bookingIntentId: intent.id,
          saveCard: false,
        })
        .expect(429);

      // Verify booking intent status is PAYMENT_EXHAUSTED
      const finalIntent = await prisma.bookingIntent.findUnique({
        where: { id: intent.id },
      });
      expect(finalIntent!.status).toBe('PAYMENT_EXHAUSTED');

      stripeSpy.mockRestore();
    });
  });

  describe('POST /api/payments/confirm', () => {
    it('confirms happy path: authorize -> Duffel PNR -> capture -> SUCCEEDED (200)', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');

      const idemp = await prisma.idempotencyKey.create({
        data: {
          key: 'idemp-key-create-5',
          requestHash: 'hash',
          customerId: userA.id,
          requestPath: '/api/payments/create',
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        }
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          stripePaymentIntentId: 'pi_confirm_123',
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.CREATED,
          idempotencyKeyId: idemp.id,
        }
      });

      // Spies
      const stripeRetrieveSpy = jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: 'pi_confirm_123',
        status: 'requires_capture',
        amount: 12550,
        currency: 'usd',
      } as any);

      // Add a spy on Duffel Service to mock order creation (PNR)
      // Since DuffelService doesn't have createOrder method yet, we'll spy on the mock version we add
      const duffelSpy = jest.spyOn(duffelService as any, 'createOrder').mockResolvedValue({
        id: 'ord_duffel_123',
        booking_reference: 'PNR123',
      } as any);

      const stripeCaptureSpy = jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
        id: 'pi_confirm_123',
        status: 'succeeded',
        amount: 12550,
        currency: 'usd',
      } as any);

      const res = await request(app.getHttpServer())
        .post('/api/payments/confirm')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idemp-key-confirm-1')
        .send({
          paymentId: payment.id,
        })
        .expect(200);

      expect(stripeRetrieveSpy).toHaveBeenCalledWith('pi_confirm_123');
      expect(duffelSpy).toHaveBeenCalled();
      expect(stripeCaptureSpy).toHaveBeenCalledWith('pi_confirm_123', expect.any(String));

      stripeRetrieveSpy.mockRestore();
      duffelSpy.mockRestore();
      stripeCaptureSpy.mockRestore();

      expect(res.body.paymentId).toBe(payment.id);
      expect(res.body.status).toBe('SUCCEEDED');
      expect(res.body.bookingIntentStatus).toBe('COMPLETED');
      expect(res.body.pnrReference).toBe('PNR123');

      // Verify DB updates
      const updatedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(updatedPayment!.status).toBe(PaymentStatus.SUCCEEDED);

      const updatedIntent = await prisma.bookingIntent.findUnique({ where: { id: intent.id } });
      expect(updatedIntent!.status).toBe('COMPLETED');

      // Verify Ledger
      const ledgerEntries = await prisma.ledgerEntry.findMany({ where: { paymentId: payment.id } });
      expect(ledgerEntries.length).toBe(2);
      const debit = ledgerEntries.find(e => e.entryType === LedgerEntryType.DEBIT);
      const credit = ledgerEntries.find(e => e.entryType === LedgerEntryType.CREDIT);
      expect(debit!.accountId).toBe('CUSTOMER_RECEIVABLE');
      expect(debit!.amount).toBe(12550);
      expect(credit!.accountId).toBe('PLATFORM_REVENUE');
      expect(credit!.amount).toBe(12550);
      expect(debit!.transactionId).toBe(credit!.transactionId);

      // Verify audit events
      const events = await prisma.paymentEvent.findMany({ where: { paymentId: payment.id } });
      expect(events.some(e => e.eventType === 'booking_confirmed')).toBe(true);
    });

    it('voids authorization if Duffel order creation fails (502)', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');

      const idemp = await prisma.idempotencyKey.create({
        data: {
          key: 'idemp-key-create-6',
          requestHash: 'hash',
          customerId: userA.id,
          requestPath: '/api/payments/create',
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        }
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          stripePaymentIntentId: 'pi_confirm_fail_123',
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.CREATED,
          idempotencyKeyId: idemp.id,
        }
      });

      const stripeRetrieveSpy = jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: 'pi_confirm_fail_123',
        status: 'requires_capture',
        amount: 12550,
        currency: 'usd',
      } as any);

      const duffelSpy = jest.spyOn(duffelService as any, 'createOrder').mockRejectedValue(
        new Error('Duffel API Error')
      );

      const stripeCancelSpy = jest.spyOn(stripeService, 'cancelPaymentIntent').mockResolvedValue({
        id: 'pi_confirm_fail_123',
        status: 'canceled',
      } as any);

      await request(app.getHttpServer())
        .post('/api/payments/confirm')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idemp-key-confirm-2')
        .send({
          paymentId: payment.id,
        })
        .expect(502);

      expect(stripeRetrieveSpy).toHaveBeenCalled();
      expect(duffelSpy).toHaveBeenCalled();
      expect(stripeCancelSpy).toHaveBeenCalledWith('pi_confirm_fail_123', expect.any(String));

      stripeRetrieveSpy.mockRestore();
      duffelSpy.mockRestore();
      stripeCancelSpy.mockRestore();

      // Verify payment transitioned to CANCELLED in DB
      const updatedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(updatedPayment!.status).toBe(PaymentStatus.CANCELLED);
    });

    it('transitions AUTHORIZED payment to CANCELLED on Stripe intent auth failure/retry', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');

      const idemp = await prisma.idempotencyKey.create({
        data: {
          key: 'idemp-key-create-auth-fail',
          requestHash: 'hash',
          customerId: userA.id,
          requestPath: '/api/payments/create',
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        }
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          stripePaymentIntentId: 'pi_confirm_auth_fail_123',
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.AUTHORIZED,
          idempotencyKeyId: idemp.id,
        }
      });

      const stripeRetrieveSpy = jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: 'pi_confirm_auth_fail_123',
        status: 'requires_payment_method',
        amount: 12550,
        currency: 'usd',
      } as any);

      await request(app.getHttpServer())
        .post('/api/payments/confirm')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idemp-key-confirm-auth-fail')
        .send({
          paymentId: payment.id,
        })
        .expect(402);

      stripeRetrieveSpy.mockRestore();

      const updatedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(updatedPayment!.status).toBe(PaymentStatus.CANCELLED);

      const event = await prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'payment_intent.canceled' }
      });
      expect(event).toBeDefined();
      expect(event!.previousStatus).toBe(PaymentStatus.AUTHORIZED);
      expect(event!.newStatus).toBe(PaymentStatus.CANCELLED);
    });

    it('returns early and maintains idempotency if payment is already FAILED or CANCELLED', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');

      const idemp = await prisma.idempotencyKey.create({
        data: {
          key: 'idemp-key-create-idemp-failed',
          requestHash: 'hash',
          customerId: userA.id,
          requestPath: '/api/payments/create',
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        }
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          stripePaymentIntentId: 'pi_confirm_idemp_failed_123',
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.FAILED,
          idempotencyKeyId: idemp.id,
        }
      });

      const stripeRetrieveSpy = jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: 'pi_confirm_idemp_failed_123',
        status: 'requires_payment_method',
        amount: 12550,
        currency: 'usd',
      } as any);

      const initialEventCount = await prisma.paymentEvent.count({
        where: { paymentId: payment.id }
      });

      await request(app.getHttpServer())
        .post('/api/payments/confirm')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idemp-key-confirm-idemp-failed')
        .send({
          paymentId: payment.id,
        })
        .expect(402);

      stripeRetrieveSpy.mockRestore();

      const updatedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(updatedPayment!.status).toBe(PaymentStatus.FAILED);
      expect(updatedPayment!.version).toBe(payment.version);

      const finalEventCount = await prisma.paymentEvent.count({
        where: { paymentId: payment.id }
      });
      expect(finalEventCount).toBe(initialEventCount);
    });
  });

  describe('Double-Entry Ledger Tracking (US8)', () => {
    it('verifies double-entry ledger matching: sum of DEBITs equals sum of CREDITs per transaction ID', async () => {
      // Pre-seeds a successful payment and a partial refund
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'COMPLETED');

      // Create an idempotency key for payment
      const paymentIdemp = await prisma.idempotencyKey.create({
        data: {
          key: 'key-pi_ledger_test_us8',
          requestHash: 'hash',
          customerId: userA.id,
          requestPath: '/api/payments/create',
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        }
      });

      // Create successful payment
      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          stripePaymentIntentId: 'pi_ledger_test_us8',
          amount: 50000,
          currency: 'usd',
          status: PaymentStatus.SUCCEEDED,
          idempotencyKeyId: paymentIdemp.id,
        }
      });

      // Record capture ledger entries
      const paymentLedgerService = app.get(PaymentLedgerService);
      await prisma.$transaction(async (tx) => {
        await paymentLedgerService.recordCaptureLedger(
          payment.id,
          50000,
          'usd',
          tx
        );
      });

      // Record a partial refund ledger entries
      await prisma.$transaction(async (tx) => {
        await paymentLedgerService.recordRefundLedger(
          payment.id,
          10000,
          'usd',
          tx
        );
      });

      // Fetch all ledger entries for this payment
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id }
      });

      // Group them by transactionId
      const groups = new Map<string, typeof ledgerEntries>();
      for (const entry of ledgerEntries) {
        const list = groups.get(entry.transactionId) || [];
        list.push(entry);
        groups.set(entry.transactionId, list);
      }

      // Assert that for each transactionId group:
      // - There is exactly one DEBIT and one CREDIT entry
      // - The DEBIT amount equals the CREDIT amount
      // - The currency is identical
      expect(groups.size).toBe(2);

      for (const [transactionId, entries] of groups.entries()) {
        expect(entries.length).toBe(2);

        const debit = entries.find(e => e.entryType === LedgerEntryType.DEBIT);
        const credit = entries.find(e => e.entryType === LedgerEntryType.CREDIT);

        expect(debit).toBeDefined();
        expect(credit).toBeDefined();

        expect(debit!.amount).toEqual(credit!.amount);
        expect(debit!.currency).toBe(credit!.currency);
      }
    });
  });
});
