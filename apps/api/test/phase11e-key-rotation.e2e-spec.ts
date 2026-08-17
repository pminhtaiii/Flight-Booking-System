import * as crypto from 'crypto';
import { JwtService } from '@nestjs/jwt';

const encryptionKey = crypto.randomBytes(32).toString('hex');
const chatEncryptionKey = crypto.randomBytes(32).toString('hex');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/flight_booking?schema=public';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.ENCRYPTION_KEY = encryptionKey;
process.env.CHAT_ENCRYPTION_KEY = chatEncryptionKey;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'rk_test_placeholder';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder';

// JWT Ring Configuration
process.env.JWT_SECRET_CURRENT = 'jwt-secret-current-v2-active';
process.env.JWT_SECRET = 'jwt-secret-current-v2-active';
process.env.JWT_SECRET_PREVIOUS = 'jwt-secret-previous-v1-grace';
process.env.JWT_SECRET_V2 = 'jwt-secret-current-v2-active';
process.env.JWT_SECRET_V1 = 'jwt-secret-previous-v1-grace';

// Chat Handoff Ring Configuration
process.env.CHAT_HANDOFF_SECRET_CURRENT = 'handoff-secret-v2-active-1234567890';
process.env.CHAT_HANDOFF_SECRET_PREVIOUS = 'handoff-secret-v1-grace-1234567890';
process.env.CHAT_HANDOFF_SECRET_V1 = 'handoff-secret-v1-grace-1234567890';
process.env.CHAT_HANDOFF_SECRET_V2 = 'handoff-secret-v2-active-1234567890';

// Attestation Secret Ring Configuration
process.env.ATTESTATION_SECRET_CURRENT = 'attestation-secret-v2-active-1234567890';
process.env.ATTESTATION_SECRET_PREVIOUS = 'attestation-secret-v1-grace-1234567890';
process.env.ATTESTATION_SECRET_V1 = 'attestation-secret-v1-grace-1234567890';
process.env.ATTESTATION_SECRET_V2 = 'attestation-secret-v2-active-1234567890';

// Claim Token Secret Ring Configuration
process.env.CLAIM_TOKEN_SECRET_CURRENT = 'claim-token-secret-v2-active-1234567890';
process.env.CLAIM_TOKEN_SECRET = 'claim-token-secret-v2-active-1234567890';
process.env.CLAIM_TOKEN_SECRET_PREVIOUS = 'claim-token-secret-v1-grace-1234567890';
process.env.CLAIM_TOKEN_SECRET_V1 = 'claim-token-secret-v1-grace-1234567890';
process.env.CLAIM_TOKEN_SECRET_V2 = 'claim-token-secret-v2-active-1234567890';
process.env.CLAIM_TOKEN_TTL_SECONDS = '300';

process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
process.env.AGENT_SERVICE_API_KEY = 'test-agent-api-key';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { ChatHandoffTokenService } from '@/chat-handoff/chat-handoff-token.service';
import { ClaimTokenService } from '@/agent-gateway/auth/claim-token.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

function signClaimToken(userId: string, iat: number, secret: string): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();
  return `${Buffer.from(payloadStr).toString('base64url')}.${signature.toString('base64url')}`;
}

describe('Phase 11E: Zero-Downtime Key Rotation Ring Verification (e2e)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let attestationService: SelectionAttestationService;
  let handoffTokenService: ChatHandoffTokenService;
  let claimTokenService: ClaimTokenService;

  let testUser: any;
  const userUniqueEmail = `rotation-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
    attestationService = moduleFixture.get<SelectionAttestationService>(SelectionAttestationService);
    handoffTokenService = moduleFixture.get<ChatHandoffTokenService>(ChatHandoffTokenService);
    claimTokenService = moduleFixture.get<ClaimTokenService>(ClaimTokenService);

    testUser = await prisma.user.create({
      data: {
        email: userUniqueEmail,
        password: 'hashed-password-12345',
        status: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    if (testUser?.id) {
      await prisma.chatSession.deleteMany({ where: { userId: testUser.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    }
    await app.close();
  });

  describe('1. JWT Secret Zero-Downtime Key Rotation Ring', () => {
    it('authenticates successfully with token signed with Previous / V1 key (grace period)', async () => {
      const v1Token = jwtService.sign(
        { id: testUser.id, email: testUser.email, sub: testUser.id, jti: crypto.randomUUID() },
        { secret: 'jwt-secret-previous-v1-grace', expiresIn: '1h' },
      );

      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${v1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.email).toBe(testUser.email);
    });

    it('authenticates successfully with token signed with Current / V2 key (primary key)', async () => {
      const v2Token = jwtService.sign(
        { id: testUser.id, email: testUser.email, sub: testUser.id, jti: crypto.randomUUID() },
        { secret: 'jwt-secret-current-v2-active', expiresIn: '1h' },
      );

      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${v2Token}`);

      expect(res.status).toBe(200);
      expect(res.body.email).toBe(testUser.email);
    });

    it('rejects authentication (401) with token signed with unknown/expired Key V0', async () => {
      const v0Token = jwtService.sign(
        { id: testUser.id, email: testUser.email, sub: testUser.id, jti: crypto.randomUUID() },
        { secret: 'unknown-expired-v0-key', expiresIn: '1h' },
      );

      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${v0Token}`);

      expect(res.status).toBe(401);
    });
  });

  describe('2. Chat Handoff Secret Key Rotation Ring', () => {
    it('derives and verifies token generated with key Version 1 (grace period secret)', async () => {
      const rowId = crypto.randomUUID();
      const idempotencyHash = handoffTokenService.deriveIdempotencyHash('test-attestation', 1, 1);
      const generated = await handoffTokenService.generateToken(rowId, idempotencyHash, 1);

      expect(generated.keyVersion).toBe(1);
      expect(generated.token).toContain('chk_handoff_v1_');

      const isValid = await handoffTokenService.verifyToken(
        generated.token,
        generated.tokenHash,
        1,
      );
      expect(isValid).toBe(true);
    });

    it('derives and verifies token generated with key Version 2 (active secret)', async () => {
      const rowId = crypto.randomUUID();
      const idempotencyHash = handoffTokenService.deriveIdempotencyHash('test-attestation', 1, 2);
      const generated = await handoffTokenService.generateToken(rowId, idempotencyHash, 2);

      expect(generated.keyVersion).toBe(2);
      expect(generated.token).toContain('chk_handoff_v2_');

      const isValid = await handoffTokenService.verifyToken(
        generated.token,
        generated.tokenHash,
        2,
      );
      expect(isValid).toBe(true);
    });

    it('rejects handoff token verification when key version is unknown / unconfigured', async () => {
      const isValid = await handoffTokenService.verifyToken(
        'chk_handoff_v99_invalidtokenstring',
        '0000000000000000000000000000000000000000000000000000000000000000',
        99,
      );
      expect(isValid).toBe(false);
    });
  });

  describe('3. Selection Attestation Secret Key Rotation Ring', () => {
    const sampleOffers = [
      { flightOfferId: 'fo_123', duffelOfferId: 'off_456' },
    ];
    const sessionId = crypto.randomUUID();

    it('verifies attestation signed with V1 secret when V2 is active', async () => {
      const payload = {
        userId: testUser.id,
        sessionId,
        version: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        offers: sampleOffers,
      };
      const payloadStr = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha256', 'attestation-secret-v1-grace-1234567890')
        .update(payloadStr)
        .digest('hex');
      const base64Payload = Buffer.from(payloadStr, 'utf8').toString('base64url');
      const v1Attestation = `sel_v1_${base64Payload}.${signature}`;

      const verified = await attestationService.verifySelectionAttestation(
        v1Attestation,
        testUser.id,
        sessionId,
        1,
        sampleOffers,
      );
      expect(verified).toBe(true);
    });

    it('signs and verifies attestation with current primary (V2) secret', async () => {
      const signedAttestation = await attestationService.signSelectionAttestation(
        testUser.id,
        sessionId,
        1,
        new Date(Date.now() + 600000).toISOString(),
        sampleOffers,
      );

      const verified = await attestationService.verifySelectionAttestation(
        signedAttestation,
        testUser.id,
        sessionId,
        1,
        sampleOffers,
      );
      expect(verified).toBe(true);
    });

    it('rejects tampered attestation or attestation signed with unconfigured secret', async () => {
      const payload = {
        userId: testUser.id,
        sessionId,
        version: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        offers: sampleOffers,
      };
      const payloadStr = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha256', 'unconfigured-secret-v0')
        .update(payloadStr)
        .digest('hex');
      const base64Payload = Buffer.from(payloadStr, 'utf8').toString('base64url');
      const invalidAttestation = `sel_v1_${base64Payload}.${signature}`;

      await expect(
        attestationService.verifySelectionAttestation(
          invalidAttestation,
          testUser.id,
          sessionId,
          1,
          sampleOffers,
        ),
      ).rejects.toThrow();
    });
  });

  describe('4. Claim Token Secret Key Rotation Ring', () => {
    it('validates claim token signed with V1 secret (grace period)', async () => {
      const tokenV1 = signClaimToken(
        testUser.id,
        Math.floor(Date.now() / 1000),
        'claim-token-secret-v1-grace-1234567890',
      );

      const validatedUser = await claimTokenService.validateToken(tokenV1);
      expect(validatedUser.id).toBe(testUser.id);
    });

    it('validates claim token signed with V2 secret (primary active)', async () => {
      const tokenV2 = signClaimToken(
        testUser.id,
        Math.floor(Date.now() / 1000),
        'claim-token-secret-v2-active-1234567890',
      );

      const validatedUser = await claimTokenService.validateToken(tokenV2);
      expect(validatedUser.id).toBe(testUser.id);
    });

    it('rejects claim token signed with unknown/tampered secret', async () => {
      const tokenUnknown = signClaimToken(
        testUser.id,
        Math.floor(Date.now() / 1000),
        'unknown-unconfigured-secret',
      );

      await expect(claimTokenService.validateToken(tokenUnknown)).rejects.toThrow();
    });
  });
});
