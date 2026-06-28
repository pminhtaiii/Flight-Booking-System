import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

describe('Authentication (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

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
    jwtService = moduleFixture.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clear Database tables before each test to ensure isolation
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});
  });

  describe('POST /auth/register', () => {
    const validRegistration = {
      email: 'TestUser@Example.com',
      password: 'Password123!',
    };

    it('should register a user, normalize email, hash password, write audit log and return a 24h JWT token', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send(validRegistration)
        .expect(201);

      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('user');
      expect(res.body.user.email).toBe('testuser@example.com'); // normalized to lowercase
      expect(res.body.user).toHaveProperty('id');

      // Verify token expiration is 24 hours
      const payloadBase64 = res.body.token.split('.')[1];
      const payloadJson = Buffer.from(payloadBase64, 'base64').toString('utf8');
      const decoded = JSON.parse(payloadJson) as { exp: number; iat: number };
      const tokenDuration = decoded.exp - decoded.iat;
      expect(tokenDuration).toBe(24 * 60 * 60); // 24 hours in seconds

      // Verify user is created in database with normalized email and hashed password
      const dbUser = await prisma.user.findUnique({
        where: { email: 'testuser@example.com' },
      });
      expect(dbUser).toBeDefined();
      expect(dbUser!.password).not.toBe(validRegistration.password); // hashed
      expect(dbUser!.password.length).toBeGreaterThan(20);

      // Verify audit log entry
      const auditLogs = await prisma.auditLog.findMany({
        where: { userId: dbUser!.id },
      });
      expect(auditLogs.length).toBe(1);
      expect(auditLogs[0].action).toBe('registration');

      // Ensure no PII in audit log metadata
      const metadata = auditLogs[0].metadata as Record<string, unknown> | null;
      if (metadata) {
        expect(metadata.email).toBeUndefined();
        expect(metadata.password).toBeUndefined();
      }
    });

    it('should reject registration if email is already taken with a safe 409 Conflict', async () => {
      await request(app.getHttpServer()).post('/auth/register').send(validRegistration).expect(201);

      // Duplicate registration
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send(validRegistration)
        .expect(409);

      // Generic message to avoid user enumeration
      expect(res.body.message).toMatch(/conflict|exists|already/i);
    });

    it('should reject passwords that do not meet strength policy (min 8 chars, uppercase, lowercase, digit, special char)', async () => {
      const weakPasswords = [
        'pwd123!', // < 8 characters
        'password123!', // no uppercase
        'PASSWORD123!', // no lowercase
        'Password!', // no digit
        'Password123', // no special char
      ];

      for (const password of weakPasswords) {
        await request(app.getHttpServer())
          .post('/auth/register')
          .send({ email: 'test@example.com', password })
          .expect(400);
      }
    });

    it('should reject email or password that exceeds max length boundaries', async () => {
      const longEmail = 'a'.repeat(243) + '@example.com'; // 255 chars
      const longPassword = 'P1!' + 'a'.repeat(126); // 129 chars

      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: longEmail, password: 'Password123!' })
        .expect(400);

      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'test@example.com', password: longPassword })
        .expect(400);
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      // Setup a registered user
      await request(app.getHttpServer()).post('/auth/register').send({
        email: 'Registered@Example.com',
        password: 'Password123!',
      });
    });

    it('should authenticate user, update lastLogin, write login audit log and return JWT', async () => {
      const beforeLogin = new Date();

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'registered@example.com',
          password: 'Password123!',
        })
        .expect(200);

      expect(res.body).toHaveProperty('token');

      const dbUser = await prisma.user.findUnique({
        where: { email: 'registered@example.com' },
      });
      expect(dbUser!.lastLogin).toBeDefined();
      expect(new Date(dbUser!.lastLogin!).getTime()).toBeGreaterThanOrEqual(beforeLogin.getTime());

      // Verify audit log
      const auditLog = await prisma.auditLog.findFirst({
        where: { userId: dbUser!.id, action: 'login' },
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.metadata).toBeDefined();
    });

    it('should authenticate case-insensitively', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'REGISTERED@EXAMPLE.COM',
          password: 'Password123!',
        })
        .expect(200);
    });

    it('should return 401 Unauthorized for invalid credentials with generic message', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'registered@example.com',
          password: 'WrongPassword!',
        })
        .expect(401);

      expect(res.body.message).toBe('Invalid email or password');
    });

    it('should return 400 Bad Request for empty credentials', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: '', password: '' })
        .expect(400);
    });
  });

  describe('GET /auth/me', () => {
    let token: string;
    let userId: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer()).post('/auth/register').send({
        email: 'session@example.com',
        password: 'Password123!',
      });
      token = res.body.token;
      userId = res.body.user.id;
    });

    it('should return user profile for a valid token', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toEqual({
        id: userId,
        email: 'session@example.com',
      });
    });

    it('should reject request when token is missing', async () => {
      await request(app.getHttpServer()).get('/auth/me').expect(401);
    });

    it('should reject request when token signature is tampered', async () => {
      const tamperedToken = token + 'tampered';
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${tamperedToken}`)
        .expect(401);
    });

    it('should reject request when token is expired', async () => {
      // Generate an expired token signed with the correct key
      const expiredToken = jwtService.sign(
        { id: userId, email: 'session@example.com' },
        { expiresIn: '-1s' },
      );

      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);
    });
  });

  describe('POST /auth/logout', () => {
    let token: string;
    let userId: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer()).post('/auth/register').send({
        email: 'logout@example.com',
        password: 'Password123!',
      });
      token = res.body.token;
      userId = res.body.user.id;
    });

    it('should register logout audit log, invalidate token client-side and return 204 No Content', async () => {
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      // Verify audit log
      const auditLog = await prisma.auditLog.findFirst({
        where: { userId, action: 'logout' },
      });
      expect(auditLog).toBeDefined();

      // Subsequent access with the same token should be rejected (assuming blacklisting/session invalidation is implemented)
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  });
});
