"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const testing_1 = require("@nestjs/testing");
const client_1 = require("@prisma/client");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("@/app.module");
const http_exception_filter_1 = require("@/common/filters/http-exception.filter");
const stripe_service_1 = require("@/common/stripe.service");
const duffel_service_1 = require("@/duffel/duffel.service");
const payment_cron_service_1 = require("@/payment/payment-cron.service");
const schedule_1 = require("@nestjs/schedule");
const prisma_service_1 = require("@/prisma/prisma.service");
describe('Cancellation and refund recovery (E2E)', () => {
    jest.setTimeout(30_000);
    let app;
    let prisma;
    let jwtService;
    let duffelService;
    let stripeService;
    let paymentCronService;
    let owner;
    let otherUser;
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] }).compile();
        app = moduleFixture.createNestApplication({ rawBody: true });
        app.useGlobalPipes(new common_1.ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
        app.useGlobalFilters(new http_exception_filter_1.HttpExceptionFilter());
        app.setGlobalPrefix('api', { exclude: ['health'] });
        await app.init();
        // Stop all cron jobs registered with the SchedulerRegistry to avoid background scheduler races
        const schedulerRegistry = moduleFixture.get(schedule_1.SchedulerRegistry);
        schedulerRegistry.getCronJobs().forEach((job) => job.stop());
        prisma = moduleFixture.get(prisma_service_1.PrismaService);
        jwtService = moduleFixture.get(jwt_1.JwtService);
        duffelService = moduleFixture.get(duffel_service_1.DuffelService);
        stripeService = moduleFixture.get(stripe_service_1.StripeService);
        paymentCronService = moduleFixture.get(payment_cron_service_1.PaymentCronService);
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(async () => {
        const suffix = crypto.randomUUID();
        owner = await createUser(`cancellation-owner-${suffix}@example.com`);
        otherUser = await createUser(`cancellation-other-${suffix}@example.com`);
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        const userIds = [owner.id, otherUser.id];
        await prisma.ledgerEntry.deleteMany({ where: { payment: { bookingIntent: { userId: { in: userIds } } } } });
        await prisma.paymentEvent.deleteMany({ where: { payment: { bookingIntent: { userId: { in: userIds } } } } });
        await prisma.refund.deleteMany({ where: { payment: { bookingIntent: { userId: { in: userIds } } } } });
        await prisma.booking.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.payment.deleteMany({ where: { bookingIntent: { userId: { in: userIds } } } });
        await prisma.idempotencyKey.deleteMany({ where: { customerId: { in: userIds } } });
        await prisma.bookingIntent.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
    async function createUser(email) {
        const user = await prisma.user.create({ data: { email, password: 'Password123!', status: 'ACTIVE' } });
        return { id: user.id, email: user.email, token: jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '1h' }) };
    }
    async function createCancellationBooking(userId, overrides = {}) {
        const now = new Date();
        const intent = await prisma.bookingIntent.create({
            data: {
                userId,
                duffelOfferId: `off-${crypto.randomUUID()}`,
                status: 'CONFIRMED',
                originalPrice: new client_1.Prisma.Decimal('125.50'),
                confirmedPrice: new client_1.Prisma.Decimal('125.50'),
                currency: 'USD',
                pricedAt: now,
                origin: 'SGN',
                destination: 'HAN',
                departureDate: new Date('2026-12-01'),
                cabinClass: 'economy',
                adults: 1,
                children: 0,
                infants: 0,
                rawOfferSnapshot: {},
                intentExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
            },
        });
        const paymentKey = await prisma.idempotencyKey.create({
            data: {
                key: `payment-${crypto.randomUUID()}`,
                requestHash: crypto.randomUUID(),
                customerId: userId,
                requestPath: '/api/bookings/payment/confirm',
                expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            },
        });
        const payment = await prisma.payment.create({
            data: {
                bookingIntentId: intent.id,
                attemptNumber: 1,
                idempotencyKeyId: paymentKey.id,
                stripePaymentIntentId: `pi-${crypto.randomUUID()}`,
                amount: 12_550,
                currency: 'USD',
                status: client_1.PaymentStatus.SUCCEEDED,
            },
        });
        const quoteId = overrides.quoteId ?? `quote-${crypto.randomUUID()}`;
        const booking = await prisma.booking.create({
            data: {
                userId,
                bookingIntentId: intent.id,
                paymentId: payment.id,
                totalAmount: new client_1.Prisma.Decimal('125.50'),
                currency: 'USD',
                status: overrides.status ?? client_1.BookingStatus.CONFIRMED,
                departureAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
                duffelOrderId: `ord-${crypto.randomUUID()}`,
                duffelCancellationQuoteId: quoteId,
                cancellationDeadline: overrides.deadline ?? new Date(Date.now() + 60 * 60 * 1000),
                cancellationRefundable: true,
                customerRefundAmount: new client_1.Prisma.Decimal(overrides.refundAmount ?? '100.00'),
            },
        });
        return { id: booking.id, paymentId: payment.id, quoteId };
    }
    async function createScheduledRefund(booking, keyCreatedAt) {
        const refundKey = await prisma.idempotencyKey.create({
            data: {
                key: `cancellation-refund:${booking.id}`,
                requestHash: crypto.randomUUID(),
                customerId: owner.id,
                requestPath: `/api/bookings/${booking.id}/cancel`,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
        });
        const refund = await prisma.refund.create({
            data: {
                paymentId: booking.paymentId,
                idempotencyKeyId: refundKey.id,
                bookingId: booking.id,
                amount: 10_000,
                currency: 'USD',
                triggerType: 'SYSTEM_AUTOMATED',
                status: client_1.RefundStatus.REFUND_RETRY_SCHEDULED,
                nextRetryAt: new Date(Date.now() - 1_000),
                idempotencyKeyCreatedAt: keyCreatedAt,
            },
        });
        return refund.id;
    }
    it('enforces ownership and missing-booking boundaries for quote and status reads', async () => {
        const booking = await createCancellationBooking(owner.id);
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/bookings/${booking.id}/cancellation-quote`)
            .set('Authorization', `Bearer ${otherUser.token}`)
            .expect(403);
        await (0, supertest_1.default)(app.getHttpServer())
            .get(`/api/bookings/${booking.id}/cancellation`)
            .set('Authorization', `Bearer ${otherUser.token}`)
            .expect(403);
        await (0, supertest_1.default)(app.getHttpServer())
            .get(`/api/bookings/${crypto.randomUUID()}/cancellation`)
            .set('Authorization', `Bearer ${owner.token}`)
            .expect(404);
    });
    it('returns a stored valid quote without calling Duffel and rejects an expired quote before supplier work', async () => {
        const validBooking = await createCancellationBooking(owner.id);
        const quoteSpy = jest.spyOn(duffelService, 'createCancellationQuote');
        const quoteResponse = await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/bookings/${validBooking.id}/cancellation-quote`)
            .set('Authorization', `Bearer ${owner.token}`)
            .expect(201);
        expect(quoteResponse.body).toMatchObject({ bookingId: validBooking.id, quoteId: validBooking.quoteId, refundAmount: '100', refundable: true });
        expect(quoteSpy).not.toHaveBeenCalled();
        const expiredBooking = await createCancellationBooking(owner.id, { deadline: new Date(Date.now() - 1_000) });
        const confirmSpy = jest.spyOn(duffelService, 'confirmCancellationQuote');
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/bookings/${expiredBooking.id}/cancel`)
            .set('Authorization', `Bearer ${owner.token}`)
            .send({ quoteId: expiredBooking.quoteId })
            .expect(400);
        expect(confirmSpy).not.toHaveBeenCalled();
    });
    it('converges concurrent cancellation confirmations on one supplier cancellation and refund', async () => {
        const booking = await createCancellationBooking(owner.id);
        const retrieveSpy = jest.spyOn(duffelService, 'retrieveOrder').mockResolvedValue({ id: 'ord-id', order_id: 'ord-id', status: 'ACTIVE', cancelled_at: null, cancellation_id: null });
        const confirmSpy = jest.spyOn(duffelService, 'confirmCancellationQuote').mockResolvedValue({
            id: `cancel-${crypto.randomUUID()}`,
            order_id: `order-${crypto.randomUUID()}`,
            status: 'CONFIRMED',
            refund_amount: '100.00',
            refund_currency: 'USD',
            refundable: true,
            confirmed_at: new Date().toISOString(),
        });
        const stripeSpy = jest.spyOn(stripeService, 'createRefund').mockResolvedValue({ id: `re-${crypto.randomUUID()}` });
        const responses = await Promise.all([
            (0, supertest_1.default)(app.getHttpServer()).post(`/api/bookings/${booking.id}/cancel`).set('Authorization', `Bearer ${owner.token}`).send({ quoteId: booking.quoteId }),
            (0, supertest_1.default)(app.getHttpServer()).post(`/api/bookings/${booking.id}/cancel`).set('Authorization', `Bearer ${owner.token}`).send({ quoteId: booking.quoteId }),
        ]);
        expect(responses.map((response) => response.status).sort()).toEqual([201, 201]);
        for (const res of responses) {
            expect([client_1.BookingStatus.CANCELLED_PENDING_REFUND, client_1.BookingStatus.CANCELLED_AND_REFUNDED]).toContain(res.body.bookingStatus);
            expect([client_1.BookingStatus.CANCELLED_PENDING_REFUND, client_1.BookingStatus.CANCELLED_AND_REFUNDED]).toContain(res.body.cancellationStatus);
            expect(['PENDING', 'SUCCEEDED']).toContain(res.body.refundStatus);
            expect(Number(res.body.refundAmount)).toBe(100);
        }
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(retrieveSpy).toHaveBeenCalledTimes(1);
        expect(stripeSpy).toHaveBeenCalledTimes(1);
        const persisted = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id }, include: { cancellationRefund: true } });
        expect(persisted.status).toBe(client_1.BookingStatus.CANCELLED_AND_REFUNDED);
        expect(persisted.cancellationRefund?.status).toBe(client_1.RefundStatus.SUCCEEDED);
    });
    it('uses remote supplier state during recovery instead of confirming the quote again', async () => {
        const booking = await createCancellationBooking(owner.id);
        jest.spyOn(duffelService, 'retrieveOrder').mockResolvedValue({ id: 'ord-id', order_id: 'ord-id', status: 'CANCELLED', cancelled_at: new Date().toISOString(), cancellation_id: `cancel-${crypto.randomUUID()}` });
        const confirmSpy = jest.spyOn(duffelService, 'confirmCancellationQuote');
        jest.spyOn(stripeService, 'createRefund').mockResolvedValue({ id: `re-${crypto.randomUUID()}` });
        const response = await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/bookings/${booking.id}/cancel`)
            .set('Authorization', `Bearer ${owner.token}`)
            .send({ quoteId: booking.quoteId })
            .expect(201);
        expect(response.body).toMatchObject({ bookingId: booking.id, refundStatus: 'SUCCEEDED' });
        expect(confirmSpy).not.toHaveBeenCalled();
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(client_1.BookingStatus.CANCELLED_AND_REFUNDED);
    });
    it('does not start a Stripe refund when supplier cancellation cannot be confirmed', async () => {
        const booking = await createCancellationBooking(owner.id);
        jest.spyOn(duffelService, 'retrieveOrder').mockResolvedValue({ id: 'ord-id', order_id: 'ord-id', status: 'ACTIVE', cancelled_at: null, cancellation_id: null });
        jest.spyOn(duffelService, 'confirmCancellationQuote').mockRejectedValue({ statusCode: 400, code: 'QUOTE_INVALID' });
        const stripeSpy = jest.spyOn(stripeService, 'createRefund');
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/bookings/${booking.id}/cancel`)
            .set('Authorization', `Bearer ${owner.token}`)
            .send({ quoteId: booking.quoteId })
            .expect(502);
        expect(stripeSpy).not.toHaveBeenCalled();
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(client_1.BookingStatus.CANCELLATION_PENDING);
    });
    it('retries a transient Stripe failure and settles the cancellation exactly once', async () => {
        const booking = await createCancellationBooking(owner.id);
        jest.spyOn(duffelService, 'retrieveOrder').mockResolvedValue({ id: 'ord-id', order_id: 'ord-id', status: 'ACTIVE', cancelled_at: null, cancellation_id: null });
        jest.spyOn(duffelService, 'confirmCancellationQuote').mockResolvedValue({
            id: `cancel-${crypto.randomUUID()}`,
            order_id: `order-${crypto.randomUUID()}`,
            status: 'CONFIRMED',
            refund_amount: '100.00',
            refund_currency: 'USD',
            refundable: true,
            confirmed_at: new Date().toISOString(),
        });
        const stripeSpy = jest
            .spyOn(stripeService, 'createRefund')
            .mockRejectedValueOnce({ statusCode: 503, code: 'UPSTREAM_UNAVAILABLE' })
            .mockResolvedValueOnce({ id: `re-${crypto.randomUUID()}` });
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/bookings/${booking.id}/cancel`)
            .set('Authorization', `Bearer ${owner.token}`)
            .send({ quoteId: booking.quoteId })
            .expect(201);
        expect(stripeSpy).toHaveBeenCalledTimes(2);
        const [refund, persistedBooking] = await Promise.all([
            prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } }),
            prisma.booking.findUniqueOrThrow({ where: { id: booking.id } }),
        ]);
        expect(refund.status).toBe(client_1.RefundStatus.SUCCEEDED);
        expect(persistedBooking.status).toBe(client_1.BookingStatus.CANCELLED_AND_REFUNDED);
    });
    it('CAS-claims due retries once and escalates a 22-hour-old refund without another Stripe call', async () => {
        const booking = await createCancellationBooking(owner.id, { status: client_1.BookingStatus.CANCELLED_PENDING_REFUND });
        const refundId = await createScheduledRefund(booking, new Date(Date.now() - 22 * 60 * 60 * 1_000 - 1));
        const stripeSpy = jest.spyOn(stripeService, 'createRefund');
        await Promise.all([paymentCronService.handleCancellationRefundRecovery(), paymentCronService.handleCancellationRefundRecovery()]);
        expect(stripeSpy).not.toHaveBeenCalled();
        const [refund, persistedBooking] = await Promise.all([
            prisma.refund.findUniqueOrThrow({ where: { id: refundId } }),
            prisma.booking.findUniqueOrThrow({ where: { id: booking.id } }),
        ]);
        expect(refund.status).toBe(client_1.RefundStatus.REFUND_FAILED_NEEDS_ATTENTION);
        expect(refund.lastErrorCode).toBe('IDEMPOTENCY_KEY_SAFETY_WINDOW');
        expect(persistedBooking.status).toBe(client_1.BookingStatus.REFUND_FAILED_NEEDS_ATTENTION);
    });
    it('resolves disruption and writes audit log when cancellation completes successfully', async () => {
        const booking = await createCancellationBooking(owner.id);
        // Set disruption status on the booking to verify it gets resolved
        await prisma.booking.update({
            where: { id: booking.id },
            data: { disruptionStatus: 'DETECTED' }
        });
        jest.spyOn(duffelService, 'retrieveOrder').mockResolvedValue({ id: 'ord-id', order_id: 'ord-id', status: 'ACTIVE', cancelled_at: null, cancellation_id: null });
        jest.spyOn(duffelService, 'confirmCancellationQuote').mockResolvedValue({
            id: `cancel-${crypto.randomUUID()}`,
            order_id: `order-${crypto.randomUUID()}`,
            status: 'CONFIRMED',
            refund_amount: '100.00',
            refund_currency: 'USD',
            refundable: true,
            confirmed_at: new Date().toISOString(),
        });
        jest.spyOn(stripeService, 'createRefund').mockResolvedValue({ id: `re-${crypto.randomUUID()}` });
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/bookings/${booking.id}/cancel`)
            .set('Authorization', `Bearer ${owner.token}`)
            .send({ quoteId: booking.quoteId })
            .expect(201);
        const persisted = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
        expect(persisted.status).toBe(client_1.BookingStatus.CANCELLED_AND_REFUNDED);
        expect(persisted.disruptionStatus).toBe('RESOLVED');
        expect(persisted.disruptionResolvedReason).toBe('BOOKING_CANCELLED');
        expect(persisted.disruptionResolvedByType).toBe('TRAVELLER');
        expect(persisted.disruptionResolvedById).toBe(owner.id);
        const auditEvent = await prisma.disruptionAuditEvent.findFirst({
            where: { bookingId: booking.id, action: 'BOOKING_CANCELLED' },
        });
        expect(auditEvent).toBeDefined();
        expect(auditEvent?.actorType).toBe('TRAVELLER');
        expect(auditEvent?.actorId).toBe(owner.id);
    });
    it('does not allow a post-cancellation sync to modify/create revisions or change state', async () => {
        const booking = await createCancellationBooking(owner.id, { status: client_1.BookingStatus.CANCELLED_AND_REFUNDED });
        const response = await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/disruptions/sync/${booking.id}`)
            .set('Authorization', `Bearer ${owner.token}`)
            .expect(200);
        expect(response.body.status).toBe('SKIPPED_INELIGIBLE');
        const revisionsCount = await prisma.itineraryRevision.count({ where: { bookingId: booking.id } });
        expect(revisionsCount).toBe(0);
    });
});
