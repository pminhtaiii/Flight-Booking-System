import { IsInt, Max, Min, IsString, Matches, registerDecorator, ValidationOptions, ValidationArguments, IsOptional } from 'class-validator';
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
        }
      },
    });
  };
}

export function AtLeastOnePassengerField(validationOptions?: ValidationOptions) {
  return function (object: object) {
    registerDecorator({
      name: 'atLeastOnePassengerField',
      target: object,
      propertyName: '',
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const obj = args.object as { adults?: number; passengers?: unknown[] };
          const hasAdults = obj.adults !== undefined && obj.adults !== null;
          const hasPassengers = obj.passengers !== undefined && obj.passengers !== null;
          return hasAdults || hasPassengers;
        },
        defaultMessage() {
          return 'At least one of adults or passengers must be provided';
        }
      },
    });
  };
}

@AtLeastOnePassengerField()
export class FlightSearchQueryDto {
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'origin must be a 3-character uppercase IATA airport code' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  origin!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'destination must be a 3-character uppercase IATA airport code' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  destination!: string;

  @IsString()
  @IsFutureDateString({ message: 'date must be a future date in YYYY-MM-DD format' })
  date!: string;

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
}

