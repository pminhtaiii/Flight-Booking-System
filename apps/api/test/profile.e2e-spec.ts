import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { ConfigService } from '@nestjs/config';

describe('Traveler Profile (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let user: any;
  let authToken: string;

  beforeAll(async () => {
    process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string) => {
          if (key === 'FEATURE_FLAG_BOOKING_READINESS') {
            return 'true';
          }
          return process.env[key];
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health'] });
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
    // Clear Database tables before each test
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.cancellationRefundObligation.deleteMany({});
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


    // Create a default test user
    user = await prisma.user.create({
      data: {
        email: 'traveler@example.com',
        password: 'Password123!',
      },
    });

    authToken = jwtService.sign({ id: user.id, email: user.email });
  });

  it('GET /api/profile returns 200 with profileId null and empty sections if no profile exists', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body).toEqual({
      profileId: null,
      identity: null,
      contact: null,
      travelDocument: null,
      preferences: null,
      revision: 0,
    });
  });

  it('GET /api/profile returns the traveler profile if it exists', async () => {
    await prisma.travelerProfile.create({
      data: {
        userId: user.id,
        givenName: 'Jane',
        familyName: 'Doe',
        dateOfBirth: new Date('1992-05-15'),
        gender: 'female',
        title: 'Mrs',
        email: 'jane.doe@example.com',
        phoneCountryCode: '+1',
        phoneNumber: '5559876543',
        revision: 2,
      },
    });

    const res = await request(app.getHttpServer())
      .get('/api/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.profileId).toBeDefined();
    expect(res.body.identity).toEqual({
      givenName: 'Jane',
      middleName: null,
      familyName: 'Doe',
      dateOfBirth: '1992-05-15',
      gender: 'female',
      title: 'Mrs',
    });
    expect(res.body.contact).toEqual({
      email: 'jane.doe@example.com',
      phoneCountryCode: '+1',
      phoneNumber: '5559876543',
    });
    expect(res.body.revision).toBe(2);
  });

  it('PATCH /api/profile updates the profile if revision matches and returns updated profile', async () => {
    const profile = await prisma.travelerProfile.create({
      data: {
        userId: user.id,
        revision: 1,
      },
    });

    const updatePayload = {
      expectedRevision: 1,
      identity: {
        givenName: 'Jane',
        familyName: 'Doe',
        dateOfBirth: '1992-05-15',
        gender: 'female',
        title: 'Mrs',
      },
      contact: {
        email: 'jane.doe@example.com',
        phoneCountryCode: '+1',
        phoneNumber: '5559876543',
      },
    };

    const res = await request(app.getHttpServer())
      .patch('/api/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .send(updatePayload)
      .expect(200);

    expect(res.body.identity.givenName).toBe('Jane');
    expect(res.body.contact.email).toBe('jane.doe@example.com');
    expect(res.body.revision).toBe(2);

    // Check database state
    const dbProfile = await prisma.travelerProfile.findUnique({
      where: { userId: user.id },
    });
    expect(dbProfile?.revision).toBe(2);
    expect(dbProfile?.givenName).toBe('Jane');
  });

  it('PATCH /api/profile returns 409 conflict on stale revision', async () => {
    await prisma.travelerProfile.create({
      data: {
        userId: user.id,
        revision: 2,
      },
    });

    const updatePayload = {
      expectedRevision: 1, // Client sends outdated revision
      identity: {
        givenName: 'Jane',
        familyName: 'Doe',
        dateOfBirth: '1992-05-15',
        gender: 'female',
        title: 'Mrs',
      },
    };

    await request(app.getHttpServer())
      .patch('/api/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .send(updatePayload)
      .expect(409);
  });

  it('No plaintext passport/expiry or contact details in database or audits', async () => {
    // 1. Update the profile with sensitive travel document details
    const profile = await prisma.travelerProfile.create({
      data: {
        userId: user.id,
        revision: 1,
      },
    });

    const updatePayload = {
      expectedRevision: 1,
      travelDocument: {
        documentType: 'passport',
        passportNumber: 'AB123456',
        passportExpiry: '2030-08-01',
        issuingCountry: 'US',
        nationality: 'US',
      },
    };

    await request(app.getHttpServer())
      .patch('/api/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .send(updatePayload)
      .expect(200);

    // 2. Query database directly and verify no plaintext passport number exists
    const dbProfile = await prisma.travelerProfile.findUnique({
      where: { userId: user.id },
    });
    expect(dbProfile).toBeDefined();
    expect(dbProfile?.passportNumber).not.toBe('AB123456');
    expect(dbProfile?.passportNumber).toContain(':'); // should be aes-256-gcm format iv:authTag:ciphertext

    // 3. Query audit logs and check for PII
    const logs = await prisma.auditLog.findMany({
      where: { userId: user.id },
    });
    expect(logs.length).toBeGreaterThan(0);

    for (const log of logs) {
      const metadataStr = JSON.stringify(log.metadata);
      // Ensure no plaintext sensitive data leakage in log metadata
      expect(metadataStr).not.toContain('AB123456');
      expect(metadataStr).not.toContain('2030-08-01');
      expect(metadataStr).not.toContain(profile.id); // profile ID should not be logged in structured metadata
    }
  });
});



