import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { AuditService } from '@/audit/audit.service';
import { LockoutService } from '@/auth/rate-limit/lockout.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

interface CacheServiceWithInternal {
  redisClient: unknown;
}

interface SanitizedUserMetadata {
  usersList: {
    email?: string;
    emailHash?: string;
    credentials: {
      password?: string;
      token?: string;
    };
  }[];
}

interface SanitizedVariantsMetadata {
  emailAddress?: string;
  userEmail?: string;
  emailAddressHash?: string;
  userEmailHash?: string;
}

interface CircularMetadata {
  self: unknown;
}

describe('Adversarial and Edge Case Tests (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let cacheService: CacheService;
  let auditService: AuditService;
  let lockoutService: LockoutService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Enable trust proxy so that X-Forwarded-For from loopback is respected in req.ip
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
    auditService = moduleFixture.get<AuditService>(AuditService);
    lockoutService = moduleFixture.get<LockoutService>(LockoutService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Reset database state before each test
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});

    // Clear lockouts
    await request(app.getHttpServer()).post('/auth/test/reset-lockout').send({ clearAll: true });
  });

  describe('JWT Strategy Status and Existence Verification', () => {
    it('should reject request immediately if user status is set to INACTIVE', async () => {
      // 1. Register user
      const registerRes = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'active-user@example.com',
          password: 'Password123!',
        })
        .expect(201);

      const token = registerRes.body.token;
      const userId = registerRes.body.user.id;

      // Verify user is active and can access /auth/me
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // 2. Set user status to INACTIVE in database
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'INACTIVE' },
      });

      // 3. Verify user is now rejected with 401 Unauthorized
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('should reject request immediately if user record is deleted from database', async () => {
      // 1. Register user
      const registerRes = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'deleted-user@example.com',
          password: 'Password123!',
        })
        .expect(201);

      const token = registerRes.body.token;
      const userId = registerRes.body.user.id;

      // Verify user can access /auth/me
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // 2. Delete user from database
      await prisma.user.delete({
        where: { id: userId },
      });

      // 3. Verify request is rejected with 401 Unauthorized
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  });

  describe('Auth Logic and Security Fixes', () => {
    it('should successfully blacklist token and reject subsequent requests when logging out using lowercase bearer token', async () => {
      // 1. Register and login
      const registerRes = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'lowercase-bearer@example.com',
          password: 'Password123!',
        })
        .expect(201);
      const token = registerRes.body.token;

      // 2. Logout using lowercase bearer
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `bearer ${token}`)
        .expect(204);

      // 3. Verify subsequent request is unauthorized
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('should block login attempts for INACTIVE users', async () => {
      // 1. Register a user
      const registerRes = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'inactive-login@example.com',
          password: 'Password123!',
        })
        .expect(201);
      const userId = registerRes.body.user.id;

      // 2. Set status to INACTIVE
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'INACTIVE' },
      });

      // 3. Try to login
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'inactive-login@example.com',
          password: 'Password123!',
        })
        .expect(401);
    });

    it('should reject extremely long passwords in login with 400 Bad Request', async () => {
      const longPassword = 'a'.repeat(129);
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'some-user@example.com',
          password: longPassword,
        })
        .expect(400);
    });


  });

  describe('CacheService Fallback Mechanism (Redis Offline simulation)', () => {
    let originalRedisClient: unknown;

    beforeEach(() => {
      originalRedisClient = (cacheService as unknown as CacheServiceWithInternal).redisClient;
    });

    afterEach(() => {
      (cacheService as unknown as CacheServiceWithInternal).redisClient = originalRedisClient;
    });

    it('should fall back to in-memory store and allow LockoutService to function when Redis throws errors', async () => {
      // 1. Simulate Redis being offline by injecting a mock client that throws errors for every method
      const failingRedis = {
        get: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
        set: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
        del: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
        incr: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
        ttl: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
        keys: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
        expire: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
      };

      (cacheService as unknown as CacheServiceWithInternal).redisClient = failingRedis;

      // 2. Verify that CacheService functions via fallback in-memory store
      await cacheService.set('test-fallback-key', 'fallback-value', 10);
      const val = await cacheService.get('test-fallback-key');
      expect(val).toBe('fallback-value');

      // 3. Test that LockoutService works properly using fallback
      const ip = '9.9.9.9';

      // Initially not locked out
      let check = await lockoutService.isLockedOut(ip);
      expect(check.locked).toBe(false);

      // Trigger lockout attempts
      for (let i = 0; i < 4; i++) {
        const attempt = await lockoutService.recordFailedAttempt(ip);
        expect(attempt.locked).toBe(false);
      }

      // 5th failed attempt should trigger lockout
      const finalAttempt = await lockoutService.recordFailedAttempt(ip);
      expect(finalAttempt.locked).toBe(true);
      expect(finalAttempt.retryAfterSeconds).toBe(60);

      // Verify isLockedOut returns true
      check = await lockoutService.isLockedOut(ip);
      expect(check.locked).toBe(true);
      expect(check.retryAfterSeconds).toBeGreaterThan(0);

      // Reset lockout state
      await lockoutService.resetLockoutState(ip);
      check = await lockoutService.isLockedOut(ip);
      expect(check.locked).toBe(false);
    });

    it('should not return expired keys when listing keys in the fallback cache', async () => {
      // Simulate offline Redis to force fallback to in-memory store
      (cacheService as unknown as CacheServiceWithInternal).redisClient = null;

      await cacheService.set('auth:expired:1', 'val1', 1);
      await cacheService.set('auth:expired:2', 'val2', 100);

      // Wait 1.5 seconds for key 1 to expire
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const keys = await cacheService.keys('auth:expired:*');
      expect(keys).toContain('auth:expired:2');
      expect(keys).not.toContain('auth:expired:1');
    });

    it('should not reset/extend the TTL on subsequent increments in the fallback cache', async () => {
      // Simulate offline Redis to force fallback to in-memory store
      (cacheService as unknown as CacheServiceWithInternal).redisClient = null;

      const key = 'auth:incr-ttl-test';
      // First increment set TTL to 10 seconds
      await cacheService.incr(key, 10);
      const ttl1 = await cacheService.getTtl(key);
      expect(ttl1).toBeGreaterThan(0);

      // Wait 2 seconds
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Subsequent increment
      await cacheService.incr(key, 10);
      const ttl2 = await cacheService.getTtl(key);

      // The remaining TTL should be less than 9 seconds (not reset back to 10)
      expect(ttl2).toBeLessThan(9);
    });
  });

  describe('Audit Log Sanitization and Robustness Boundaries', () => {
    it('should recursively sanitize sensitive data (email and password) inside arrays in metadata', async () => {
      const email = 'nested-email@example.com';
      const password = 'NestedPassword123!';

      // Create an audit log with complex metadata containing arrays and nested objects
      await auditService.createLog(prisma, {
        userId: null,
        action: 'test_adversarial_sanitization',
        resourceType: 'User',
        metadata: {
          usersList: [
            {
              email: email,
              credentials: {
                password: password,
                token: 'nested-token-value',
              },
            },
          ],
        },
      });

      const log = await prisma.auditLog.findFirst({
        where: { action: 'test_adversarial_sanitization' },
      });

      expect(log).toBeDefined();
      const metadata = log?.metadata as unknown as SanitizedUserMetadata;
      expect(metadata).toBeDefined();

      const nestedUser = metadata.usersList[0];
      // Email should be hashed and original email deleted
      expect(nestedUser.email).toBeUndefined();
      expect(nestedUser.emailHash).toBeDefined();
      expect(nestedUser.emailHash).not.toBe(email);

      // Password and Token should be completely deleted
      expect(nestedUser.credentials.password).toBeUndefined();
      expect(nestedUser.credentials.token).toBeUndefined();
    });

    it('should sanitize variations of email keys (emailAddress, userEmail) from audit log metadata', async () => {
      await auditService.createLog(prisma, {
        userId: null,
        action: 'test_variants',
        resourceType: 'User',
        metadata: {
          emailAddress: 'test-email@example.com',
          userEmail: 'another-email@example.com',
        },
      });

      const log = await prisma.auditLog.findFirst({
        where: { action: 'test_variants' },
      });
      expect(log).toBeDefined();
      const metadata = log?.metadata as unknown as SanitizedVariantsMetadata;
      expect(metadata.emailAddress).toBeUndefined();
      expect(metadata.userEmail).toBeUndefined();
      expect(metadata.emailAddressHash).toBeDefined();
      expect(metadata.userEmailHash).toBeDefined();
    });

    it('should throw circular reference error on stringify when metadata is circular, or fail safely if handled', async () => {
      const circularMetadata: Record<string, unknown> = { name: 'circular' };
      circularMetadata.self = circularMetadata;

      let threw = false;
      try {
        await auditService.createLog(prisma, {
          userId: null,
          action: 'circular_test',
          resourceType: 'User',
          metadata: circularMetadata,
        });
      } catch (err) {
        threw = true;
      }
      // Verified circular reference safety handles it safely without throwing
      expect(threw).toBe(false);

      const log = await prisma.auditLog.findFirst({
        where: { action: 'circular_test' },
      });
      expect(log).toBeDefined();
      expect((log?.metadata as unknown as CircularMetadata).self).toBe('[Circular]');
    });
  });

  describe('Trace/Correlation ID Header Validation and Truncation', () => {
    it('should successfully handle normal requests with valid X-Trace-Id / X-Correlation-Id', async () => {
      const traceId = 'normal-trace-id-123';
      const correlationId = 'normal-correlation-id-456';

      await request(app.getHttpServer())
        .post('/auth/register')
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .send({
          email: 'normal-headers@example.com',
          password: 'Password123!',
        })
        .expect(201);

      const log = await prisma.auditLog.findFirst({
        where: { action: 'registration' },
      });

      expect(log).toBeDefined();
      expect(log?.traceId).toBe(traceId);
      expect(log?.correlationId).toBe(correlationId);
    });

    it('should not throw exception if X-Trace-Id or X-Correlation-Id is missing (generate UUIDs)', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'missing-headers@example.com',
          password: 'Password123!',
        })
        .expect(201);

      const log = await prisma.auditLog.findFirst({
        where: { action: 'registration' },
      });

      expect(log).toBeDefined();
      expect(log?.traceId).toBeDefined();
      expect(log?.correlationId).toBeDefined();
      // Ensure they look like UUIDs
      expect(log?.traceId.length).toBe(36);
      expect(log?.correlationId.length).toBe(36);
    });
  });
});
