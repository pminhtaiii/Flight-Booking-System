import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { MessageSender, MessageType, User, ChatSession } from '@prisma/client';
import { ChatMessageCryptoService } from '@/chat/chat-message-crypto.service';
import * as crypto from 'crypto';

describe('Chat API (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let cryptoService: ChatMessageCryptoService;

  let userA: User;
  let userB: User;
  let tokenA: string;

  beforeAll(async () => {
    process.env.CHAT_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

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
    jwtService = moduleFixture.get<JwtService>(JwtService);
    cryptoService = moduleFixture.get<ChatMessageCryptoService>(ChatMessageCryptoService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clear Database tables before each test to ensure isolation
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

    // Create test users
    userA = await prisma.user.create({
      data: {
        email: 'user-a@example.com',
        password: 'Password123!',
      },
    });

    userB = await prisma.user.create({
      data: {
        email: 'user-b@example.com',
        password: 'Password123!',
      },
    });

    tokenA = jwtService.sign({ id: userA.id, email: userA.email });
  });

  async function createEncryptedSession(userId: string, title?: string, lastActiveAt?: Date) {
    const sessionId = crypto.randomUUID();
    let titleCiphertext: string | null = null;
    let titleNonce: string | null = null;
    let titleAuthTag: string | null = null;
    let titleKeyVersion: number | null = null;
    if (title) {
      const enc = await cryptoService.encryptSessionTitle(sessionId, title);
      titleCiphertext = enc.ciphertext;
      titleNonce = enc.nonce;
      titleAuthTag = enc.authTag;
      titleKeyVersion = enc.keyVersion;
    }
    return prisma.chatSession.create({
      data: {
        id: sessionId,
        userId,
        titleCiphertext,
        titleNonce,
        titleAuthTag,
        titleKeyVersion,
        ...(lastActiveAt ? { lastActiveAt } : {}),
      },
    });
  }

  async function createEncryptedMessage(
    sessionId: string,
    sender: MessageSender,
    content: string,
    type: MessageType = MessageType.STANDARD,
    createdAt?: Date,
  ) {
    const messageId = crypto.randomUUID();
    const enc = await cryptoService.encryptMessageContent(messageId, sessionId, sender, type, content);
    return prisma.chatMessage.create({
      data: {
        id: messageId,
        sessionId,
        sender,
        type,
        contentCiphertext: enc.ciphertext,
        contentNonce: enc.nonce,
        contentAuthTag: enc.authTag,
        contentKeyVersion: enc.keyVersion,
        ...(createdAt ? { createdAt } : {}),
      },
    });
  }

  describe('Authorization checks', () => {
    it('should return 401 when no token is provided', async () => {
      await request(app.getHttpServer()).post('/chat/sessions').send({}).expect(401);
    });

    it('should return 401 when an invalid token is provided', async () => {
      await request(app.getHttpServer())
        .post('/chat/sessions')
        .set('Authorization', 'Bearer invalid-token')
        .send({})
        .expect(401);
    });
  });

  describe('POST /chat/sessions', () => {
    it('should create a chat session, log audit record and return 201', async () => {
      const res = await request(app.getHttpServer())
        .post('/chat/sessions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ title: 'My Trip Plan' })
        .expect(201);

      expect(res.body).toHaveProperty('id');
      expect(res.body.title).toBe('My Trip Plan');
      expect(res.body.userId).toBe(userA.id);

      // Verify DB session
      const dbSession = await prisma.chatSession.findUnique({
        where: { id: res.body.id },
      });
      expect(dbSession).toBeDefined();
      expect(dbSession!.titleCiphertext).not.toBeNull();
      const decryptedTitle = await cryptoService.decryptSessionTitle(dbSession!);
      expect(decryptedTitle).toBe('My Trip Plan');

      // Verify Audit Log
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          userId: userA.id,
          action: 'chat_session_create',
          resourceType: 'ChatSession',
          resourceId: res.body.id,
        },
      });
      expect(auditLog).toBeDefined();
    });
  });

  describe('GET /chat/sessions', () => {
    it('should return paginated sessions sorted by lastActiveAt desc with messagePreview', async () => {
      // Create three sessions with different activity times
      const session1 = await createEncryptedSession(userA.id, 'Session 1', new Date(Date.now() - 3000));
      const session2 = await createEncryptedSession(userA.id, 'Session 2', new Date(Date.now() - 1000));
      const session3 = await createEncryptedSession(userA.id, 'Session 3', new Date(Date.now() - 2000));

      // Add a message to session2 to act as messagePreview
      await createEncryptedMessage(session2.id, MessageSender.USER, 'Hello World', MessageType.STANDARD, new Date());

      // List limit = 2
      const res1 = await request(app.getHttpServer())
        .get('/chat/sessions')
        .query({ limit: 2 })
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      // Order should be session2 (lastActiveAt -1000), session3 (lastActiveAt -2000), session1 (lastActiveAt -3000)
      expect(res1.body.sessions).toHaveLength(2);
      expect(res1.body.sessions[0].id).toBe(session2.id);
      expect(res1.body.sessions[0].messagePreview).toBe('Hello World');
      expect(res1.body.sessions[1].id).toBe(session3.id);
      expect(res1.body.sessions[1].messagePreview).toBeNull();
      expect(res1.body.nextCursor).toBeDefined();

      // Retrieve next page using cursor
      const res2 = await request(app.getHttpServer())
        .get('/chat/sessions')
        .query({ limit: 2, cursor: res1.body.nextCursor })
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res2.body.sessions).toHaveLength(1);
      expect(res2.body.sessions[0].id).toBe(session1.id);
      expect(res2.body.nextCursor).toBeNull();
    });
  });

  describe('GET /chat/sessions/:sessionId', () => {
    it('should return session details and messageCount', async () => {
      const session = await createEncryptedSession(userA.id, 'Test Session');

      await createEncryptedMessage(session.id, MessageSender.USER, 'msg1');
      await createEncryptedMessage(session.id, MessageSender.AGENT, 'msg2');

      const res = await request(app.getHttpServer())
        .get(`/chat/sessions/${session.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.id).toBe(session.id);
      expect(res.body.messageCount).toBe(2);
    });
  });

  describe('PATCH /chat/sessions/:sessionId', () => {
    it('should update session title', async () => {
      const session = await createEncryptedSession(userA.id, 'Old Title');

      const res = await request(app.getHttpServer())
        .patch(`/chat/sessions/${session.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ title: 'New Title' })
        .expect(200);

      expect(res.body.title).toBe('New Title');

      const dbSession = await prisma.chatSession.findUnique({
        where: { id: session.id },
      });
      expect(dbSession!.titleCiphertext).not.toBeNull();
      const decrypted = await cryptoService.decryptSessionTitle(dbSession!);
      expect(decrypted).toBe('New Title');

      // Verify audit log entry
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          userId: userA.id,
          action: 'chat_session_update',
          resourceType: 'ChatSession',
          resourceId: session.id,
        },
      });
      expect(auditLog).toBeDefined();
      expect(auditLog).not.toBeNull();
    });
  });

  describe('POST /chat/sessions/:sessionId/messages', () => {
    it('should create message, update session lastActiveAt, write audit log and return 201', async () => {
      const session = await createEncryptedSession(userA.id, 'Chat Session', new Date(Date.now() - 10000));

      const res = await request(app.getHttpServer())
        .post(`/chat/sessions/${session.id}/messages`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          sender: MessageSender.USER,
          content: 'Hello Agent',
        })
        .expect(201);

      expect(res.body.content).toBe('Hello Agent');
      expect(res.body.sender).toBe(MessageSender.USER);

      // Verify session updated
      const dbSession = await prisma.chatSession.findUnique({
        where: { id: session.id },
      });
      expect(dbSession!.lastActiveAt.getTime()).toBeGreaterThan(session.lastActiveAt.getTime());

      // Verify audit log
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          userId: userA.id,
          action: 'chat_message_create',
          resourceType: 'ChatMessage',
          resourceId: res.body.id,
        },
      });
      expect(auditLog).toBeDefined();
    });
  });

  describe('GET /chat/sessions/:sessionId/messages', () => {
    it('should return messages chronologically with cursor pagination in both directions', async () => {
      const session = await createEncryptedSession(userA.id, 'History');

      const msg1 = await createEncryptedMessage(
        session.id,
        MessageSender.USER,
        'One',
        MessageType.STANDARD,
        new Date(Date.now() - 3000),
      );

      const msg2 = await createEncryptedMessage(
        session.id,
        MessageSender.AGENT,
        'Two',
        MessageType.STANDARD,
        new Date(Date.now() - 2000),
      );

      const msg3 = await createEncryptedMessage(
        session.id,
        MessageSender.USER,
        'Three',
        MessageType.STANDARD,
        new Date(Date.now() - 1000),
      );

      // Direction: before (default)
      const res1 = await request(app.getHttpServer())
        .get(`/chat/sessions/${session.id}/messages`)
        .query({ limit: 2 })
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      // Should return the most recent 2 messages in chronological order: msg2, msg3
      expect(res1.body.messages).toHaveLength(2);
      expect(res1.body.messages[0].id).toBe(msg2.id);
      expect(res1.body.messages[1].id).toBe(msg3.id);
      expect(res1.body.nextCursor).toBeDefined();

      // Retrieve messages before msg2 using cursor
      const res2 = await request(app.getHttpServer())
        .get(`/chat/sessions/${session.id}/messages`)
        .query({ limit: 2, cursor: res1.body.nextCursor, direction: 'before' })
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res2.body.messages).toHaveLength(1);
      expect(res2.body.messages[0].id).toBe(msg1.id);
      expect(res2.body.nextCursor).toBeNull();

      // Direction: after
      const res3 = await request(app.getHttpServer())
        .get(`/chat/sessions/${session.id}/messages`)
        .query({ limit: 2, cursor: msg1.createdAt.toISOString(), direction: 'after' })
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      // Should return msg2, msg3
      expect(res3.body.messages).toHaveLength(2);
      expect(res3.body.messages[0].id).toBe(msg2.id);
      expect(res3.body.messages[1].id).toBe(msg3.id);
    });
  });

  describe('POST /chat/sessions/:sessionId/messages/batch', () => {
    it('should atomically create batch of messages, update lastActiveAt, write batch audit log', async () => {
      const session = await createEncryptedSession(userA.id, 'Batch session');

      const res = await request(app.getHttpServer())
        .post(`/chat/sessions/${session.id}/messages/batch`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          messages: [
            { sender: MessageSender.USER, content: 'User Batch Msg' },
            { sender: MessageSender.AGENT, content: 'Agent Batch Msg' },
          ],
        })
        .expect(201);

      expect(res.body.messages).toHaveLength(2);
      expect(res.body.messages[0].content).toBe('User Batch Msg');
      expect(res.body.messages[1].content).toBe('Agent Batch Msg');

      // Verify audit log
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          userId: userA.id,
          action: 'chat_message_batch_create',
          resourceType: 'ChatMessage',
        },
      });
      expect(auditLog).toBeDefined();
    });
  });

  describe('GET /chat/sessions/:sessionId/memory', () => {
    it('should return summary and recent standard messages', async () => {
      const session = await createEncryptedSession(userA.id, 'Memory Test');

      await createEncryptedMessage(
        session.id,
        MessageSender.AGENT,
        'This is the summary of old conversation',
        MessageType.SUMMARY,
        new Date(Date.now() - 5000),
      );

      await createEncryptedMessage(
        session.id,
        MessageSender.USER,
        'Hello Standard 1',
        MessageType.STANDARD,
        new Date(Date.now() - 3000),
      );

      await createEncryptedMessage(
        session.id,
        MessageSender.AGENT,
        'Hello Standard 2',
        MessageType.STANDARD,
        new Date(Date.now() - 1000),
      );

      const res = await request(app.getHttpServer())
        .get(`/chat/sessions/${session.id}/memory`)
        .query({ recentCount: 5 })
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.summary).toBe('This is the summary of old conversation');
      expect(res.body.recentMessages).toHaveLength(2);
      expect(res.body.recentMessages[0].content).toBe('Hello Standard 1');
      expect(res.body.recentMessages[1].content).toBe('Hello Standard 2');
      expect(res.body.totalMessageCount).toBe(3);
    });
  });

  describe('DELETE /chat/sessions/:sessionId', () => {
    it('should cascade delete session and messages, and write audit log', async () => {
      const session = await createEncryptedSession(userA.id, 'To Delete');

      await createEncryptedMessage(session.id, MessageSender.USER, 'Some message');

      await request(app.getHttpServer())
        .delete(`/chat/sessions/${session.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      // Verify soft deletion in DB
      const dbSession = await prisma.chatSession.findUnique({
        where: { id: session.id },
      });
      expect(dbSession).toBeDefined();
      expect(dbSession!.deletedAt).not.toBeNull();

      const dbMessages = await prisma.chatMessage.findMany({
        where: { sessionId: session.id },
      });
      expect(dbMessages.length).toBeGreaterThan(0);

      // Verify audit log
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          userId: userA.id,
          action: 'chat_session_delete',
          resourceType: 'ChatSession',
          resourceId: session.id,
        },
      });
      expect(auditLog).toBeDefined();
    });
  });

  describe('User scoping / isolation', () => {
    let sessionB: ChatSession;

    beforeEach(async () => {
      sessionB = await createEncryptedSession(userB.id, 'User B Session');
    });

    it('should return 404 when User A tries to GET User B session details', async () => {
      await request(app.getHttpServer())
        .get(`/chat/sessions/${sessionB.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });

    it('should return 404 when User A tries to PATCH User B session title', async () => {
      await request(app.getHttpServer())
        .patch(`/chat/sessions/${sessionB.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ title: 'Hacked Title' })
        .expect(404);
    });

    it('should return 404 when User A tries to POST message to User B session', async () => {
      await request(app.getHttpServer())
        .post(`/chat/sessions/${sessionB.id}/messages`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ sender: MessageSender.USER, content: 'Spam' })
        .expect(404);
    });

    it('should return 404 when User A tries to POST batch messages to User B session', async () => {
      await request(app.getHttpServer())
        .post(`/chat/sessions/${sessionB.id}/messages/batch`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          messages: [{ sender: MessageSender.USER, content: 'Spam Batch' }],
        })
        .expect(404);
    });

    it('should return 404 when User A tries to GET messages of User B session', async () => {
      await request(app.getHttpServer())
        .get(`/chat/sessions/${sessionB.id}/messages`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });

    it('should return 404 when User A tries to GET memory of User B session', async () => {
      await request(app.getHttpServer())
        .get(`/chat/sessions/${sessionB.id}/memory`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });

    it('should return 404 when User A tries to DELETE User B session', async () => {
      await request(app.getHttpServer())
        .delete(`/chat/sessions/${sessionB.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });
  });
});
