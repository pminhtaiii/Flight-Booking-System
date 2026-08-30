import {
  IsString,
  IsInt,
  Min,
  ValidateNested,
  IsObject,
  IsOptional,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FlightSearchQueryDto } from './flight-search-query.dto';

export function AtLeastOneVersionField(validationOptions?: ValidationOptions) {
  // eslint-disable-next-line @typescript-eslint/ban-types
  return function (object: Function) {
    registerDecorator({
      name: 'atLeastOneVersionField',
      target: object,
      propertyName: '',
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const obj = args.object as { proposedSnapshotVersion?: number; proposedVersion?: number };
          const hasV1 =
            obj.proposedSnapshotVersion !== undefined && obj.proposedSnapshotVersion !== null;
          const hasV2 = obj.proposedVersion !== undefined && obj.proposedVersion !== null;
          return hasV1 || hasV2;
        },
        defaultMessage() {
          return 'At least one of proposedSnapshotVersion or proposedVersion must be provided';
        },
      },
    });
  };
}

@AtLeastOneVersionField()
export class AttestedFlightSearchDto {
  @IsString()
  chatSessionId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  proposedSnapshotVersion?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  proposedVersion?: number;

  @IsObject()
  @ValidateNested()
  @Type(() => FlightSearchQueryDto)
  search!: FlightSearchQueryDto;
}

export interface AttestedFlightSearchResultDto {
  flightOfferId: string;
  duffelOfferId: string;
  offerExpiresAt: string;
  airline: string;
  flightNumber: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTime: string;
  arrivalTime: string;
  duration: number;
  stops: number;
  price: number;
  currency: string;
  fareClass: string | null;
  baggageAllowance: string | null;
}

export interface AttestedFlightSearchResponseDto {
  selectionAttestation: string;
  snapshotVersion: number;
  snapshotExpiresAt: string;
  results: AttestedFlightSearchResultDto[];
}
