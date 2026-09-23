import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { JwtService } from '@nestjs/jwt';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { AgentChatController } from '@/chat/agent-chat.controller';
import { AgentApiKeyGuard } from '@/agent-gateway/auth/agent-api-key.guard';
import { ClaimTokenGuard } from '@/agent-gateway/auth/claim-token.guard';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import * as crypto from 'crypto';

const apiKey = process.env.AGENT_SERVICE_API_KEY || 'mock_agent_key';
const claimSecret = process.env.CLAIM_TOKEN_SECRET || 'mock_claim_secret';

function mintClaimToken(userId: string, iat: number, secret = claimSecret): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);

  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();

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
    await prisma.chatMessage.deleteMany({});
    await prisma.user.deleteMany({});
  });

  describe('Controller Guards & Metadata (Reflection)', () => {
    it('should declare controller-level guards strictly in order: AgentApiKeyGuard followed by ClaimTokenGuard', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, AgentChatController) ?? [];
      expect(guards).toEqual([AgentApiKeyGuard, ClaimTokenGuard]);
    });
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

    it('should deliberately bypass ClaimTokenGuard for /access/check without X-User-Claim header', async () => {
      const user = await prisma.user.create({
        data: {
          email: 'bypass-check-user@example.com',
          password: 'password',
          status: 'ACTIVE',
        },
      });

      // Deliberately no X-User-Claim header provided
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

  describe('ClaimTokenGuard Enforcement across Session Routes', () => {
    it('should strictly reject missing X-User-Claim with 401 INVALID_CLAIM_TOKEN on all 6 session routes', async () => {
      const user = await prisma.user.create({
        data: { email: 'claim-enforcement@example.com', password: 'password', status: 'ACTIVE' },
      });
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      // 1. POST /agent-gateway/chat/sessions
      const resSessions = await request(app.getHttpServer())
        .post('/agent-gateway/chat/sessions')
        .set('X-Agent-API-Key', apiKey)
        .send({ title: 'New Session' })
        .expect(401);
      expect(resSessions.body.code).toBe('INVALID_CLAIM_TOKEN');

      // 2. GET /agent-gateway/chat/sessions/:sessionId/memory
      const resMemory = await request(app.getHttpServer())
        .get(`/agent-gateway/chat/sessions/${session.id}/memory`)
        .set('X-Agent-API-Key', apiKey)
        .expect(401);
      expect(resMemory.body.code).toBe('INVALID_CLAIM_TOKEN');

      // 3. POST /agent-gateway/chat/sessions/:sessionId/messages
      const resMessages = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/messages`)
        .set('X-Agent-API-Key', apiKey)
        .send({ sender: 'USER', content: 'Hello' })
        .expect(401);
      expect(resMessages.body.code).toBe('INVALID_CLAIM_TOKEN');

      // 4. POST /agent-gateway/chat/sessions/:sessionId/turns
      const resTurns = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .send({ messages: [{ sender: 'USER', content: 'Hello' }] })
        .expect(401);
      expect(resTurns.body.code).toBe('INVALID_CLAIM_TOKEN');

      // 5. POST /agent-gateway/chat/sessions/:sessionId/summaries
      const resSummaries = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/summaries`)
        .set('X-Agent-API-Key', apiKey)
        .send({ content: 'Summary' })
        .expect(401);
      expect(resSummaries.body.code).toBe('INVALID_CLAIM_TOKEN');

      // 6. DELETE /agent-gateway/chat/sessions/:sessionId
      const resDelete = await request(app.getHttpServer())
        .delete(`/agent-gateway/chat/sessions/${session.id}`)
        .set('X-Agent-API-Key', apiKey)
        .expect(401);
      expect(resDelete.body.code).toBe('INVALID_CLAIM_TOKEN');
    });
  });

  describe('Session Ownership & Cross-User Isolation (404 and CHAT_SESSION_NOT_FOUND mapping)', () => {
    it('should reject operations on session owned by another user with 404 (CHAT_SESSION_NOT_FOUND for writes)', async () => {
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

      // POST turns
      const resTurns = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${sessionA.id}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenB)
        .send({ messages: [{ sender: 'USER', content: 'Hello' }] })
        .expect(404);
      expect(resTurns.body.code).toBe('CHAT_SESSION_NOT_FOUND');

      // POST messages
      const resMessages = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${sessionA.id}/messages`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenB)
        .send({ sender: 'USER', content: 'Hello' })
        .expect(404);
      expect(resMessages.body.code).toBe('CHAT_SESSION_NOT_FOUND');

      // POST summaries
      const resSummaries = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${sessionA.id}/summaries`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenB)
        .send({ content: 'Summary' })
        .expect(404);
      expect(resSummaries.body.code).toBe('CHAT_SESSION_NOT_FOUND');

      // GET memory
      await request(app.getHttpServer())
        .get(`/agent-gateway/chat/sessions/${sessionA.id}/memory`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenB)
        .expect(404);

      // DELETE session
      await request(app.getHttpServer())
        .delete(`/agent-gateway/chat/sessions/${sessionA.id}`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenB)
        .expect(404);
    });

    it('should reject operations on nonexistent session with 404 (CHAT_SESSION_NOT_FOUND for writes)', async () => {
      const user = await prisma.user.create({
        data: { email: 'nonexistent-test-user@example.com', password: 'password', status: 'ACTIVE' },
      });
      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));
      const nonexistentId = crypto.randomUUID();

      // POST turns
      const resTurns = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${nonexistentId}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ messages: [{ sender: 'USER', content: 'Hello' }] })
        .expect(404);
      expect(resTurns.body.code).toBe('CHAT_SESSION_NOT_FOUND');

      // POST messages
      const resMessages = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${nonexistentId}/messages`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ sender: 'USER', content: 'Hello' })
        .expect(404);
      expect(resMessages.body.code).toBe('CHAT_SESSION_NOT_FOUND');

      // POST summaries
      const resSummaries = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${nonexistentId}/summaries`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ content: 'Summary' })
        .expect(404);
      expect(resSummaries.body.code).toBe('CHAT_SESSION_NOT_FOUND');

      // GET memory
      await request(app.getHttpServer())
        .get(`/agent-gateway/chat/sessions/${nonexistentId}/memory`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .expect(404);

      // DELETE session
      await request(app.getHttpServer())
        .delete(`/agent-gateway/chat/sessions/${nonexistentId}`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .expect(404);
    });
  });

  describe('Fenced Session Write Controls (FEATURE_FLAG_WRITE_FENCE)', () => {
    beforeAll(() => {
      process.env.FEATURE_FLAG_WRITE_FENCE = 'true';
    });

    afterAll(() => {
      process.env.FEATURE_FLAG_WRITE_FENCE = 'false';
    });

    it('should reject request when fencing token is missing and write fence is enabled', async () => {
      const user = await prisma.user.create({
        data: { email: 'fence-user@example.com', password: 'password', status: 'ACTIVE' },
      });

      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));

      // POST turns
      const resTurns = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ messages: [{ sender: 'AGENT', content: 'Response content' }] })
        .expect(400);
      expect(resTurns.body.code).toBe('MISSING_FENCING_TOKEN');

      // POST messages
      const resMessages = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/messages`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ sender: 'AGENT', content: 'Response content' })
        .expect(400);
      expect(resMessages.body.code).toBe('MISSING_FENCING_TOKEN');

      // POST summaries
      const resSummaries = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/summaries`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ content: 'Summary content' })
        .expect(400);
      expect(resSummaries.body.code).toBe('MISSING_FENCING_TOKEN');
    });

    it('should reject request when fencing token is stale or mismatched', async () => {
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

      // POST turns with stale fence 4
      const resTurns = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .set('X-Fencing-Token', '4')
        .send({ messages: [{ sender: 'AGENT', content: 'Stale response' }] })
        .expect(409);
      expect(resTurns.body.code).toBe('STALE_FENCING_TOKEN');

      // POST messages with stale fence 4
      const resMessages = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/messages`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .set('X-Fencing-Token', '4')
        .send({ sender: 'AGENT', content: 'Stale message' })
        .expect(409);
      expect(resMessages.body.code).toBe('STALE_FENCING_TOKEN');

      // POST summaries with stale fence 4
      const resSummaries = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/summaries`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .set('X-Fencing-Token', '4')
        .send({ content: 'Stale summary' })
        .expect(409);
      expect(resSummaries.body.code).toBe('STALE_FENCING_TOKEN');
    });

    it('should allow message persistence with canonical X-Fencing-Token and lowercase x-fencing-token on all write routes', async () => {
      const user = await prisma.user.create({
        data: { email: 'fence-user3@example.com', password: 'password', status: 'ACTIVE' },
      });

      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));
      const lockKey = `chat:session-lock:${user.id}:${session.id}`;

      // 1. POST turns with canonical X-Fencing-Token
      await cacheService.hset(lockKey, 'fence', '10');
      const resCanonicalTurns = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .set('X-Fencing-Token', '10')
        .send({ messages: [{ sender: 'AGENT', content: 'Canonical fenced turn' }] })
        .expect(201);
      expect(resCanonicalTurns.body.messages[0].content).toBe('Canonical fenced turn');

      // 2. POST turns with lowercase x-fencing-token
      await cacheService.hset(lockKey, 'fence', '11');
      const resLowercaseTurns = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .set('x-fencing-token', '11')
        .send({ messages: [{ sender: 'AGENT', content: 'Lowercase fenced turn' }] })
        .expect(201);
      expect(resLowercaseTurns.body.messages[0].content).toBe('Lowercase fenced turn');

      // 3. POST messages with canonical X-Fencing-Token
      await cacheService.hset(lockKey, 'fence', '12');
      const resCanonicalMsg = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/messages`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .set('X-Fencing-Token', '12')
        .send({ sender: 'AGENT', content: 'Canonical fenced msg' })
        .expect(201);
      expect(resCanonicalMsg.body.content).toBe('Canonical fenced msg');

      // 4. POST messages with lowercase x-fencing-token
      await cacheService.hset(lockKey, 'fence', '13');
      const resLowercaseMsg = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/messages`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .set('x-fencing-token', '13')
        .send({ sender: 'USER', content: 'Lowercase fenced msg' })
        .expect(201);
      expect(resLowercaseMsg.body.content).toBe('Lowercase fenced msg');

      // 5. POST summaries with canonical X-Fencing-Token
      await cacheService.hset(lockKey, 'fence', '14');
      const resCanonicalSummary = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/summaries`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .set('X-Fencing-Token', '14')
        .send({ content: 'Canonical fenced summary' })
        .expect(201);
      expect(resCanonicalSummary.body.content).toBe('Canonical fenced summary');

      // 6. POST summaries with lowercase x-fencing-token
      await cacheService.hset(lockKey, 'fence', '15');
      const resLowercaseSummary = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/summaries`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .set('x-fencing-token', '15')
        .send({ content: 'Lowercase fenced summary' })
        .expect(201);
      expect(resLowercaseSummary.body.content).toBe('Lowercase fenced summary');
    });
  });

  describe('Encrypted Persistence & Full 7-Route HTTP Supertest Coverage (WP 3D / Phase 8E)', () => {
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

      const messageDb = await prisma.chatMessage.findUnique({
        where: { id: turnRes.body.messages[0].id },
      });
      expect(messageDb!.contentCiphertext).not.toBeNull();
      expect(messageDb!.contentNonce).not.toBeNull();
      expect(messageDb!.contentAuthTag).not.toBeNull();
    });

    it('should create individual messages via POST /sessions/:sessionId/messages with encrypted persistence', async () => {
      const user = await prisma.user.create({
        data: { email: 'msg-crypto-user@example.com', password: 'password', status: 'ACTIVE' },
      });
      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const msgRes = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/messages`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ sender: 'AGENT', content: 'Direct agent message', type: 'STANDARD' })
        .expect(201);

      expect(msgRes.body.id).toBeDefined();
      expect(msgRes.body.sessionId).toBe(session.id);
      expect(msgRes.body.sender).toBe('AGENT');
      expect(msgRes.body.type).toBe('STANDARD');
      expect(msgRes.body.content).toBe('Direct agent message');

      const messageDb = await prisma.chatMessage.findUnique({
        where: { id: msgRes.body.id },
      });
      expect(messageDb!.contentCiphertext).not.toBeNull();
      expect(messageDb!.contentNonce).not.toBeNull();
      expect(messageDb!.contentAuthTag).not.toBeNull();
      expect(messageDb!.contentKeyVersion).toBe(1);
    });

    it('should create summary via POST /sessions/:sessionId/summaries with encrypted persistence and AGENT/SUMMARY role', async () => {
      const user = await prisma.user.create({
        data: { email: 'summary-crypto-user@example.com', password: 'password', status: 'ACTIVE' },
      });
      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const summaryRes = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/summaries`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ content: 'Summary: User wants to fly to London on Friday' })
        .expect(201);

      expect(summaryRes.body.id).toBeDefined();
      expect(summaryRes.body.sessionId).toBe(session.id);
      expect(summaryRes.body.sender).toBe('AGENT');
      expect(summaryRes.body.type).toBe('SUMMARY');
      expect(summaryRes.body.content).toBe('Summary: User wants to fly to London on Friday');

      const messageDb = await prisma.chatMessage.findUnique({
        where: { id: summaryRes.body.id },
      });
      expect(messageDb!.sender).toBe('AGENT');
      expect(messageDb!.type).toBe('SUMMARY');
      expect(messageDb!.contentCiphertext).not.toBeNull();
      expect(messageDb!.contentNonce).not.toBeNull();
      expect(messageDb!.contentAuthTag).not.toBeNull();
      expect(messageDb!.contentKeyVersion).toBe(1);
    });

    it('should persist an empty agent turn with a complete encrypted envelope', async () => {
      const user = await prisma.user.create({
        data: { email: 'empty-agent-user@example.com', password: 'password', status: 'ACTIVE' },
      });

      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const turnRes = await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/turns`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ messages: [{ sender: 'AGENT', content: '' }] })
        .expect(201);

      expect(turnRes.body.messages).toHaveLength(1);
      expect(turnRes.body.messages[0].content).toBe('');

      const messageDb = await prisma.chatMessage.findUnique({
        where: { id: turnRes.body.messages[0].id },
      });
      expect(messageDb!.contentCiphertext).toBe('');
      expect(messageDb!.contentNonce).not.toBeNull();
      expect(messageDb!.contentAuthTag).not.toBeNull();
      expect(messageDb!.contentKeyVersion).toBe(1);
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

      await request(app.getHttpServer())
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

    it('should parse recentCount and retrieve decrypted messages and summary in session memory', async () => {
      const user = await prisma.user.create({
        data: { email: 'memory-query-user@example.com', password: 'password', status: 'ACTIVE' },
      });
      const claimToken = mintClaimToken(user.id, Math.floor(Date.now() / 1000));
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      // Add a summary and a message
      await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/summaries`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ content: 'Memory test summary' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/agent-gateway/chat/sessions/${session.id}/messages`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({ sender: 'USER', content: 'First message', type: 'STANDARD' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(`/agent-gateway/chat/sessions/${session.id}/memory?recentCount=5`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .expect(200);

      expect(response.body.summary).toBe('Memory test summary');
      expect(response.body.recentMessages).toHaveLength(1);
      expect(response.body.recentMessages[0].content).toBe('First message');
      expect(response.body.totalMessageCount).toBe(2);
    });
  });
});
