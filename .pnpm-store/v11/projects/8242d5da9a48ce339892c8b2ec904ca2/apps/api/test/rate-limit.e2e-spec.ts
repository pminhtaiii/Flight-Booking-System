import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

describe('Rate Limit and Lockout (E2E)', () => {
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
    // Clear databases and reset lockouts
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});

    // Clear lockouts for all IPs by calling the test reset endpoint
    await request(app.getHttpServer())
      .post('/auth/test/reset-lockout')
      .send({ clearAll: true })
      .expect(200);

    // Setup a user to log in
    await request(app.getHttpServer()).post('/auth/register').send({
      email: 'lockout@example.com',
      password: 'Password123!',
    });
  });

  it('should block login after 5 failed attempts with 429 and auth_locked payload', async () => {
    const ip = '1.2.3.4';

    // 5 failed login attempts
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({
          email: 'lockout@example.com',
          password: 'WrongPassword!',
        })
        .expect(401);
    }

    // 6th attempt should trigger lockout
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({
        email: 'lockout@example.com',
        password: 'WrongPassword!',
      })
      .expect(429);

    expect(res.body.code).toBe('auth_locked');
    expect(res.body.message).toEqual(expect.any(String));
    expect(res.body.retryAfterSeconds).toBeGreaterThanOrEqual(58);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('should escalate lockout duration (60s -> 120s -> 240s -> 480s -> 480s) on subsequent violations', async () => {
    const ip = '2.3.4.5';

    // Helper to trigger a lockout from 0 failed attempts
    const triggerLockout = async () => {
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .set('X-Forwarded-For', ip)
          .send({ email: 'lockout@example.com', password: 'WrongPassword!' });
      }
    };

    // Lockout level 1
    await triggerLockout();
    let res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'lockout@example.com', password: 'WrongPassword!' })
      .expect(429);
    expect(res.body.retryAfterSeconds).toBeGreaterThanOrEqual(58);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(60);

    // Call test reset endpoint to clear active lockout key but preserve escalation level
    await request(app.getHttpServer())
      .post('/auth/test/reset-lockout')
      .set('X-Forwarded-For', ip)
      .send({ keepEscalation: true })
      .expect(200);

    // Lockout level 2
    // Triggering lockout escalation: next failed attempt during lockout or immediate next failure triggers Level 2
    res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'lockout@example.com', password: 'WrongPassword!' })
      .expect(429);
    expect(res.body.retryAfterSeconds).toBeGreaterThanOrEqual(118);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(120);

    // Clear active lockout key to proceed
    await request(app.getHttpServer())
      .post('/auth/test/reset-lockout')
      .set('X-Forwarded-For', ip)
      .send({ keepEscalation: true })
      .expect(200);

    // Lockout level 3 (240s)
    res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'lockout@example.com', password: 'WrongPassword!' })
      .expect(429);
    expect(res.body.retryAfterSeconds).toBeGreaterThanOrEqual(238);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(240);

    // Clear active lockout key to proceed
    await request(app.getHttpServer())
      .post('/auth/test/reset-lockout')
      .set('X-Forwarded-For', ip)
      .send({ keepEscalation: true })
      .expect(200);

    // Lockout level 4 (480s)
    res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'lockout@example.com', password: 'WrongPassword!' })
      .expect(429);
    expect(res.body.retryAfterSeconds).toBeGreaterThanOrEqual(478);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(480);

    // Clear active lockout key to proceed
    await request(app.getHttpServer())
      .post('/auth/test/reset-lockout')
      .set('X-Forwarded-For', ip)
      .send({ keepEscalation: true })
      .expect(200);

    // Lockout level 5 (verify cap does not exceed 480 seconds)
    res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'lockout@example.com', password: 'WrongPassword!' })
      .expect(429);
    expect(res.body.retryAfterSeconds).toBeGreaterThanOrEqual(478);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(480);
  });

  it('should reset lockout state upon successful login', async () => {
    const ip = '3.4.5.6';

    // 4 failed attempts
    for (let i = 0; i < 4; i++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'lockout@example.com', password: 'WrongPassword!' })
        .expect(401);
    }

    // 1 successful login
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'lockout@example.com', password: 'Password123!' })
      .expect(200);

    // Next failed attempt should NOT trigger lockout, as successful login cleared state
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'lockout@example.com', password: 'WrongPassword!' })
      .expect(401);
  });

  it('should partition rate limiting by IP address', async () => {
    const ipA = '4.5.6.7';
    const ipB = '5.6.7.8';

    // Trigger lockout on IP A
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-For', ipA)
        .send({ email: 'lockout@example.com', password: 'WrongPassword!' });
    }
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ipA)
      .send({ email: 'lockout@example.com', password: 'WrongPassword!' })
      .expect(429);

    // IP B should still be allowed to attempt login (gets 401, not 429)
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ipB)
      .send({ email: 'lockout@example.com', password: 'WrongPassword!' })
      .expect(401);
  });
});
