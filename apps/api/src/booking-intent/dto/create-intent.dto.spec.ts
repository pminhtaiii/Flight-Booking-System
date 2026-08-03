import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { PassengerType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateIntentDto } from './create-intent.dto';

const profileId = '11111111-1111-4111-8111-111111111111';
const offerId = '22222222-2222-4222-8222-222222222222';

function inlineSource(overrides: Record<string, unknown> = {}) {
  return {
    type: 'inline',
    givenName: 'Ada',
    familyName: 'Lovelace',
    dateOfBirth: '1815-12-10',
    gender: 'female',
    nationality: 'GB',
    email: 'ada@example.test',
    phoneCountryCode: '+44',
    phoneNumber: '7000000000',
    title: 'MS',
    ...overrides,
  };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    flightOfferId: offerId,
    passengers: [
      {
        offerPassengerId: 'pas_001',
        type: PassengerType.ADULT,
        source: {
          type: 'traveler_profile',
          travelerProfileId: profileId,
          expectedProfileRevision: 3,
        },
      },
    ],
    ...overrides,
  };
}

async function validationErrors(payload: Record<string, unknown>) {
  const dto = plainToInstance(CreateIntentDto, payload);
  return validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    validationError: { target: false, value: false },
  });
}

describe('CreateIntentDto Phase 7 passenger sources', () => {
  it('accepts a traveler_profile source with a positive expected revision', async () => {
    await expect(validationErrors(validPayload())).resolves.toHaveLength(0);
  });

  it('accepts a complete inline source', async () => {
    await expect(
      validationErrors(
        validPayload({
          passengers: [
            {
              offerPassengerId: 'pas_001',
              type: PassengerType.ADULT,
              source: inlineSource(),
            },
          ],
        }),
      ),
    ).resolves.toHaveLength(0);
  });

  it('requires and validates expectedProfileRevision for traveler_profile sources', async () => {
    const missing = await validationErrors(
      validPayload({
        passengers: [
          {
            offerPassengerId: 'pas_001',
            type: PassengerType.ADULT,
            source: { type: 'traveler_profile', travelerProfileId: profileId },
          },
        ],
      }),
    );
    const invalid = await validationErrors(
      validPayload({
        passengers: [
          {
            offerPassengerId: 'pas_001',
            type: PassengerType.ADULT,
            source: { type: 'traveler_profile', travelerProfileId: profileId, expectedProfileRevision: 0 },
          },
        ],
      }),
    );

    expect(JSON.stringify(missing)).toContain('expectedProfileRevision');
    expect(JSON.stringify(invalid)).toContain('expectedProfileRevision');
  });

  it('requires the source discriminator and rejects unknown source types', async () => {
    const missing = await validationErrors(
      validPayload({ passengers: [{ offerPassengerId: 'pas_001', type: PassengerType.ADULT, source: {} }] }),
    );
    const unknown = await validationErrors(
      validPayload({
        passengers: [
          { offerPassengerId: 'pas_001', type: PassengerType.ADULT, source: { type: 'legacy' } },
        ],
      }),
    );

    expect(JSON.stringify(missing)).toContain('source');
    expect(JSON.stringify(unknown)).toContain('source');
  });

  it('enforces adult, infant, and maximum passenger matrix rules', async () => {
    const noAdult = await validationErrors(
      validPayload({
        passengers: [{ offerPassengerId: 'pas_001', type: PassengerType.CHILD, source: inlineSource() }],
      }),
    );
    const tooManyInfants = await validationErrors(
      validPayload({
        passengers: [
          { offerPassengerId: 'pas_001', type: PassengerType.ADULT, source: inlineSource() },
          { offerPassengerId: 'pas_002', type: PassengerType.INFANT, source: inlineSource() },
          { offerPassengerId: 'pas_003', type: PassengerType.INFANT, source: inlineSource() },
        ],
      }),
    );
    const tooManyPassengers = await validationErrors(
      validPayload({
        passengers: Array.from({ length: 10 }, (_, index) => ({
          offerPassengerId: `pas_${index + 1}`,
          type: index === 0 ? PassengerType.ADULT : PassengerType.CHILD,
          source: inlineSource(),
        })),
      }),
    );

    expect(noAdult.length).toBeGreaterThan(0);
    expect(tooManyInfants.length).toBeGreaterThan(0);
    expect(tooManyPassengers.length).toBeGreaterThan(0);
  });

  it('requires a bounded offerPassengerId and rejects flat legacy fields', async () => {
    const errors = await validationErrors(
      validPayload({
        passengers: [
          {
            offerPassengerId: '',
            type: PassengerType.ADULT,
            givenName: 'Ada',
            source: inlineSource(),
          },
        ],
      }),
    );

    expect(JSON.stringify(errors)).toContain('offerPassengerId');
    expect(JSON.stringify(errors)).toContain('givenName');
  });

  it('rejects useProfile together with source using the safe conflict code', async () => {
    const errors = await validationErrors(
      validPayload({
        passengers: [
          {
            offerPassengerId: 'pas_001',
            type: PassengerType.ADULT,
            useProfile: true,
            source: inlineSource(),
          },
        ],
      }),
    );

    expect(JSON.stringify(errors)).toContain('PASSENGER_SOURCE_CONFLICT');
  });

  it('does not include submitted PII in validation errors', async () => {
    const secret = 'passport-secret-12345';
    const errors = await validationErrors(
      validPayload({
        passengers: [
          {
            offerPassengerId: 'pas_001',
            type: PassengerType.ADULT,
            source: inlineSource({ passportNumber: secret, email: 'private@example.test', phoneNumber: '0909090909' }),
          },
        ],
      }),
    );

    expect(JSON.stringify(errors)).not.toContain(secret);
    expect(JSON.stringify(errors)).not.toContain('private@example.test');
    expect(JSON.stringify(errors)).not.toContain('0909090909');
  });

  it('exposes the conflict through the same safe ValidationPipe boundary', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

    await expect(
      pipe.transform(
        validPayload({
          passengers: [
            { offerPassengerId: 'pas_001', type: PassengerType.ADULT, useProfile: true, source: inlineSource() },
          ],
        }),
        { type: 'body', metatype: CreateIntentDto },
      ),
    ).rejects.toMatchObject({ response: { statusCode: 400, message: expect.arrayContaining([expect.stringContaining('PASSENGER_SOURCE_CONFLICT')]) } });
  });
});
