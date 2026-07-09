import { IsInt, Max, Min, IsString, Matches, IsOptional, registerDecorator, ValidationOptions, ValidationArguments } from 'class-validator';
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
          
          // Future date (includes today or strictly after today)
          return parsedDate.getTime() >= todayUtc.getTime();
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a future date in YYYY-MM-DD format`;
        }
      },
    });
  };
}

export class FlightSearchRequestDto {
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'origin must be a 3-character uppercase IATA airport code' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  origin!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'destination must be a 3-character uppercase IATA airport code' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  destination!: string;

  @IsString()
  @IsFutureDateString({ message: 'departureDate must be a future date in YYYY-MM-DD format' })
  departureDate!: string;

  @IsOptional()
  @IsString()
  @IsFutureDateString({ message: 'returnDate must be a future date in YYYY-MM-DD format' })
  returnDate?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(9)
  passengers!: number;
}

export class FlightSegmentDto {
  carrierCode!: string;
  flightNumber!: string;
  operatingCarrier!: string;
  departureAirport!: string;
  departureTerminal!: string | null;
  departureTime!: string;
  arrivalAirport!: string;
  arrivalTerminal!: string | null;
  arrivalTime!: string;
  duration!: number;
  aircraft!: string | null;
}

export class FlightOfferDto {
  id!: string;
  duffelOfferId!: string;
  airline!: string;
  flightNumber!: string;
  departureAirport!: string;
  arrivalAirport!: string;
  departureTime!: string;
  arrivalTime!: string;
  duration!: number;
  stops!: number;
  price!: number;
  currency!: string;
  fareClass!: string | null;
  baggageAllowance!: string | null;
  segments!: FlightSegmentDto[];
  returnSegments!: FlightSegmentDto[] | null;
}

export class FlightSearchResponseMetaDto {
  totalResults!: number;
  searchHash!: string;
  cached!: boolean;
}

export class FlightSearchResponseDto {
  results!: FlightOfferDto[];
  meta!: FlightSearchResponseMetaDto;
}
