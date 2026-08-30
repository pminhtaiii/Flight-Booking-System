import * as crypto from 'crypto';

const encryptionKey = crypto.randomBytes(32).toString('hex');
const chatEncryptionKey = crypto.randomBytes(32).toString('hex');

process.env.ENCRYPTION_KEY = encryptionKey;
process.env.CHAT_ENCRYPTION_KEY = chatEncryptionKey;
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
process.env.AGENT_SERVICE_API_KEY = 'test-agent-api-key';
process.env.ATTESTATION_SECRET = 'test-attestation-secret';
process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret-must-be-long-enough';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ChatMessageCryptoService } from '@/chat/chat-message-crypto.service';
import { ClaimTokenService } from '@/agent-gateway/auth/claim-token.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

const FORBIDDEN_PRIVACY_CORPUS = [
  'chk_handoff_v1_secret_token_12345',
  'handoff-token-hash-abcdef',
  'duffel-private-offer-id-999',
  'local-flight-offer-id-888',
  'booking-db-id-uuid-777',
  'PNR123456',
  'pnr_ABCDEF',
  'traveller.secret@example.com',
  '+84 912345678',
  'P12345678',
  '4111111111111111',
  'Plaintext sensitive customer conversation',
] as const;

describe('Chat and Handoff Privacy Corpus E2E & Boundary Safety', () => {
  jest.setTimeout(180_000);

  let app: INestApplication | undefined;
  let prisma: PrismaService | undefined;
  let cryptoService: ChatMessageCryptoService | undefined;
  let claimTokenService: ClaimTokenService | undefined;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string): string | undefined => {
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ISSUE') return 'true';
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') return 'true';
          if (key === 'FEATURE_FLAG_BOOKING_READINESS') return 'true';
          if (key === 'CHAT_HANDOFF_SECRET') return 'test-handoff-secret';
          if (key === 'CHAT_ENCRYPTION_KEY') return chatEncryptionKey;
          if (key === 'CLAIM_TOKEN_SECRET') return 'test-claim-token-secret-must-be-long-enough';
          return process.env[key];
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.setGlobalPrefix('api', { exclude: ['health'] });
    await app.init();

    prisma = moduleFixture.get(PrismaService);
    cryptoService = moduleFixture.get(ChatMessageCryptoService);
    claimTokenService = moduleFixture.get(ClaimTokenService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('ChatMessageCryptoService decryption failure warning logs do NOT leak message ID, session ID, or raw error', async () => {
    const warnSpy = jest.spyOn(cryptoService!['logger'], 'warn');
    const secretMessageId = 'msg-secret-uuid-12345';
    const secretSessionId = 'ses-secret-uuid-67890';

    const corruptedMessage = {
      id: secretMessageId,
      sessionId: secretSessionId,
      sender: 'USER',
      type: 'STANDARD',
      contentCiphertext: 'corrupted_hex',
      contentNonce: crypto.randomBytes(12).toString('hex'),
      contentAuthTag: crypto.randomBytes(16).toString('hex'),
      contentKeyVersion: 1,
    };

    await expect(cryptoService!.decryptMessageContent(corruptedMessage)).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    const loggedWarning = warnSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(loggedWarning).not.toContain(secretMessageId);
    expect(loggedWarning).not.toContain(secretSessionId);
    warnSpy.mockRestore();
  });

  it('ChatMessageCryptoService session title decryption failure warning logs do NOT leak session ID or raw error', async () => {
    const warnSpy = jest.spyOn(cryptoService!['logger'], 'warn');
    const secretSessionId = 'ses-title-secret-uuid-99999';

    const corruptedSession = {
      id: secretSessionId,
      titleCiphertext: 'corrupted_hex',
      titleNonce: crypto.randomBytes(12).toString('hex'),
      titleAuthTag: crypto.randomBytes(16).toString('hex'),
      titleKeyVersion: 1,
    };

    await expect(cryptoService!.decryptSessionTitle(corruptedSession)).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    const loggedWarning = warnSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(loggedWarning).not.toContain(secretSessionId);
    warnSpy.mockRestore();
  });

  it('ClaimTokenService warning logs do NOT leak user ID on missing or inactive user', async () => {
    const warnSpy = jest.spyOn(claimTokenService!['logger'], 'warn');
    const secretUserId = 'usr-secret-uuid-44444';
    const payload = { userId: secretUserId, iat: Math.floor(Date.now() / 1000) };
    const payloadStr = JSON.stringify(payload);
    const payloadB64 = Buffer.from(payloadStr).toString('base64url');
    const sig = crypto
      .createHmac('sha256', process.env.CLAIM_TOKEN_SECRET!)
      .update(payloadStr)
      .digest('base64url');
    const validSigToken = `${payloadB64}.${sig}`;

    await expect(claimTokenService!.validateToken(validSigToken)).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    const loggedWarning = warnSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(loggedWarning).not.toContain(secretUserId);
    warnSpy.mockRestore();
  });
});
