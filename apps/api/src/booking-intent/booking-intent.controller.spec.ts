import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateIntentDto } from './dto/create-intent.dto';
import { PassengerType } from '@prisma/client';

describe('CreateIntentDto Validation', () => {
  it('passes validation for valid input', async () => {
    const rawDto = {
      flightOfferId: 'd3b07384-d113-40e5-a3d5-d2258aa41071',
      passengers: [
        {
          type: PassengerType.ADULT,
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '1990-01-01',
          gender: 'male',
          nationality: 'US',
          passportNumber: 'N123456',
          passportExpiry: '2030-01-01',
        },
      ],
    };

    const dto = plainToInstance(CreateIntentDto, rawDto);
    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });

  it('rejects invalid dateOfBirth format', async () => {
    const rawDto = {
      flightOfferId: 'd3b07384-d113-40e5-a3d5-d2258aa41071',
      passengers: [
        {
          type: PassengerType.ADULT,
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '1990/01/01', // Slash separator
          gender: 'male',
          nationality: 'US',
        },
      ],
    };

    const dto = plainToInstance(CreateIntentDto, rawDto);
    const errors = await validate(dto);

    const passengersError = errors.find((e) => e.property === 'passengers');
    const childErrors = passengersError?.children?.[0]?.children ?? [];
    const dobError = childErrors.find((e) => e.property === 'dateOfBirth');
    expect(dobError).toBeDefined();
    expect(Object.keys(dobError!.constraints ?? {})).toContain('matches');
  });

  it('rejects rolled-over calendar dateOfBirth like Feb 30th', async () => {
    const rawDto = {
      flightOfferId: 'd3b07384-d113-40e5-a3d5-d2258aa41071',
      passengers: [
        {
          type: PassengerType.ADULT,
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '1990-02-30', // Feb 30
          gender: 'male',
          nationality: 'US',
        },
      ],
    };

    const dto = plainToInstance(CreateIntentDto, rawDto);
    const errors = await validate(dto);

    const passengersError = errors.find((e) => e.property === 'passengers');
    const childErrors = passengersError?.children?.[0]?.children ?? [];
    const dobError = childErrors.find((e) => e.property === 'dateOfBirth');
    expect(dobError).toBeDefined();
    expect(Object.keys(dobError!.constraints ?? {})).toContain('isDateString');
  });

  it('rejects lowercase nationality country codes', async () => {
    const rawDto = {
      flightOfferId: 'd3b07384-d113-40e5-a3d5-d2258aa41071',
      passengers: [
        {
          type: PassengerType.ADULT,
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '1990-01-01',
          gender: 'male',
          nationality: 'us', // Lowercase nationality
        },
      ],
    };

    const dto = plainToInstance(CreateIntentDto, rawDto);
    const errors = await validate(dto);

    const passengersError = errors.find((e) => e.property === 'passengers');
    const childErrors = passengersError?.children?.[0]?.children ?? [];
    const natError = childErrors.find((e) => e.property === 'nationality');
    expect(natError).toBeDefined();
    expect(Object.keys(natError!.constraints ?? {})).toContain('matches');
  });
});
