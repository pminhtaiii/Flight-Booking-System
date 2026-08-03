process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { DuffelService } from '@/duffel/duffel.service';
import { EncryptionService } from '@/common/encryption.service';
import { PassengerType, Prisma } from '@prisma/client';

type BootedApp = {
  app: INestApplication;
  prisma: PrismaService;
  jwtService: JwtService;
  duffelService: DuffelService;
  encryptionService: EncryptionService;
};

type AuthUser = {
  id: string;
  email: string;
  token: string;
};

type ReadinessPassenger =
  | {
      offerPassengerId: string;
      passengerType: PassengerType;
      source: {
        type: 'traveler_profile';
        travelerProfileId: string;
      };
    }
  | {
      offerPassengerId: string;
      passengerType: PassengerType;
      source: {
        type: 'inline';
        givenName?: string;
        middleName?: string | null;
        familyName?: string;
        dateOfBirth?: string;
        gender?: string;
        title?: string;
        email?: string;
        phoneCountryCode?: string;
        phoneNumber?: string;
        documentType?: string;
        passportNumber?: string;
        passportExpiry?: string;
        issuingCountry?: string;
        nationality?: string;
      };
    };

async function bootstrapReadinessApp(featureFlag: 'true' | 'false'): Promise<BootedApp> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(ConfigService)
    .useValue({
      get: (key: string) => {
        if (key === 'FEATURE_FLAG_BOOKING_READINESS') {
          return featureFlag;
        }

        return process.env[key];
      },
    })
    .compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();

  return {
    app,
    prisma: moduleFixture.get(PrismaService),
    jwtService: moduleFixture.get(JwtService),
    duffelService: moduleFixture.get(DuffelService),
    encryptionService: moduleFixture.get(EncryptionService),
  };
}

async function clearApiState(prisma: PrismaService): Promise<void> {
  await prisma.ledgerEntry.deleteMany({});
  await prisma.paymentEvent.deleteMany({});
  await prisma.refund.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.booking.deleteMany({});
  await prisma.bookingIntentPassenger.deleteMany({});
  await prisma.ancillarySelection.deleteMany({});
  await prisma.bookingIntent.deleteMany({});
  await prisma.travelerProfile.deleteMany({});
  await prisma.flightOffer.deleteMany({});
  await prisma.airport.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.paymentMethod.deleteMany({});
  await prisma.idempotencyKey.deleteMany({});
  await prisma.user.deleteMany({});
}

async function createUser(prisma: PrismaService, jwtService: JwtService, email: string): Promise<AuthUser> {
  const user = await prisma.user.create({
    data: {
      email,
      password: 'Password123!',
      status: 'ACTIVE',
    },
  });

  return {
    id: user.id,
    email: user.email,
    token: jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '24h' }),
  };
}

async function seedAirport(prisma: PrismaService, iataCode: string, country: string): Promise<void> {
  await prisma.airport.create({
    data: {
      iataCode,
      icaoCode: `${iataCode}X`,
      name: `${iataCode} Test Airport`,
      city: `${iataCode} City`,
      country,
      region: 'TEST',
      latitude: 10,
      longitude: 10,
      elevation: 0,
      type: 'LARGE_AIRPORT',
      timezone: 'UTC',
    },
  });
}

async function seedReadinessOffer(
  prisma: PrismaService,
  overrides: Partial<Prisma.FlightOfferCreateInput> = {},
): Promise<{ id: string }> {
  const offer = await prisma.flightOffer.create({
    data: {
      searchHash: 'booking-readiness-search-hash',
      duffelOfferId: 'off_readiness_123',
      rawOffer: {
        expires_at: '2030-08-25T10:00:00Z',
        passengers: [{ id: 'pas_001', type: 'adult' }],
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HAN' },
                arriving_at: '2030-08-20T09:30:00Z',
              },
            ],
          },
        ],
      },
      origin: 'SGN',
      destination: 'HAN',
      departureDate: new Date('2030-08-20T00:00:00.000Z'),
      adults: 1,
      children: 0,
      infants: 0,
      cabinClass: 'economy',
      price: new Prisma.Decimal(120),
      currency: 'USD',
      ...overrides,
    },
    select: { id: true },
  });

  return offer;
}

async function seedTravelerProfile(
  prisma: PrismaService,
  encryptionService: EncryptionService,
  userId: string,
  overrides: Partial<Prisma.TravelerProfileCreateInput> = {},
): Promise<{ id: string; revision: number }> {
  const profile = await prisma.travelerProfile.create({
    data: {
      user: { connect: { id: userId } },
      givenName: 'Ada',
      middleName: null,
      familyName: 'Lovelace',
      dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
      gender: 'female',
      title: 'Ms',
      email: 'ada@example.com',
      phoneCountryCode: '+84',
      phoneNumber: '987654321',
      documentType: 'passport',
      passportNumber: `v1:${encryptionService.encrypt('P1234567')}`,
      passportExpiry: new Date('2035-12-31T00:00:00.000Z'),
      passportExpiryCiphertext: encryptionService.encrypt('2035-12-31'),
      issuingCountry: 'VN',
      nationality: 'VN',
      revision: 3,
      ...overrides,
    },
    select: {
      id: true,
      revision: true,
    },
  });

  return profile;
}

function readinessPayload(flightOfferId: string, passengers: ReadinessPassenger[]) {
  return {
    flightOfferId,
    passengers,
  };
}

function ownedProfilePassenger(travelerProfileId: string): ReadinessPassenger {
  return {
    offerPassengerId: 'pas_001',
    passengerType: PassengerType.ADULT,
    source: {
      type: 'traveler_profile',
      travelerProfileId,
    },
  };
}

function inlinePassenger(overrides: Partial<ReadinessPassenger & { source: Record<string, unknown> }> = {}): ReadinessPassenger {
  return {
    offerPassengerId: 'pas_001',
    passengerType: PassengerType.ADULT,
    source: {
      type: 'inline',
      givenName: 'Inline',
      middleName: null,
      familyName: 'Traveler',
      dateOfBirth: '1992-03-04',
      gender: 'male',
      title: 'Mr',
      email: 'inline@example.com',
      phoneCountryCode: '+1',
      phoneNumber: '5551112222',
      documentType: 'passport',
      passportNumber: 'X1234567',
      passportExpiry: '2034-04-01',
      issuingCountry: 'US',
      nationality: 'US',
      ...(overrides.source ?? {}),
    },
    ...overrides,
  } as ReadinessPassenger;
}

describe('Booking Readiness (E2E RED)', () => {
  jest.setTimeout(30000);

  describe('feature disabled', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let jwtService: JwtService;

    beforeAll(async () => {
      const booted = await bootstrapReadinessApp('false');
      app = booted.app;
      prisma = booted.prisma;
      jwtService = booted.jwtService;
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(async () => {
      await clearApiState(prisma);
    });

    it('returns 404 FEATURE_DISABLED before touching data reads', async () => {
      const user = await createUser(prisma, jwtService, 'disabled-readiness@example.com');

      const response = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${user.token}`)
        .set('x-trace-id', 'trace-disabled-red')
        .set('x-correlation-id', 'corr-disabled-red')
        .send(
          readinessPayload('11111111-1111-4111-8111-111111111111', [
            inlinePassenger(),
          ]),
        );

      expect(response.status).toBe(404);
      expect(response.body).toEqual(
        expect.objectContaining({
          code: 'FEATURE_DISABLED',
        }),
      );
      expect(await prisma.bookingIntent.count()).toBe(0);
      expect(await prisma.bookingIntentPassenger.count()).toBe(0);
    });
  });

  describe('feature enabled', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let jwtService: JwtService;
    let duffelService: DuffelService;
    let encryptionService: EncryptionService;
    let primaryUser: AuthUser;
    let foreignUser: AuthUser;

    beforeAll(async () => {
      const booted = await bootstrapReadinessApp('true');
      app = booted.app;
      prisma = booted.prisma;
      jwtService = booted.jwtService;
      duffelService = booted.duffelService;
      encryptionService = booted.encryptionService;
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(async () => {
      await clearApiState(prisma);
      primaryUser = await createUser(prisma, jwtService, 'readiness-owner@example.com');
      foreignUser = await createUser(prisma, jwtService, 'readiness-foreign@example.com');
    });

    it('returns a complete domestic readiness result with no-store headers, no writes, and no Duffel calls', async () => {
      await seedAirport(prisma, 'SGN', 'VN');
      await seedAirport(prisma, 'HAN', 'VN');
      const offer = await seedReadinessOffer(prisma);
      const profile = await seedTravelerProfile(prisma, encryptionService, primaryUser.id);
      const duffelSpy = jest.spyOn((duffelService as any).duffel.offers, 'get');

      const response = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .set('x-trace-id', 'trace-domestic-red')
        .set('x-correlation-id', 'corr-domestic-red')
        .send(readinessPayload(offer.id, [ownedProfilePassenger(profile.id)]));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(response.body).toEqual(
        expect.objectContaining({
          scope: 'DOMESTIC',
          ready: true,
          passengers: [
            expect.objectContaining({
              passengerOrdinal: 1,
              passengerType: PassengerType.ADULT,
              profileRevision: profile.revision,
              ready: true,
            }),
          ],
        }),
      );
      expect(JSON.stringify(response.body)).not.toContain(profile.id);
      expect(JSON.stringify(response.body)).not.toContain('Ada');
      expect(await prisma.bookingIntent.count()).toBe(0);
      expect(await prisma.bookingIntentPassenger.count()).toBe(0);
      expect(duffelSpy).not.toHaveBeenCalled();
    });

    it('returns an international readiness result with blocking document gaps and advisory passport warnings', async () => {
      await seedAirport(prisma, 'SGN', 'VN');
      await seedAirport(prisma, 'NRT', 'JP');
      const offer = await seedReadinessOffer(prisma, {
        destination: 'NRT',
        rawOffer: {
          expires_at: '2030-08-25T10:00:00Z',
          passengers: [{ id: 'pas_001', type: 'adult' }],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'NRT' },
                  arriving_at: '2030-08-20T09:30:00Z',
                },
              ],
            },
          ],
        },
      });

      const response = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(
          readinessPayload(offer.id, [
            inlinePassenger({
              source: {
                documentType: 'passport',
                passportNumber: 'X1234567',
                passportExpiry: '2030-08-21',
                issuingCountry: '',
                nationality: '',
              },
            }),
          ]),
        );

      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          scope: 'INTERNATIONAL',
          ready: false,
          passengers: [
            expect.objectContaining({
              passengerOrdinal: 1,
              ready: false,
              sections: expect.arrayContaining([
                expect.objectContaining({
                  name: 'travel_document',
                  fields: expect.arrayContaining([
                    expect.objectContaining({
                      name: 'passportExpiry',
                      status: 'warning',
                      reason: 'PASSPORT_VALIDITY_REQUIRES_VERIFICATION',
                      blocking: false,
                    }),
                    expect.objectContaining({
                      name: 'issuingCountry',
                      status: 'missing',
                      reason: 'REQUIRED',
                      blocking: true,
                    }),
                    expect.objectContaining({
                      name: 'nationality',
                      status: 'missing',
                      reason: 'REQUIRED',
                      blocking: true,
                    }),
                  ]),
                }),
              ]),
            }),
          ],
        }),
      );
    });

    it('returns 200 UNKNOWN when airport-country reference data is missing and still creates no rows', async () => {
      await seedAirport(prisma, 'SGN', 'VN');
      const offer = await seedReadinessOffer(prisma, {
        destination: 'XXX',
        rawOffer: {
          expires_at: '2030-08-25T10:00:00Z',
          passengers: [{ id: 'pas_001', type: 'adult' }],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'XXX' },
                  arriving_at: '2030-08-20T09:30:00Z',
                },
              ],
            },
          ],
        },
      });

      const response = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(readinessPayload(offer.id, [inlinePassenger()]));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          scope: 'UNKNOWN',
          ready: false,
          passengers: [
            expect.objectContaining({
              sections: expect.arrayContaining([
                expect.objectContaining({
                  name: 'itinerary',
                  fields: expect.arrayContaining([
                    expect.objectContaining({
                      name: 'scope',
                      status: 'unknown',
                      reason: 'AIRPORT_COUNTRY_UNAVAILABLE',
                      blocking: true,
                    }),
                  ]),
                }),
              ]),
            }),
          ],
        }),
      );
      expect(await prisma.bookingIntent.count()).toBe(0);
      expect(await prisma.bookingIntentPassenger.count()).toBe(0);
    });

    it('rejects foreign profiles and invalid passenger mappings with safe 422 responses', async () => {
      await seedAirport(prisma, 'SGN', 'VN');
      await seedAirport(prisma, 'HAN', 'VN');
      const offer = await seedReadinessOffer(prisma);
      const foreignProfile = await seedTravelerProfile(prisma, encryptionService, foreignUser.id);

      const foreignProfileResponse = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(readinessPayload(offer.id, [ownedProfilePassenger(foreignProfile.id)]));

      expect(foreignProfileResponse.status).toBe(422);
      expect(foreignProfileResponse.body).toEqual(
        expect.objectContaining({
          code: 'PASSENGER_MAPPING_INVALID',
        }),
      );
      expect(JSON.stringify(foreignProfileResponse.body)).not.toContain(foreignProfile.id);

      const invalidMappingResponse = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(
          readinessPayload(offer.id, [
            {
              offerPassengerId: 'pas_missing',
              passengerType: PassengerType.ADULT,
              source: inlinePassenger().source,
            },
          ]),
        );

      expect(invalidMappingResponse.status).toBe(422);
      expect(invalidMappingResponse.body).toEqual(
        expect.objectContaining({
          code: 'PASSENGER_MAPPING_INVALID',
        }),
      );
    });

    it('maps missing offers, expired offers, and malformed stored offers to safe HTTP outcomes', async () => {
      const missingOfferResponse = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(readinessPayload('11111111-1111-4111-8111-111111111111', [inlinePassenger()]));

      expect(missingOfferResponse.status).toBe(404);
      expect(missingOfferResponse.body).toEqual(
        expect.objectContaining({
          code: 'OFFER_NOT_FOUND',
        }),
      );

      const expiredOffer = await seedReadinessOffer(prisma, {
        rawOffer: {
          expires_at: '2026-08-02T10:00:00Z',
          passengers: [{ id: 'pas_001', type: 'adult' }],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  arriving_at: '2030-08-20T09:30:00Z',
                },
              ],
            },
          ],
        },
      });

      const expiredOfferResponse = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(readinessPayload(expiredOffer.id, [inlinePassenger()]));

      expect(expiredOfferResponse.status).toBe(409);
      expect(expiredOfferResponse.body).toEqual(
        expect.objectContaining({
          code: 'OFFER_EXPIRED',
        }),
      );

      const malformedOffer = await seedReadinessOffer(prisma, {
        rawOffer: {
          expires_at: '2030-08-25T10:00:00Z',
          passengers: [{ id: 'pas_001', type: 'adult' }],
          slices: [{ segments: [{ origin: null, destination: null, arriving_at: null }] }],
        },
      });

      const malformedOfferResponse = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(readinessPayload(malformedOffer.id, [inlinePassenger()]));

      expect(malformedOfferResponse.status).toBe(503);
      expect(malformedOfferResponse.body).toEqual(
        expect.objectContaining({
          code: 'READINESS_DEPENDENCY_UNAVAILABLE',
        }),
      );
    });

    it('keeps existing singular booking intent routes functional while the canonical readiness route is added', async () => {
      const singularOffer = await seedReadinessOffer(prisma);
      const duffelSpy = jest.spyOn((duffelService as any).duffel.offers, 'get').mockResolvedValue({
        data: {
          id: 'off_readiness_123',
          total_amount: '120.00',
          total_currency: 'USD',
          expires_at: '2030-08-25T10:00:00Z',
        },
      });

      const createResponse = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send({
          flightOfferId: singularOffer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'Legacy',
              familyName: 'Traveler',
              dateOfBirth: '1990-01-01',
              gender: 'male',
            },
          ],
        });

      expect(createResponse.status).toBe(201);
      expect(createResponse.body).toEqual(
        expect.objectContaining({
          intentId: expect.any(String),
          status: 'PENDING',
        }),
      );

      const getResponse = await request(app.getHttpServer())
        .get(`/api/bookings/intent/${createResponse.body.intentId}`)
        .set('Authorization', `Bearer ${primaryUser.token}`);

      expect(getResponse.status).toBe(200);

      const prefillResponse = await request(app.getHttpServer())
        .get('/api/bookings/intent/prefill')
        .set('Authorization', `Bearer ${primaryUser.token}`);

      expect(prefillResponse.status).toBe(200);
      duffelSpy.mockRestore();
    });
  });
});
