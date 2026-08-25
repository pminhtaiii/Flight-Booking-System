import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import * as crypto from 'crypto';

const apiKey = process.env.AGENT_SERVICE_API_KEY || 'mock_agent_key';
const claimSecret = process.env.CLAIM_TOKEN_SECRET || 'mock_claim_secret';

function mintClaimToken(userId: string, iat: number, secret = claimSecret): string {
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

const chatEncryptionKey = crypto.randomBytes(32).toString('hex');

process.env.AGENT_SERVICE_API_KEY = apiKey;
process.env.CLAIM_TOKEN_SECRET = claimSecret;
process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
process.env.CHAT_ENCRYPTION_KEY = chatEncryptionKey;
// We start with write fence disabled to prevent breaking legacy tests
process.env.FEATURE_FLAG_WRITE_FENCE = 'false';

describe('Agent Chat Gateway (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let cacheService: CacheService;
  let jwtService: JwtService;

  beforeAll(async () => {
    process.env.AGENT_SERVICE_API_KEY = apiKey;
    process.env.CLAIM_TOKEN_SECRET = claimSecret;
    process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
    process.env.CHAT_ENCRYPTION_KEY = chatEncryptionKey;

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
    delete process.env.FEATURE_FLAG_WRITE_FENCE;
    await app.close();
  });

  beforeEach(async () => {
    process.env.AGENT_SERVICE_API_KEY = apiKey;
    process.env.CLAIM_TOKEN_SECRET = claimSecret;
    process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
    process.env.CHAT_ENCRYPTION_KEY = chatEncryptionKey;

    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
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
    await prisma.chatMessage.deleteMany({});
    await prisma.user.deleteMany({});
  });

  describe('Agent Gateway Authentication & Access Check', () => {
    it('should reject requests with missing or invalid service API key', async () => {
      await request(app.getHttpServer())
        .post('/agent-gateway/chat/access/check')
        .send({ sub: 'user-1' })
        .expect(401);

      await request(app.getHttpServer())
        .post('/agent-gateway/chat/access/check')
        .set('X-Agent-API-Key', 'wrong-key')
        .send({ sub: 'user-1' })
        .expect(401);
    });

    it('should check active user access correctly', async () => {
      const user = await prisma.user.create({
        data: {
          email: 'active-user@example.com',
          password: 'password',
          status: 'ACTIVE',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/agent-gateway/chat/access/check')
        .set('X-Agent-API-Key', apiKey)
        .send({ sub: user.id })
        .expect(200);

      expect(res.body).toEqual({ allowed: true });
    });

    it('should reject inactive users', async () => {
      const user = await prisma.user.create({
        data: {
          email: 'inactive-user@example.com',
          password: 'password',
          status: 'INACTIVE',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/agent-gateway/chat/access/check')
        .set('X-Agent-API-Key', apiKey)
        .send({ sub: user.id })
        .expect(401);

      expect(res.body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Session Ownership & Cross-User Isolation', () => {
    it('should reject message creation for session owned by another user with 404 CHAT_SESSION_NOT_FOUND', async () => {
      const userA = await prisma.user.create({
        data: { email: 'userA@example.com', password: 'password', status: 'ACTIVE' },
      });
      const userB = await prisma.user.create({
        data: { email: 'userB@example.com', password: 'password', status: 'ACTIVE' },
      });

      const sessionA = await prisma.chatSession.create({
        data: { userId: userA.id },
      });

      const claimTokenB = mintClaimToken(userB.id, Math.floor(Date.now() / 1000));

      const res = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${sessionA.id}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenB)
        .send({ messages: [{ sender: 'USER', content: 'Hello' }] })
        .expect(404);

      expect(res.body.code).toBe('CHAT_SESSION_NOT_FOUND');
    });
  });

  describe('Fenced Session Write Controls (FEATURE_FLAG_WRITE_FENCE)', () => {
    beforeAll(() => {
      process.env.FEATURE_FLAG_WRITE_FENCE = 'true';
    });

    afterAll(() => {
      process.env.FEATURE_FLAG_WRITE_FENCE = 'false';
    });

    it('should reject request when X-Fencing-Token is missing and write fence is enabled', async () => {
      const user = await prisma.user.create({
        data: { email: 'fence-user@example.com', password: 'password', status: 'ACTIVE' },
      });

      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));

      const res = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ messages: [{ sender: 'AGENT', content: 'Response content' }] })
        .expect(400);

      expect(res.body.code).toBe('MISSING_FENCING_TOKEN');
    });

    it('should reject request when X-Fencing-Token is stale or mismatched', async () => {
      const user = await prisma.user.create({
        data: { email: 'fence-user2@example.com', password: 'password', status: 'ACTIVE' },
      });

      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));

      // Set active fence in Redis to 5
      const lockKey = `chat:session-lock:${user.id}:${session.id}`;
      await cacheService.hset(lockKey, 'fence', '5');

      // Send request with stale fence 4
      const res = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .set('X-Fencing-Token', '4')
        .send({ messages: [{ sender: 'AGENT', content: 'Stale response' }] })
        .expect(409);

      expect(res.body.code).toBe('STALE_FENCING_TOKEN');
    });

    it('should allow message persistence when X-Fencing-Token matches active Redis fence', async () => {
      const user = await prisma.user.create({
        data: { email: 'fence-user3@example.com', password: 'password', status: 'ACTIVE' },
      });

      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));

      // Set active fence in Redis to 10
      const lockKey = `chat:session-lock:${user.id}:${session.id}`;
      await cacheService.hset(lockKey, 'fence', '10');

      const res = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .set('X-Fencing-Token', '10')
        .send({ messages: [{ sender: 'AGENT', content: 'Valid fenced turn content' }] })
        .expect(201);

      expect(res.body.messages[0].content).toBe('Valid fenced turn content');
    });
  });

  describe('Encrypted Persistence, Browser Injection Protection & Soft-Delete (WP 3D / Phase 8E)', () => {
    it('should store encrypted fields for turns and session title exclusively', async () => {
      const user = await prisma.user.create({
        data: { email: 'crypto-user@example.com', password: 'password', status: 'ACTIVE' },
      });

      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));

      const createSessRes = await request(app.getHttpServer())
        .post('/agent-gateway/chat/sessions')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ title: 'Encrypted Flight Search' })
        .expect(201);

      const sessionId = createSessRes.body.id;
      expect(sessionId).toBeDefined();
      expect(createSessRes.body.title).toBe('Encrypted Flight Search');

      const sessionDb = await prisma.chatSession.findUnique({ where: { id: sessionId } });
      expect(sessionDb!.titleCiphertext).not.toBeNull();
      expect(sessionDb!.titleNonce).not.toBeNull();
      expect(sessionDb!.titleAuthTag).not.toBeNull();

      const turnRes = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${sessionId}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ messages: [{ sender: 'USER', content: 'Find me flights to Tokyo' }] })
        .expect(201);

      expect(turnRes.body.messages[0].content).toBe('Find me flights to Tokyo');

      const messageDb = await prisma.chatMessage.findUnique({ where: { id: turnRes.body.messages[0].id } });
      expect(messageDb!.contentCiphertext).not.toBeNull();
      expect(messageDb!.contentNonce).not.toBeNull();
      expect(messageDb!.contentAuthTag).not.toBeNull();
    });

    it('should force browser writes to USER and STANDARD role/type, rejecting forged AGENT/SUMMARY', async () => {
      const user = await prisma.user.create({
        data: { email: 'browser-forge@example.com', password: 'password', status: 'ACTIVE' },
      });

      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const userToken = jwtService.sign({ id: user.id, email: user.email });

      const res = await request(app.getHttpServer())
        .post(`/chat/sessions/${session.id}/messages`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ sender: 'AGENT', type: 'SUMMARY', content: 'Attempted injected summary' })
        .expect(201);

      expect(res.body.sender).toBe('USER');
      expect(res.body.type).toBe('STANDARD');

      const messageDb = await prisma.chatMessage.findUnique({ where: { id: res.body.id } });
      expect(messageDb!.sender).toBe('USER');
      expect(messageDb!.type).toBe('STANDARD');
    });

    it('should support soft-delete of chat session and exclude soft-deleted sessions from queries', async () => {
      const user = await prisma.user.create({
        data: { email: 'softdelete-user@example.com', password: 'password', status: 'ACTIVE' },
      });

      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));

      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const deleteRes = await request(app.getHttpServer())
        .delete(`/agent-gateway/chat/sessions/${session.id}`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .expect(204);

      const dbSession = await prisma.chatSession.findUnique({ where: { id: session.id } });
      expect(dbSession!.deletedAt).not.toBeNull();

      // Memory fetch for soft-deleted session should return 404
      await request(app.getHttpServer())
        .get(`/agent-gateway/chat/sessions/${session.id}/memory`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .expect(404);
    });

    it('should parse recentCount before querying session memory', async () => {
      const user = await prisma.user.create({
        data: { email: 'memory-query-user@example.com', password: 'password', status: 'ACTIVE' },
      });
      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const response = await request(app.getHttpServer())
        .get(`/agent-gateway/chat/sessions/${session.id}/memory?recentCount=1`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .expect(200);

      expect(response.body.recentMessages).toEqual([]);
    });
  });
});

