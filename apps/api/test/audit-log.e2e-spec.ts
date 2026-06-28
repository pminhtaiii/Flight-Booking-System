import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import * as crypto from 'crypto';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

describe('Audit Log (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
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
    await prisma.user.deleteMany({});
  });

  it('should create audit logs for registration, login, failed login, and logout', async () => {
    const email = 'audit@example.com';
    const password = 'Password123!';
    const ip = '1.2.3.4';

    // 1. Registration
    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Forwarded-For', ip)
      .send({ email, password })
      .expect(201);

    const userId = regRes.body.user.id;
    const regLogs = await prisma.auditLog.findMany({ where: { userId, action: 'registration' } });
    expect(regLogs.length).toBe(1);

    // 2. Failed Login
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'WrongPassword!' })
      .expect(401);

    const failedLogs = await prisma.auditLog.findMany({ where: { action: 'failed_login' } });
    expect(failedLogs.length).toBe(1);

    // 3. Successful Login
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password })
      .expect(200);

    const loginToken = loginRes.body.token;
    const loginLogs = await prisma.auditLog.findMany({ where: { userId, action: 'login' } });
    expect(loginLogs.length).toBe(1);

    // 4. Logout
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${loginToken}`)
      .expect(204);

    const logoutLogs = await prisma.auditLog.findMany({ where: { userId, action: 'logout' } });
    expect(logoutLogs.length).toBe(1);
  });

  it('should ensure audit log metadata is PII-free (no plaintext passwords, emails, etc.)', async () => {
    const email = 'sensitive@example.com';
    const password = 'Password123!';

    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);

    const logs = await prisma.auditLog.findMany({});
    expect(logs.length).toBeGreaterThan(0);

    for (const log of logs) {
      const metadata = log.metadata ? JSON.parse(JSON.stringify(log.metadata)) : {};

      // Email check
      expect(metadata.email).toBeUndefined();
      expect(JSON.stringify(metadata)).not.toContain(email);

      // Password check
      expect(metadata.password).toBeUndefined();
      expect(metadata.rawPassword).toBeUndefined();
      expect(metadata.plainTextPassword).toBeUndefined();
      expect(JSON.stringify(metadata)).not.toContain(password);
    }
  });

  it('should store client IP as a SHA-256 hash in audit log metadata rather than raw IP', async () => {
    const ip = '192.168.1.100';
    const expectedHash = crypto.createHash('sha256').update(ip).digest('hex');

    await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Forwarded-For', ip)
      .send({ email: 'iphash@example.com', password: 'Password123!' })
      .expect(201);

    const log = await prisma.auditLog.findFirst({
      where: { action: 'registration' },
    });

    expect(log).toBeDefined();
    const metadata = log?.metadata as Record<string, unknown> | null;
    expect(metadata).toBeDefined();
    expect(metadata?.ipAddress).toBe(expectedHash);
    expect(metadata?.ipAddress).not.toBe(ip);
  });

  it('should propagate correlation ID / trace ID from headers to audit log metadata', async () => {
    const traceId = 'test-trace-12345';

    await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Correlation-Id', traceId)
      .send({ email: 'trace@example.com', password: 'Password123!' })
      .expect(201);

    const log = await prisma.auditLog.findFirst({
      where: { action: 'registration' },
    });

    expect(log).toBeDefined();
    const metadata = log?.metadata as Record<string, unknown> | null;
    expect(metadata?.correlationId).toBe(traceId);
  });

  it('should rollback audit log entry if the database transaction fails (e.g. duplicate user ID constraint)', async () => {
    // We register the first user
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'duplicate@example.com', password: 'Password123!' })
      .expect(201);

    const initialUserCount = await prisma.user.count();
    const initialLogCount = await prisma.auditLog.count();

    // Attempting registration again with duplicate email will trigger constraint failure
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'duplicate@example.com', password: 'Password123!' })
      .expect(409);

    // Verify transaction rollback: count should remain the same
    const finalUserCount = await prisma.user.count();
    const finalLogCount = await prisma.auditLog.count();

    expect(finalUserCount).toBe(initialUserCount);
    // Any registration audit log attempted during the second registration should have been rolled back
    expect(finalLogCount).toBe(initialLogCount);
  });
});
