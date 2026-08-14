import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { spawn } from 'child_process';
import * as path from 'path';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import * as crypto from 'crypto';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { createChatStreamRequest } from '../../web/lib/chatStream';

import { JwtService } from '@nestjs/jwt';

jest.setTimeout(120_000);

type AgentHandoffProbeInput = {
  baseUrl: string;
  token: string;
  attestation: string;
  offerIndex: number;
  traceId: string;
  correlationId: string;
};

type AgentStreamProbeInput = AgentHandoffProbeInput & {
  sessionId: string;
};

type ObservedGatewayTrace = {
  path: string;
  traceId?: string;
  correlationId?: string;
};

function runAgentHandoffProbe(
  input: AgentHandoffProbeInput,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === 'win32' ? 'uv.exe' : 'uv',
      ['run', '--frozen', 'python', 'tests/helpers/run_nestjs_handoff_probe.py'],
      {
        cwd: path.resolve(__dirname, '../../agent'),
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    child.once('error', () => resolve(-1));
    child.once('close', (code) => resolve(code ?? -1));
    child.stdin.end(JSON.stringify(input));
  });
}

function runAgentStreamProbe(
  input: AgentStreamProbeInput,
  environment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; output: string; diagnostic: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === 'win32' ? 'uv.exe' : 'uv',
      ['run', '--frozen', 'python', 'tests/helpers/run_fastapi_nestjs_trace_probe.py'],
      {
        cwd: path.resolve(__dirname, '../../agent'),
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', () =>
      resolve({ exitCode: -1, output: 'probe_spawn_failed', diagnostic: 'spawn_failed' }),
    );
    child.once('close', (code) => {
      const stderrText = Buffer.concat(stderr).toString('utf8');
      const diagnostic = [
        'nestjs_session_creation_failed',
        'nestjs_memory_fetch_failed',
        'user_message_persistence_failed',
      ].find((marker) => stderrText.includes(marker)) ?? 'none';
      resolve({
        exitCode: code ?? -1,
        output: Buffer.concat(stdout).toString('utf8'),
        diagnostic,
      });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

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
  let nestjsBaseUrl: string;
  
  let validUser: any;
  let validUserToken: string;
  let validSession: any;
  let validFlightOffer: any;
  const observedGatewayTraces: ObservedGatewayTrace[] = [];
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
    app.use(
      (
        req: { originalUrl?: string; headers: Record<string, string | string[] | undefined> },
        _res: unknown,
        next: () => void,
      ) => {
        const requestPath = req.originalUrl ?? '';
        if (requestPath.includes('agent-gateway') || requestPath.includes('chat-handoff')) {
          const traceHeader = req.headers['x-trace-id'];
          const correlationHeader = req.headers['x-correlation-id'];
          observedGatewayTraces.push({
            path: requestPath,
            traceId: typeof traceHeader === 'string' ? traceHeader : undefined,
            correlationId: typeof correlationHeader === 'string' ? correlationHeader : undefined,
          });
        }
        next();
      },
    );
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('NestJS E2E server did not expose a loopback port');
    }
    nestjsBaseUrl = `http://127.0.0.1:${address.port}`;
    
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

    validUserToken = jwtService.sign(
      { sub: validUser.id, id: validUser.id, jti: crypto.randomUUID(), email: validUser.email },
      { issuer: 'booking-systems-api', audience: 'booking-systems-clients' },
    );

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
    observedGatewayTraces.length = 0;
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

    validUserToken = jwtService.sign(
      { sub: validUser.id, id: validUser.id, jti: crypto.randomUUID(), email: validUser.email },
      { issuer: 'booking-systems-api', audience: 'booking-systems-clients' },
    );

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

    it('should persist linked opaque trace telemetry without sensitive metadata', async () => {
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const offers = [{ flightOfferId: validFlightOffer.id, duffelOfferId: 'off_test123' }];
      const attestation = await attestationService.signSelectionAttestation(
        validUser.id, validSession.id, 1, expiresAt, offers,
      );
      const traceId = `chat_${'a1'.repeat(16)}`;
      const correlationId = `chat_${'b2'.repeat(16)}`;

      const created = await request(app.getHttpServer())
        .post('/chat-handoff')
        .set('X-Agent-API-Key', apiKey)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .send({ selectionAttestationHash: attestation, selectedOfferIndex: 1 })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/chat-handoff/resolve?token=${created.body.token}`)
        .set('Authorization', `Bearer ${validUserToken}`)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .expect(200);

      const auditRows = await prisma.auditLog.findMany({
        where: {
          action: { in: ['chat_handoff_created', 'chat_handoff_resolved'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });

      expect(auditRows).toHaveLength(2);
      for (const row of auditRows) {
        expect(row.traceId).toBe(traceId);
        expect(row.correlationId).toBe(correlationId);
        const metadata = JSON.stringify(row.metadata);
        expect(metadata).not.toContain('off_test123');
        expect(metadata).not.toContain(validUser.id);
        expect(metadata).not.toContain(validSession.id);
        expect(metadata).not.toContain(created.body.token);
        expect(metadata).not.toContain('selectionAttestationHash');
        expect(metadata).toMatch(/"operation":"handoff_(create|resolve)"/);
      }
    });

    it('propagates agent trace and correlation IDs into NestJS telemetry and audit', async () => {
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const offers = [{ flightOfferId: validFlightOffer.id, duffelOfferId: 'off_test123' }];
      const attestation = await attestationService.signSelectionAttestation(
        validUser.id, validSession.id, 1, expiresAt, offers,
      );
      const traceId = `chat_${'c3'.repeat(16)}`;
      const correlationId = `chat_${'d4'.repeat(16)}`;
      const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      const exitCode = await runAgentHandoffProbe(
        {
          baseUrl: nestjsBaseUrl,
          token: validUserToken,
          attestation,
          offerIndex: 1,
          traceId,
          correlationId,
        },
        {
          PATH: process.env.PATH,
          PATHEXT: process.env.PATHEXT,
          SystemRoot: process.env.SystemRoot,
          COMSPEC: process.env.COMSPEC,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          UV_CACHE_DIR: path.resolve(__dirname, '../../../.uv-cache'),
          PYTHONPATH: path.resolve(__dirname, '../../agent/src'),
          JWT_SECRET: process.env.JWT_SECRET ?? 'test_secret',
          NESTJS_API_URL: nestjsBaseUrl,
          AGENT_SERVICE_API_KEY: apiKey,
          CLAIM_TOKEN_SECRET: 'test-claim-token-secret',
          FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'true',
          FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'true',
        },
      );

      expect(exitCode).toBe(0);
      const telemetryEvent = loggerLog.mock.calls
        .map(([message]) => {
          if (typeof message !== 'string' || !message.startsWith('{')) return null;
          try {
            const parsed: unknown = JSON.parse(message);
            return typeof parsed === 'object' && parsed !== null ? parsed : null;
          } catch {
            return null;
          }
        })
        .find((event) => event !== null && 'operation' in event && event.operation === 'handoff_create');
      loggerLog.mockRestore();

      expect(telemetryEvent).toMatchObject({
        operation: 'handoff_create',
        trace_id: traceId,
        correlation_id: correlationId,
      });

      const auditRow = await prisma.auditLog.findFirst({
        where: { action: 'chat_handoff_created', traceId, correlationId },
      });
      expect(auditRow).toBeDefined();
      const metadata = JSON.stringify(auditRow?.metadata);
      expect(metadata).not.toContain(attestation);
      expect(metadata).not.toContain(validUser.id);
      expect(metadata).not.toContain(validSession.id);
      expect(metadata).not.toContain(validFlightOffer.id);
      expect(metadata).not.toContain('off_test123');
      expect(metadata).not.toContain('http');
    });

    it('preserves one browser-generated trace pair through FastAPI and NestJS', async () => {
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const offers = [{ flightOfferId: validFlightOffer.id, duffelOfferId: 'off_test123' }];
      const attestation = await attestationService.signSelectionAttestation(
        validUser.id,
        validSession.id,
        1,
        expiresAt,
        offers,
      );
      const browserToken = jwtService.sign(
        {
          sub: validUser.id,
          id: validUser.id,
          jti: `trace-probe-${crypto.randomUUID()}`,
          email: validUser.email,
        },
        {
          issuer: 'booking-systems-api',
          audience: 'booking-systems-clients',
        },
      );
      const previousAgentUrl = process.env.NEXT_PUBLIC_AGENT_URL;
      process.env.NEXT_PUBLIC_AGENT_URL = 'http://agent.invalid';
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));
      let browserHeaders: Headers;
      try {
        await createChatStreamRequest({
          message: 'continue with selected flight',
          sessionId: validSession.id,
          token: browserToken,
        });
        browserHeaders = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
      } finally {
        fetchSpy.mockRestore();
        if (previousAgentUrl === undefined) {
          delete process.env.NEXT_PUBLIC_AGENT_URL;
        } else {
          process.env.NEXT_PUBLIC_AGENT_URL = previousAgentUrl;
        }
      }
      const traceId = browserHeaders.get('X-Trace-Id');
      const correlationId = browserHeaders.get('X-Correlation-Id');
      expect(traceId).toMatch(/^chat_[a-f0-9]{32}$/);
      expect(correlationId).toMatch(/^chat_[a-f0-9]{32}$/);
      expect(traceId).not.toBe(correlationId);
      if (!traceId || !correlationId) {
        throw new Error('browser_trace_headers_missing');
      }

      const probe = await runAgentStreamProbe(
        {
          baseUrl: nestjsBaseUrl,
          token: browserToken,
          sessionId: validSession.id,
          attestation,
          offerIndex: 1,
          traceId,
          correlationId,
        },
        {
          PATH: process.env.PATH,
          PATHEXT: process.env.PATHEXT,
          SystemRoot: process.env.SystemRoot,
          COMSPEC: process.env.COMSPEC,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          UV_CACHE_DIR: path.resolve(__dirname, '../../../.uv-cache'),
          PYTHONPATH: path.resolve(__dirname, '../../agent/src'),
          JWT_SECRET: process.env.JWT_SECRET ?? 'test_secret',
          JWT_ISSUER: 'booking-systems-api',
          JWT_AUDIENCE: 'booking-systems-clients',
          NESTJS_API_URL: nestjsBaseUrl,
          AGENT_SERVICE_API_KEY: apiKey,
          CLAIM_TOKEN_SECRET: 'test-claim-token-secret',
          FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'true',
          FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'true',
        },
      );

      const observedStages = {
        access: observedGatewayTraces.some(({ path: requestPath }) => requestPath.includes('chat/access/check')),
        memory: observedGatewayTraces.some(({ path: requestPath }) => requestPath.includes('/memory')),
        turn: observedGatewayTraces.some(({ path: requestPath }) => requestPath.includes('/turns')),
        handoff: observedGatewayTraces.some(({ path: requestPath }) => requestPath.includes('chat-handoff')),
      };
      expect({ probe, observedStages }).toEqual({
        probe: { exitCode: 0, output: '{"ok":true}', diagnostic: 'none' },
        observedStages: { access: true, memory: true, turn: true, handoff: true },
      });
      const tracedRequests = observedGatewayTraces.filter(
        ({ traceId: observedTraceId, correlationId: observedCorrelationId }) =>
          observedTraceId === traceId && observedCorrelationId === correlationId,
      );
      expect(tracedRequests.length).toBeGreaterThanOrEqual(4);
      expect(tracedRequests.some(({ path: requestPath }) => requestPath.includes('chat/access/check'))).toBe(true);
      expect(tracedRequests.some(({ path: requestPath }) => requestPath.includes('/memory'))).toBe(true);
      expect(tracedRequests.some(({ path: requestPath }) => requestPath.includes('/turns'))).toBe(true);
      expect(tracedRequests.some(({ path: requestPath }) => requestPath.includes('chat-handoff'))).toBe(true);

      const auditRow = await prisma.auditLog.findFirst({
        where: { action: 'chat_handoff_created', traceId, correlationId },
      });
      expect(auditRow).not.toBeNull();
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
        .expect(404); // Not authorized for this handoff (opaque 404 to prevent token probing)
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


