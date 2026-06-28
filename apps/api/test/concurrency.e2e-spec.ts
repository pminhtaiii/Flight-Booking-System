import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

describe('Concurrency and Stress (E2E)', () => {
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

    await request(app.getHttpServer())
      .post('/auth/test/reset-lockout')
      .send({ clearAll: true })
      .expect(200);

    await request(app.getHttpServer()).post('/auth/register').send({
      email: 'concurrency@example.com',
      password: 'Password123!',
    });
  });

  it('should handle 100 concurrent failed login attempts from the same IP, locking out and remaining stable', async () => {
    const ip = '9.9.9.9';
    const attempts = Array.from({ length: 100 });

    const promises = attempts.map(() =>
      request(app.getHttpServer()).post('/auth/login').set('X-Forwarded-For', ip).send({
        email: 'concurrency@example.com',
        password: 'WrongPassword!',
      }),
    );

    const responses = await Promise.all(promises);

    let count401 = 0;
    let count429 = 0;
    let otherCount = 0;

    for (const res of responses) {
      if (res.status === 401) {
        count401++;
      } else if (res.status === 429) {
        count429++;
      } else {
        otherCount++;
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[Concurrency Results] 401: ${count401}, 429: ${count429}, other: ${otherCount}`);

    expect(otherCount).toBe(0);
    expect(count401).toBe(5);
    expect(count429).toBe(95);

    // Verify lockout state is active
    const lockoutRes = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({
        email: 'concurrency@example.com',
        password: 'Password123!',
      })
      .expect(429);

    expect(lockoutRes.body.code).toBe('auth_locked');
  });
});
