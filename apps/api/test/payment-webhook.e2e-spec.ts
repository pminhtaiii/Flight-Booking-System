process.env.ENCRYPTION_KEY = 'a'.repeat(64);

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Logger } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentWebhookService } from '@/payment/payment-webhook.service';
import { PaymentStatus, PassengerType, Prisma, RefundStatus, RefundTriggerType } from '@prisma/client';
import { LedgerEntryType } from '@shared/types';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

describe('Payment Webhook (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let stripeService: StripeService;
  let webhookService: PaymentWebhookService;

  let userA: { id: string; email: string };
  let stripeWebhookSecretOriginal: string | undefined;

  beforeAll(async () => {
    stripeWebhookSecretOriginal = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
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
    stripeService = moduleFixture.get<StripeService>(StripeService);
    webhookService = moduleFixture.get<PaymentWebhookService>(PaymentWebhookService);
  });

  afterAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = stripeWebhookSecretOriginal;
    await app.close();
  });

  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    await prisma.bookingIntentPassenger.deleteMany({});
    await prisma.bookingIntent.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.user.deleteMany({});

    // Create test user
    const uA = await prisma.user.create({
      data: {
        email: 'usera@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    userA = { id: uA.id, email: uA.email };
  });

  async function createMockFlightOffer() {
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

  async function createMockPayment(
    bookingIntentId: string,
    status: PaymentStatus,
    stripePaymentIntentId: string,
    preDisputeStatus?: PaymentStatus
  ) {
    const idemp = await prisma.idempotencyKey.create({
      data: {
        key: `key-${stripePaymentIntentId}`,
        requestHash: 'hash',
        customerId: userA.id,
        requestPath: '/api/payments/create',
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      }
    });

    return prisma.payment.create({
      data: {
        bookingIntentId,
        attemptNumber: 1,
        stripePaymentIntentId,
        amount: 12550,
        currency: 'usd',
        status,
        preDisputeStatus,
        idempotencyKeyId: idemp.id,
      }
    });
  }

  describe('POST /api/payments/webhook', () => {
    it('payment_intent.succeeded event on an AUTHORIZED payment (happy path) -> transition to SUCCEEDED and returns 200', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');
      const payment = await createMockPayment(intent.id, PaymentStatus.AUTHORIZED, 'pi_happy_123');

      // Mock stripe signature verification
      const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
        id: 'evt_happy_123',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_happy_123',
            amount: 12550,
            currency: 'usd',
            status: 'succeeded',
          }
        }
      } as any);

      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 't=123,v1=sig')
        .send({ dummy: 'payload' })
        .expect(200);

      expect(constructSpy).toHaveBeenCalled();
      constructSpy.mockRestore();

      // Check DB payment status
      const updatedPayment = await prisma.payment.findUnique({
        where: { id: payment.id }
      });
      expect(updatedPayment!.status).toBe(PaymentStatus.SUCCEEDED);

      // Check booking intent status
      const updatedIntent = await prisma.bookingIntent.findUnique({
        where: { id: intent.id }
      });
      expect(updatedIntent!.status).toBe('COMPLETED');

      // Check ledger entries recorded
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id }
      });
      expect(ledgerEntries.length).toBe(2);
      const debit = ledgerEntries.find(e => e.entryType === LedgerEntryType.DEBIT);
      const credit = ledgerEntries.find(e => e.entryType === LedgerEntryType.CREDIT);
      expect(debit!.accountId).toBe('CUSTOMER_RECEIVABLE');
      expect(debit!.amount).toBe(12550);
      expect(credit!.accountId).toBe('PLATFORM_REVENUE');
      expect(credit!.amount).toBe(12550);

      // Check payment event recorded
      const events = await prisma.paymentEvent.findMany({
        where: { paymentId: payment.id }
      });
      expect(events.some(e => e.eventType === 'payment_intent.succeeded')).toBe(true);
      const succEvent = events.find(e => e.eventType === 'payment_intent.succeeded');
      expect(succEvent!.stripeEventId).toBe('evt_happy_123');
    });

    it('Duplicate webhook (same stripeEventId already processed) -> returns 200 and skips processing', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');
      const payment = await createMockPayment(intent.id, PaymentStatus.AUTHORIZED, 'pi_duplicate_123');

      // Insert pre-existing event to simulate processed webhook
      await prisma.paymentEvent.create({
        data: {
          paymentId: payment.id,
          stripeEventId: 'evt_duplicate_123',
          eventType: 'payment_intent.succeeded',
          previousStatus: PaymentStatus.AUTHORIZED,
          newStatus: PaymentStatus.SUCCEEDED,
          amount: 12550,
          source: 'WEBHOOK',
          createdBy: 'SYSTEM',
        }
      });

      const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
        id: 'evt_duplicate_123',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_duplicate_123',
            amount: 12550,
            currency: 'usd',
            status: 'succeeded',
          }
        }
      } as any);

      // Spy on prisma update or verify payment state does not change
      const prismaUpdateSpy = jest.spyOn(prisma.payment, 'update');

      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 't=123,v1=sig')
        .send({ dummy: 'payload' })
        .expect(200);

      expect(prismaUpdateSpy).not.toHaveBeenCalled();
      prismaUpdateSpy.mockRestore();
      constructSpy.mockRestore();
    });

    it('Out-of-order webhook (received payment_intent.succeeded when status is CREATED) -> triggers Tier 1 self-healing and returns 200', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');
      const payment = await createMockPayment(intent.id, PaymentStatus.CREATED, 'pi_outoforder_123');

      const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
        id: 'evt_outoforder_123',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_outoforder_123',
            amount: 12550,
            currency: 'usd',
            status: 'succeeded',
          }
        }
      } as any);

      // Stripe SDK retrieve spy
      const retrieveSpy = jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: 'pi_outoforder_123',
        amount: 12550,
        currency: 'usd',
        status: 'succeeded',
      } as any);

      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 't=123,v1=sig')
        .send({ dummy: 'payload' })
        .expect(200);

      expect(retrieveSpy).toHaveBeenCalledWith('pi_outoforder_123');
      constructSpy.mockRestore();
      retrieveSpy.mockRestore();

      // Verified state was fast-forwarded
      const updatedPayment = await prisma.payment.findUnique({
        where: { id: payment.id }
      });
      expect(updatedPayment!.status).toBe(PaymentStatus.SUCCEEDED);

      const updatedIntent = await prisma.bookingIntent.findUnique({
        where: { id: intent.id }
      });
      expect(updatedIntent!.status).toBe('COMPLETED');
    });

    it('Irreconcilable webhook (received payment_intent.succeeded when status is REFUNDED/FAILED/CANCELLED) -> triggers Tier 2 drop + alert', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');
      const payment = await createMockPayment(intent.id, PaymentStatus.CANCELLED, 'pi_irreconcilable_123');

      const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
        id: 'evt_irreconcilable_123',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_irreconcilable_123',
            amount: 12550,
            currency: 'usd',
            status: 'succeeded',
          }
        }
      } as any);

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 't=123,v1=sig')
        .send({ dummy: 'payload' })
        .expect(200);

      constructSpy.mockRestore();

      // Check payment status did NOT change
      const updatedPayment = await prisma.payment.findUnique({
        where: { id: payment.id }
      });
      expect(updatedPayment!.status).toBe(PaymentStatus.CANCELLED);

      // Verify that structured alert containing "[ALERT]" was logged to console
      const warningLogs = consoleWarnSpy.mock.calls.map(c => c.join(' '));
      const errorLogs = consoleErrorSpy.mock.calls.map(c => c.join(' '));
      const allLogs = [...warningLogs, ...errorLogs];
      expect(allLogs.some(log => log.includes('[ALERT]'))).toBe(true);

      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('payment_intent.payment_failed webhook -> transitions state to FAILED and BookingIntent to PAYMENT_EXHAUSTED or AWAITING_PAYMENT', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');
      // Set paymentAttemptCount to 1, meaning next fail can transition to AWAITING_PAYMENT, or 2 to PAYMENT_EXHAUSTED
      const payment = await createMockPayment(intent.id, PaymentStatus.CREATED, 'pi_failed_123');

      const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
        id: 'evt_failed_123',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_failed_123',
            amount: 12550,
            currency: 'usd',
            status: 'requires_payment_method',
          }
        }
      } as any);

      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 't=123,v1=sig')
        .send({ dummy: 'payload' })
        .expect(200);

      constructSpy.mockRestore();

      const updatedPayment = await prisma.payment.findUnique({
        where: { id: payment.id }
      });
      expect(updatedPayment!.status).toBe(PaymentStatus.FAILED);

      const updatedIntent = await prisma.bookingIntent.findUnique({
        where: { id: intent.id }
      });
      // paymentAttemptCount = 1, so booking intent status should be AWAITING_PAYMENT
      expect(updatedIntent!.status).toBe('AWAITING_PAYMENT');
    });

    it('payment_intent.canceled webhook -> transitions state to CANCELLED and returns 200', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');
      const payment = await createMockPayment(intent.id, PaymentStatus.CREATED, 'pi_cancelled_123');

      const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
        id: 'evt_cancelled_123',
        type: 'payment_intent.canceled',
        data: {
          object: {
            id: 'pi_cancelled_123',
            amount: 12550,
            currency: 'usd',
            status: 'canceled',
          }
        }
      } as any);

      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 't=123,v1=sig')
        .send({ dummy: 'payload' })
        .expect(200);

      constructSpy.mockRestore();

      const updatedPayment = await prisma.payment.findUnique({
        where: { id: payment.id }
      });
      expect(updatedPayment!.status).toBe(PaymentStatus.CANCELLED);
    });

    describe('Dispute Handling (User Story 6)', () => {
      it('charge.dispute.created on a SUCCEEDED payment -> transitions status to DISPUTED and sets preDisputeStatus to SUCCEEDED', async () => {
        const offer = await createMockFlightOffer();
        const intent = await createMockBookingIntent(offer.id, 'COMPLETED');
        const payment = await createMockPayment(intent.id, PaymentStatus.SUCCEEDED, 'pi_dispute_1');

        const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
          id: 'evt_dispute_created_1',
          type: 'charge.dispute.created',
          data: {
            object: {
              id: 'dp_1',
              payment_intent: 'pi_dispute_1',
              status: 'needs_response',
            }
          }
        } as any);

        await request(app.getHttpServer())
          .post('/api/payments/webhook')
          .set('stripe-signature', 't=123,v1=sig')
          .send({ dummy: 'payload' })
          .expect(200);

        constructSpy.mockRestore();

        const updatedPayment = await prisma.payment.findUnique({
          where: { id: payment.id }
        });
        expect(updatedPayment!.status).toBe(PaymentStatus.DISPUTED);
        expect(updatedPayment!.preDisputeStatus).toBe(PaymentStatus.SUCCEEDED);

        const events = await prisma.paymentEvent.findMany({
          where: { paymentId: payment.id }
        });
        expect(events.some(e => e.eventType === 'charge.dispute.created')).toBe(true);
      });

      it('charge.dispute.created on an invalid state (e.g. CREATED) -> logs warning with ALERT and drops without state change', async () => {
        const offer = await createMockFlightOffer();
        const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');
        const payment = await createMockPayment(intent.id, PaymentStatus.CREATED, 'pi_dispute_2');

        const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
          id: 'evt_dispute_created_2',
          type: 'charge.dispute.created',
          data: {
            object: {
              id: 'dp_2',
              payment_intent: 'pi_dispute_2',
              status: 'needs_response',
            }
          }
        } as any);

        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await request(app.getHttpServer())
          .post('/api/payments/webhook')
          .set('stripe-signature', 't=123,v1=sig')
          .send({ dummy: 'payload' })
          .expect(200);

        constructSpy.mockRestore();

        const updatedPayment = await prisma.payment.findUnique({
          where: { id: payment.id }
        });
        // State should not change
        expect(updatedPayment!.status).toBe(PaymentStatus.CREATED);

        // Warning log should contain "[ALERT]"
        const warningLogs = consoleWarnSpy.mock.calls.map(c => c.join(' '));
        expect(warningLogs.some(log => log.includes('[ALERT]'))).toBe(true);

        consoleWarnSpy.mockRestore();
      });

      it('charge.dispute.closed with outcome won on DISPUTED payment -> restores preDisputeStatus', async () => {
        const offer = await createMockFlightOffer();
        const intent = await createMockBookingIntent(offer.id, 'COMPLETED');
        const payment = await createMockPayment(intent.id, PaymentStatus.DISPUTED, 'pi_dispute_3', PaymentStatus.SUCCEEDED);

        const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
          id: 'evt_dispute_closed_1',
          type: 'charge.dispute.closed',
          data: {
            object: {
              id: 'dp_3',
              payment_intent: 'pi_dispute_3',
              status: 'won',
            }
          }
        } as any);

        await request(app.getHttpServer())
          .post('/api/payments/webhook')
          .set('stripe-signature', 't=123,v1=sig')
          .send({ dummy: 'payload' })
          .expect(200);

        constructSpy.mockRestore();

        const updatedPayment = await prisma.payment.findUnique({
          where: { id: payment.id }
        });
        expect(updatedPayment!.status).toBe(PaymentStatus.SUCCEEDED);

        const events = await prisma.paymentEvent.findMany({
          where: { paymentId: payment.id }
        });
        expect(events.some(e => e.eventType === 'charge.dispute.closed')).toBe(true);
      });

      it('charge.dispute.closed with outcome lost on DISPUTED payment -> transitions status to CHARGEBACK_LOST and logs warning with ALERT', async () => {
        const offer = await createMockFlightOffer();
        const intent = await createMockBookingIntent(offer.id, 'COMPLETED');
        const payment = await createMockPayment(intent.id, PaymentStatus.DISPUTED, 'pi_dispute_4', PaymentStatus.SUCCEEDED);

        const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
          id: 'evt_dispute_closed_2',
          type: 'charge.dispute.closed',
          data: {
            object: {
              id: 'dp_4',
              payment_intent: 'pi_dispute_4',
              status: 'lost',
            }
          }
        } as any);

        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await request(app.getHttpServer())
          .post('/api/payments/webhook')
          .set('stripe-signature', 't=123,v1=sig')
          .send({ dummy: 'payload' })
          .expect(200);

        constructSpy.mockRestore();

        const updatedPayment = await prisma.payment.findUnique({
          where: { id: payment.id }
        });
        expect(updatedPayment!.status).toBe(PaymentStatus.CHARGEBACK_LOST);

        // Warning log should contain "[ALERT]"
        const warningLogs = consoleWarnSpy.mock.calls.map(c => c.join(' '));
        expect(warningLogs.some(log => log.includes('[ALERT]'))).toBe(true);

        consoleWarnSpy.mockRestore();
      });

      it('charge.refunded event for a Stripe-initiated/unlinked refund -> creates Refund record in SUCCEEDED status, transitions payment, and records ledgers', async () => {
        const offer = await createMockFlightOffer();
        const intent = await createMockBookingIntent(offer.id, 'COMPLETED');
        const payment = await createMockPayment(intent.id, PaymentStatus.SUCCEEDED, 'pi_refund_unlinked');

        const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
          id: 'evt_unlinked_refund',
          type: 'charge.refunded',
          data: {
            object: {
              id: 'ch_unlinked_refund',
              payment_intent: 'pi_refund_unlinked',
              amount_refunded: 12550,
              refunds: {
                data: [
                  {
                    id: 're_unlinked_123',
                    amount: 12550,
                    status: 'succeeded',
                  }
                ]
              }
            }
          }
        } as any);

        await request(app.getHttpServer())
          .post('/api/payments/webhook')
          .set('stripe-signature', 't=123,v1=sig')
          .send({ dummy: 'payload' })
          .expect(200);

        constructSpy.mockRestore();

        const localRefund = await prisma.refund.findUnique({
          where: { stripeRefundId: 're_unlinked_123' }
        });
        expect(localRefund).toBeDefined();
        expect(localRefund!.status).toBe(RefundStatus.SUCCEEDED);
        expect(localRefund!.amount).toBe(12550);

        const updatedPayment = await prisma.payment.findUnique({
          where: { id: payment.id }
        });
        expect(updatedPayment!.status).toBe(PaymentStatus.REFUNDED);

        const ledgerEntries = await prisma.ledgerEntry.findMany({
          where: { paymentId: payment.id }
        });
        const refundDebits = ledgerEntries.filter(
          e => e.accountId === 'PLATFORM_REVENUE' && e.entryType === LedgerEntryType.DEBIT
        );
        const refundCredits = ledgerEntries.filter(
          e => e.accountId === 'CUSTOMER_RECEIVABLE' && e.entryType === LedgerEntryType.CREDIT
        );

        expect(refundDebits.length).toBe(1);
        expect(refundDebits[0].amount).toBe(12550);
        expect(refundCredits.length).toBe(1);
        expect(refundCredits[0].amount).toBe(12550);
      });

      it('charge.refunded event for a linked refund -> handles transition from SUCCEEDED to REFUNDED through REFUND_PENDING intermediate transition', async () => {
        const offer = await createMockFlightOffer();
        const intent = await createMockBookingIntent(offer.id, 'COMPLETED');
        const payment = await createMockPayment(intent.id, PaymentStatus.SUCCEEDED, 'pi_linked_refund_race');

        // Create an existing local refund record in REFUND_PENDING status
        await prisma.refund.create({
          data: {
            paymentId: payment.id,
            amount: 12550,
            currency: payment.currency,
            reason: 'requested_by_customer',
            triggerType: RefundTriggerType.ADMIN,
            status: RefundStatus.REFUND_PENDING,
            stripeRefundId: 're_linked_123',
            idempotencyKeyId: payment.idempotencyKeyId,
          },
        });

        const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
          id: 'evt_linked_refund',
          type: 'charge.refunded',
          data: {
            object: {
              id: 'ch_linked_refund',
              payment_intent: 'pi_linked_refund_race',
              amount_refunded: 12550,
              refunds: {
                data: [
                  {
                    id: 're_linked_123',
                    amount: 12550,
                    status: 'succeeded',
                  }
                ]
              }
            }
          }
        } as any);

        await request(app.getHttpServer())
          .post('/api/payments/webhook')
          .set('stripe-signature', 't=123,v1=sig')
          .send({ dummy: 'payload' })
          .expect(200);

        constructSpy.mockRestore();

        // Check local refund status is updated to SUCCEEDED
        const localRefund = await prisma.refund.findUnique({
          where: { stripeRefundId: 're_linked_123' }
        });
        expect(localRefund).toBeDefined();
        expect(localRefund!.status).toBe(RefundStatus.SUCCEEDED);

        // Check payment status transitioned to REFUNDED
        const updatedPayment = await prisma.payment.findUnique({
          where: { id: payment.id }
        });
        expect(updatedPayment!.status).toBe(PaymentStatus.REFUNDED);
      });
    });

    it('should return HTTP 500 and log structured [ALERT] alert if webhook service throws an exception', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createMockBookingIntent(offer.id, 'AWAITING_PAYMENT');
      await createMockPayment(intent.id, PaymentStatus.AUTHORIZED, 'pi_fail_service_123');

      // Mock stripe signature verification
      const constructSpy = jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({
        id: 'evt_fail_service_123',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_fail_service_123',
            amount: 12550,
            currency: 'usd',
            status: 'succeeded',
          }
        }
      } as any);

      // Mock handleWebhookEvent to throw an exception
      const handleWebhookEventSpy = jest
        .spyOn(webhookService, 'handleWebhookEvent')
        .mockRejectedValue(new Error('Database connection lost'));

      // Spy on NestJS Logger
      const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 't=123,v1=sig')
        .send({ dummy: 'payload' })
        .expect(500);

      expect(loggerErrorSpy).toHaveBeenCalled();
      const hasAlert = loggerErrorSpy.mock.calls.some(call =>
        call.some(arg => typeof arg === 'string' && arg.includes('[ALERT]'))
      );
      expect(hasAlert).toBe(true);

      constructSpy.mockRestore();
      handleWebhookEventSpy.mockRestore();
      loggerErrorSpy.mockRestore();
    });
  });
});
