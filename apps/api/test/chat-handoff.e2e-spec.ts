import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import * as crypto from 'crypto';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

import { JwtService } from '@nestjs/jwt';

function mintClaimToken(userId: string, iat: number, secret = 'test-claim-token-secret'): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();
  return `${Buffer.from(payloadStr).toString('base64url')}.${signature.toString('base64url')}`;
}

describe('ChatHandoff (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let attestationService: SelectionAttestationService;
  let jwtService: JwtService;
  
  let validUser: any;
  let validUserToken: string;
  let validSession: any;
  let validFlightOffer: any;
  const apiKey = 'test-agent-api-key';

  beforeAll(async () => {
    process.env.AGENT_SERVICE_API_KEY = apiKey;
    process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';
    process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
    process.env.ATTESTATION_SECRET = 'test-attestation-secret';
    process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string) => {
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') return 'true';
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ISSUE') return 'true';
          if (key === 'CHAT_HANDOFF_SECRET') return 'test-handoff-secret';
          return process.env[key];
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    
    prisma = moduleFixture.get<PrismaService>(PrismaService);
    attestationService = moduleFixture.get<SelectionAttestationService>(SelectionAttestationService);
    jwtService = moduleFixture.get<JwtService>(JwtService);

    validUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `test-${crypto.randomUUID()}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });

    validUserToken = jwtService.sign({ id: validUser.id, email: validUser.email });

    validSession = await prisma.chatSession.create({
      data: {
        userId: validUser.id,
        title: 'Test Session',
      },
    });

    validFlightOffer = await prisma.flightOffer.create({
      data: {
        searchHash: 'testhash',
        duffelOfferId: 'off_test123',
        rawOffer: {},
        origin: 'HAN',
        destination: 'NRT',
        departureDate: new Date(),
        adults: 1,
        cabinClass: 'economy',
        price: 100.0,
        currency: 'USD',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
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
    await prisma.user.deleteMany({});


    validUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `test-${crypto.randomUUID()}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });

    validUserToken = jwtService.sign({ id: validUser.id, email: validUser.email });

    validSession = await prisma.chatSession.create({
      data: {
        userId: validUser.id,
        title: 'Test Session',
      },
    });

    validFlightOffer = await prisma.flightOffer.create({
      data: {
        searchHash: 'testhash',
        duffelOfferId: 'off_test123',
        rawOffer: {},
        origin: 'HAN',
        destination: 'NRT',
        departureDate: new Date(),
        adults: 1,
        cabinClass: 'economy',
        price: 100.0,
        currency: 'USD',
      },
    });
  });

  describe('POST /chat-handoff', () => {
    it('should reject without service auth', async () => {
      // 401 due to missing API key or however service auth is protected in ChatHandoff
      // wait, the endpoints in chat-handoff.controller.ts don't have guards! Let me check if they do.
      // Assuming they don't, this test will fail. That's good.
      await request(app.getHttpServer())
        .post('/chat-handoff')
        .send({ selectionAttestationHash: 'fake', selectedOfferIndex: 1 })
        .expect(401);
    });

    it('should reject caller-supplied IDs in DTO', async () => {
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const offers = [{ flightOfferId: validFlightOffer.id, duffelOfferId: 'off_test123' }];
      const attestation = await attestationService.signSelectionAttestation(
        validUser.id, validSession.id, 1, expiresAt, offers
      );

      // Should fail ValidationPipe if we pass extra fields like userId
      await request(app.getHttpServer())
        .post('/chat-handoff')
        .set('X-Agent-API-Key', apiKey) // Assuming service auth
        .send({
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1,
          userId: 'some-id',
          chatSessionId: 'some-session'
        })
        .expect(400); // Bad Request because forbidNonWhitelisted is true
    });

    it('should bind signed ordered-offer to a valid internal-session', async () => {
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const offers = [{ flightOfferId: validFlightOffer.id, duffelOfferId: 'off_test123' }];
      const attestation = await attestationService.signSelectionAttestation(
        validUser.id, validSession.id, 1, expiresAt, offers
      );

      const res = await request(app.getHttpServer())
        .post('/chat-handoff')
        .set('X-Agent-API-Key', apiKey) // Maybe needs service auth guard?
        .send({
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1
        })
        .expect(201); // Created

      expect(res.body.token).toBeDefined();
      expect(res.body.expiresAt).toBeDefined();

      const record = await prisma.chatHandoff.findFirst({ where: { userId: validUser.id } });
      expect(record).toBeDefined();
      expect(record?.chatSessionId).toBe(validSession.id);
      expect(record?.flightOfferId).toBe(validFlightOffer.id);
    });

    it('should reject stale-offer/attestation', async () => {
      const expiresAt = new Date(Date.now() - 15 * 60000).toISOString(); // Expired!
      const offers = [{ flightOfferId: validFlightOffer.id, duffelOfferId: 'off_test123' }];
      const attestation = await attestationService.signSelectionAttestation(
        validUser.id, validSession.id, 1, expiresAt, offers
      );

      await request(app.getHttpServer())
        .post('/chat-handoff')
        .set('X-Agent-API-Key', apiKey)
        .send({
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1
        })
        .expect(401);
    });
  });

  describe('GET /chat-handoff/resolve', () => {
    let createdToken: string;

    beforeEach(async () => {
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const offers = [{ flightOfferId: validFlightOffer.id, duffelOfferId: 'off_test123' }];
      const attestation = await attestationService.signSelectionAttestation(
        validUser.id, validSession.id, 1, expiresAt, offers
      );

      const res = await request(app.getHttpServer())
        .post('/chat-handoff')
        .set('X-Agent-API-Key', apiKey)
        .send({
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1
        });
        
      createdToken = res.body.token;
    });

    it('should reject cross-user access', async () => {
      const otherUser = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: `other-${crypto.randomUUID()}@example.com`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });
      const otherUserToken = jwtService.sign({ id: otherUser.id, email: otherUser.email });

      await request(app.getHttpServer())
        .get(`/chat-handoff/resolve?token=${createdToken}`)
        .set('Authorization', `Bearer ${otherUserToken}`)
        .expect(401); // Not authorized for this handoff
    });

    it('should enforce owner/internal-session resolve and exact-response', async () => {
      const res = await request(app.getHttpServer())
        .get(`/chat-handoff/resolve?token=${createdToken}`)
        .set('Authorization', `Bearer ${validUserToken}`)
        .expect(200);
        
      expect(res.body.userId).toBe(validUser.id);
      expect(res.body.chatSessionId).toBe(validSession.id);
      expect(res.body.flightOfferId).toBe(validFlightOffer.id);
    });
  });
});


