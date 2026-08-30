import {
  IsInt,
  Max,
  Min,
  IsString,
  Matches,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
  IsOptional,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export function IsFutureDateString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isFutureDateString',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

          const parsedDate = new Date(`${value}T00:00:00Z`);
          if (isNaN(parsedDate.getTime())) return false;

          const todayUtc = new Date();
          todayUtc.setUTCHours(0, 0, 0, 0);

          return parsedDate.getTime() > todayUtc.getTime();
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a future date in YYYY-MM-DD format`;
        },
      },
    });
  };
}

export function AtLeastOnePassengerField(validationOptions?: ValidationOptions) {
  // eslint-disable-next-line @typescript-eslint/ban-types
  return function (object: Function) {
    registerDecorator({
      name: 'atLeastOnePassengerField',
      target: object,
      propertyName: '',
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const obj = args.object as { adults?: number; passengers?: number };
          const hasAdults = obj.adults !== undefined && obj.adults !== null;
          const hasPassengers = obj.passengers !== undefined && obj.passengers !== null;
          return hasAdults || hasPassengers;
        },
        defaultMessage() {
          return 'At least one of adults or passengers must be provided';
        },
      },
    });
  };
}

export function AtLeastOneDateField(validationOptions?: ValidationOptions) {
  // eslint-disable-next-line @typescript-eslint/ban-types
  return function (object: Function) {
    registerDecorator({
      name: 'atLeastOneDateField',
      target: object,
      propertyName: '',
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const obj = args.object as { date?: string; departureDate?: string };
          const hasDate = obj.date !== undefined && obj.date !== null && obj.date !== '';
          const hasDepartureDate =
            obj.departureDate !== undefined &&
            obj.departureDate !== null &&
            obj.departureDate !== '';
          return hasDate || hasDepartureDate;
        },
        defaultMessage() {
          return 'At least one of date or departureDate must be provided';
        },
      },
    });
  };
}

@AtLeastOnePassengerField()
@AtLeastOneDateField()
export class FlightSearchQueryDto {
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'origin must be a 3-character uppercase IATA airport code' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  origin!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'destination must be a 3-character uppercase IATA airport code',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  destination!: string;

  @IsOptional()
  @IsString()
  @IsFutureDateString({ message: 'date must be a future date in YYYY-MM-DD format' })
  date?: string;

  @IsOptional()
  @IsString()
  @IsFutureDateString({ message: 'departureDate must be a future date in YYYY-MM-DD format' })
  departureDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(9)
  adults?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(9)
  passengers?: number;

  @IsOptional()
  @IsString()
  cabinClass?: string;
}
