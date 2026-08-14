import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient, User } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ChatService } from '../src/chat/chat.service';
import { ChatMessageCryptoService } from '../src/chat/chat-message-crypto.service';
import { PrismaService } from '../src/prisma/prisma.service';

const prisma = new PrismaClient();
const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CHAT_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

describe('Chat Plaintext Cleanup (e2e)', () => {
  let chatService: ChatService;
  let cryptoService: ChatMessageCryptoService;
  let testUser: User;
  let testSessionId: string;
  let testMessageId: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    chatService = module.get<ChatService>(ChatService);
    cryptoService = module.get<ChatMessageCryptoService>(ChatMessageCryptoService);

    testUser = await prisma.user.create({
      data: {
        email: `plaintext-cleanup-${Date.now()}@example.com`,
        password: 'password123',
      },
    });
  });

  afterAll(async () => {
    if (testSessionId) {
      await prisma.chatMessage.deleteMany({ where: { sessionId: testSessionId } });
      await prisma.chatSession.deleteMany({ where: { id: testSessionId } });
    }
    if (testUser) {
      await prisma.user.delete({ where: { id: testUser.id } });
    }
    await prisma.$disconnect();
  });

  it('should verify legacy plaintext columns are dropped from PostgreSQL schema', async () => {
    const messageColumns: Array<{ column_name: string }> = await prisma.$queryRaw`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'chat_messages' AND column_name = 'content';
    `;
    expect(messageColumns.length).toBe(0);

    const sessionColumns: Array<{ column_name: string }> = await prisma.$queryRaw`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'chat_sessions' AND column_name = 'title';
    `;
    expect(sessionColumns.length).toBe(0);
  });

  it('should persist messages and sessions strictly in ciphertext envelopes with zero plaintext in database rows', async () => {
    const SECRET_TITLE = 'Secret Honeymoon to Tokyo';
    const SECRET_CONTENT = 'Booking flight for Alice and Bob passport P1234567';

    // Create session via ChatService
    const session = await chatService.createSession(testUser.id, SECRET_TITLE);
    testSessionId = session.id;
    expect(session.title).toBe(SECRET_TITLE);

    // Create message via ChatService
    const message = await chatService.createMessage(testUser.id, testSessionId, {
      sender: 'USER',
      content: SECRET_CONTENT,
    });
    testMessageId = message.id;
    expect(message.content).toBe(SECRET_CONTENT);

    // Raw SQL inspection of chat_sessions
    const rawSessions: any[] = await prisma.$queryRaw`
      SELECT * FROM "chat_sessions" WHERE "id" = ${testSessionId}::text;
    `;
    expect(rawSessions.length).toBe(1);
    const rawSession = rawSessions[0];
    expect(rawSession.title).toBeUndefined();
    expect(rawSession.titleCiphertext).toBeDefined();
    expect(rawSession.titleCiphertext).not.toBeNull();
    expect(rawSession.titleNonce).toBeDefined();
    expect(rawSession.titleAuthTag).toBeDefined();
    expect(rawSession.titleKeyVersion).toBe(1);

    // Raw SQL inspection of chat_messages
    const rawMessages: any[] = await prisma.$queryRaw`
      SELECT * FROM "chat_messages" WHERE "id" = ${testMessageId}::text;
    `;
    expect(rawMessages.length).toBe(1);
    const rawMessage = rawMessages[0];
    expect(rawMessage.content).toBeUndefined();
    expect(rawMessage.contentCiphertext).toBeDefined();
    expect(rawMessage.contentCiphertext).not.toBeNull();
    expect(rawMessage.contentNonce).toBeDefined();
    expect(rawMessage.contentAuthTag).toBeDefined();
    expect(rawMessage.contentKeyVersion).toBe(1);

    // Exhaustive Zero-Plaintext Scan across raw row JSON representation
    const sessionJson = JSON.stringify(rawSession);
    const messageJson = JSON.stringify(rawMessage);
    expect(sessionJson).not.toContain(SECRET_TITLE);
    expect(messageJson).not.toContain(SECRET_CONTENT);
    expect(messageJson).not.toContain('P1234567');
  });

  it('should authenticate and decrypt messages and sessions on read paths', async () => {
    const fetchedSession = await chatService.getSession(testUser.id, testSessionId);
    expect(fetchedSession.title).toBe('Secret Honeymoon to Tokyo');

    const fetchedMessages = await chatService.listMessages(testUser.id, testSessionId, { limit: 10, direction: 'before' });
    expect(fetchedMessages.messages.length).toBeGreaterThanOrEqual(1);
    const found = fetchedMessages.messages.find((m) => m.id === testMessageId);
    expect(found).toBeDefined();
    expect(found!.content).toBe('Booking flight for Alice and Bob passport P1234567');
  });

  it('should fail closed when attempting to decrypt tampered ciphertext envelopes without legacy fallback', async () => {
    const corruptedMessage = {
      id: 'corrupt-msg',
      sessionId: testSessionId,
      sender: 'USER',
      type: 'STANDARD',
      contentCiphertext: 'deadbeef01020304',
      contentNonce: '0102030405060708090a0b0c',
      contentAuthTag: '0102030405060708090a0b0c0d0e0f10',
      contentKeyVersion: 1,
    };

    await expect(
      cryptoService.decryptMessageContent(corruptedMessage as any),
    ).rejects.toThrow();
  });
});
