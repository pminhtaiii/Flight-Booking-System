import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { PassengerType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BookingReadinessRequestDto } from './booking-readiness.dto';

describe('BookingReadinessRequestDto', () => {
  it('rejects non-whitelisted source fields through the global validation pipe', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });

    await expect(
      pipe.transform(
        {
          flightOfferId: '11111111-1111-4111-8111-111111111111',
          passengers: [
            {
              offerPassengerId: 'pas_001',
              passengerType: PassengerType.ADULT,
              source: {
                type: 'inline',
                givenName: 'Ada',
                travelerProfileId: '11111111-1111-4111-8111-111111111111',
              },
            },
          ],
        },
        {
          type: 'body',
          metatype: BookingReadinessRequestDto,
        },
      ),
    ).rejects.toMatchObject({
      response: {
        statusCode: 400,
        message: expect.arrayContaining(['passengers.0.source.travelerProfileId should not exist']),
      },
    });
  });

  it('rejects traveler_profile sources that mix inline fields', async () => {
    const dto = plainToInstance(BookingReadinessRequestDto, {
      flightOfferId: '11111111-1111-4111-8111-111111111111',
      passengers: [
        {
          offerPassengerId: 'pas_001',
          passengerType: PassengerType.ADULT,
          source: {
            type: 'traveler_profile',
            travelerProfileId: '11111111-1111-4111-8111-111111111111',
            givenName: 'Ada',
          },
        },
      ],
    });

    const errors = await validate(dto);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: 'passengers',
        }),
      ]),
    );
  });
});
