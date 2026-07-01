import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import * as crypto from 'crypto';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

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

describe('Agent Gateway (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;

  const apiKey = 'test-agent-api-key';

  beforeAll(async () => {
    // Configure env variables for testing
    process.env.AGENT_SERVICE_API_KEY = apiKey;
    process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';
    process.env.CLAIM_TOKEN_TTL_SECONDS = '300';

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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany({});
    await prisma.booking.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.user.deleteMany({});
  });

  describe('Authentication and Security (Layer 1 & 2)', () => {
    it('should reject requests with missing X-Agent-API-Key', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .expect(401);

      expect(res.body.code).toBe('INVALID_API_KEY');
    });

    it('should reject requests with incorrect X-Agent-API-Key', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', 'wrong-key')
        .expect(401);

      expect(res.body.code).toBe('INVALID_API_KEY');
    });

    it('should reject requests with missing X-User-Claim', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .expect(401);

      expect(res.body.code).toBe('INVALID_CLAIM_TOKEN');
    });

    it('should reject requests with malformed X-User-Claim', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', 'malformedtoken')
        .expect(401);

      expect(res.body.code).toBe('INVALID_CLAIM_TOKEN');
    });

    it('should reject requests with invalid claim token signature', async () => {
      const userId = crypto.randomUUID();
      const iat = Math.floor(Date.now() / 1000);
      const invalidToken = mintClaimToken(userId, iat, 'wrong-secret');

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', invalidToken)
        .expect(401);

      expect(res.body.code).toBe('INVALID_CLAIM_TOKEN');
    });

    it('should reject requests with expired claim token', async () => {
      const userId = crypto.randomUUID();
      const expiredIat = Math.floor(Date.now() / 1000) - 360; // 6 mins ago
      const expiredToken = mintClaimToken(userId, expiredIat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', expiredToken)
        .expect(401);

      expect(res.body.code).toBe('INVALID_CLAIM_TOKEN');
    });

    it('should reject requests if user does not exist in PostgreSQL', async () => {
      const nonExistentUserId = crypto.randomUUID();
      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(nonExistentUserId, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(403);

      expect(res.body.code).toBe('USER_INACTIVE');
    });

    it('should reject requests if user is INACTIVE', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'inactive-agent@example.com',
          password: 'Password123!',
          status: 'INACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(403);

      expect(res.body.code).toBe('USER_INACTIVE');
    });
  });

  describe('User Preferences Endpoint (GET /users/preferences)', () => {
    it('should return 404 PROFILE_NOT_FOUND when user profile does not exist', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'noprofile@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(404);

      expect(res.body.code).toBe('PROFILE_NOT_FOUND');
    });

    it('should return preferences and structurally exclude PII fields', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'hasprofile@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      await prisma.travelerProfile.create({
        data: {
          userId: user.id,
          seatPreference: 'window',
          classPreference: 'business',
          preferredAirlines: ['VN', 'SQ'],
          blacklistedAirlines: [],
          dietaryNeeds: 'vegetarian',
          nationality: 'VN',
          passportNumber: 'SENSITIVE_PASSPORT_123', // PII
          passportExpiry: new Date(), // PII
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      // Verify returned fields
      expect(res.body.seatPreference).toBe('window');
      expect(res.body.classPreference).toBe('business');
      expect(res.body.preferredAirlines).toEqual(['VN', 'SQ']);
      expect(res.body.blacklistedAirlines).toEqual([]);
      expect(res.body.dietaryNeeds).toBe('vegetarian');

      // Crucial: PII exclusion checks
      expect(res.body.passportNumber).toBeUndefined();
      expect(res.body.passportExpiry).toBeUndefined();
      expect(res.body.nationality).toBeUndefined(); // nationality is also excluded as per specs
    });
  });

  describe('User Bookings Endpoint (GET /users/bookings)', () => {
    it('should return empty list if user has no bookings', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'nobookings@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/bookings')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      expect(res.body.bookings).toEqual([]);
    });

    it('should return bookings and structurally exclude PII fields', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'hasbookings@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      await prisma.booking.create({
        data: {
          userId: user.id,
          pnrCode: 'PNR_SECRET_123', // PII
          eTicketNumber: 'TKT_SECRET_123', // PII
          status: 'CONFIRMED',
          airline: 'VN',
          flightNumber: 'VN310',
          origin: 'HAN',
          destination: 'NRT',
          departureTime: new Date('2026-07-15T08:30:00Z'),
          arrivalTime: new Date('2026-07-15T15:00:00Z'),
          duration: 330,
          stops: 0,
          fareClass: 'Business',
          price: 1250.00,
          currency: 'USD',
          passengers: 1,
          baggageAllowance: '32kg checked',
          paymentReference: 'PAY_SECRET_123', // PII
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/bookings')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      expect(res.body.bookings.length).toBe(1);
      const booking = res.body.bookings[0];

      expect(booking.airline).toBe('VN');
      expect(booking.flightNumber).toBe('VN310');
      expect(booking.origin).toBe('HAN');
      expect(booking.destination).toBe('NRT');
      expect(booking.departureTime).toBe('2026-07-15T08:30:00.000Z');
      expect(booking.arrivalTime).toBe('2026-07-15T15:00:00.000Z');
      expect(booking.duration).toBe(330);
      expect(booking.stops).toBe(0);
      expect(booking.fareClass).toBe('Business');
      expect(booking.price).toBe(1250.00);
      expect(booking.currency).toBe('USD');
      expect(booking.passengers).toBe(1);
      expect(booking.baggageAllowance).toBe('32kg checked');
      expect(booking.status).toBe('CONFIRMED');

      // Crucial: PII exclusion checks
      expect(booking.pnrCode).toBeUndefined();
      expect(booking.eTicketNumber).toBeUndefined();
      expect(booking.paymentReference).toBeUndefined();
    });
  });

  describe('Flight Search Endpoint (GET /flights/search)', () => {
    let token: string;
    let user: any;

    beforeEach(async () => {
      user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'searcher@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      token = mintClaimToken(user.id, iat);
    });

    it('should reject invalid airport origin code format', async () => {
      await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=HANOI&destination=NRT&date=2026-07-15&passengers=2')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(400);
    });

    it('should reject past dates', async () => {
      await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=HAN&destination=NRT&date=2020-01-01&passengers=2')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(400);
    });

    it('should reject passenger count out of range (e.g. 10)', async () => {
      await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=HAN&destination=NRT&date=2026-07-15&passengers=10')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(400);
    });

    it('should successfully search flights and return mock data', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=HAN&destination=NRT&date=2026-07-15&passengers=2')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      expect(res.body.results.length).toBe(5);
      const firstResult = res.body.results[0];

      expect(firstResult.airline).toBe('Vietnam Airlines');
      expect(firstResult.flightNumber).toBe('VN310');
      expect(firstResult.departureAirport).toBe('HAN');
      expect(firstResult.arrivalAirport).toBe('NRT');
      expect(firstResult.departureTime).toBe('2026-07-15T08:30:00Z');
      expect(firstResult.arrivalTime).toBe('2026-07-15T15:00:00Z');
      expect(firstResult.duration).toBe(330);
      expect(firstResult.stops).toBe(0);
      expect(firstResult.price).toBe(452.00 * 2);
      expect(firstResult.currency).toBe('USD');
      expect(firstResult.fareClass).toBe('Economy');
      expect(firstResult.baggageAllowance).toBe('23kg checked + 7kg carry-on');
    });
  });

  describe('Audit Logging Verification', () => {
    it('should log audit record for every tool call gateway request', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'audithistory@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);
      const traceId = 'test-trace-id-123';
      const correlationId = 'test-correlation-id-456';

      // Call search
      await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=HAN&destination=NRT&date=2026-07-15&passengers=1')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .expect(200);

      const logs = await prisma.auditLog.findMany({
        where: { userId: user.id },
      });

      expect(logs.length).toBe(1);
      const log = logs[0];
      expect(log.action).toBe('TOOL_CALL');
      expect(log.resourceType).toBe('agent-gateway');
      expect(log.resourceId).toBe('flights/search');
      expect(log.traceId).toBe(traceId);
      expect(log.correlationId).toBe(correlationId);

      const metadata = log.metadata as any;
      expect(metadata.toolName).toBe('flights/search');
      expect(metadata.claimTokenUserId).toBe(user.id);
      expect(metadata.success).toBe(true);
      expect(metadata.parameters).toEqual({
        origin: 'HAN',
        destination: 'NRT',
        date: '2026-07-15',
        passengers: 1,
      });
      expect(metadata.durationMs).toBeDefined();
      expect(metadata.responseSize).toBeGreaterThan(0);
    });
  });
});
