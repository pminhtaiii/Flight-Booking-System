import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
} from 'class-validator';
import { PassengerType } from '@prisma/client';

type PassengerCounts = {
  adults: number;
  children: number;
  infants: number;
};

function countPassengerTypes(passengers: readonly unknown[]): PassengerCounts {
  return passengers.reduce<PassengerCounts>(
    (acc, item) => {
      const passenger = item as { type?: PassengerType };
      if (passenger.type === PassengerType.ADULT) acc.adults += 1;
      if (passenger.type === PassengerType.CHILD) acc.children += 1;
      if (passenger.type === PassengerType.INFANT) acc.infants += 1;
      return acc;
    },
    { adults: 0, children: 0, infants: 0 },
  );
}

function HasValidPassengerMatrix(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'hasValidPassengerMatrix',
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (!Array.isArray(value) || value.length === 0 || value.length > 9) return false;
          const counts = countPassengerTypes(value);
          return counts.adults >= 1 && counts.infants <= counts.adults;
        },
        defaultMessage(args: ValidationArguments) {
          if (!Array.isArray(args.value) || args.value.length === 0) {
            return 'At least one passenger is required';
          }
          if (args.value.length > 9) return 'Total passengers cannot exceed 9';
          const counts = countPassengerTypes(args.value);
          if (counts.adults < 1) return 'At least one adult passenger is required';
          if (counts.infants > counts.adults) return 'Number of infants cannot exceed number of adults';
          return 'Invalid passenger breakdown';
        },
      },
    });
  };
}

export class TravelerProfilePassengerSourceDto {
  @IsIn(['traveler_profile'])
  type!: 'traveler_profile';

  @IsUUID('4')
  travelerProfileId!: string;

  @IsInt()
  @Min(1)
  expectedProfileRevision!: number;
}

export class InlinePassengerSourceDto {
  @IsIn(['inline'])
  type!: 'inline';

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  givenName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  familyName!: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateOfBirth!: string;

  @IsString()
  @Matches(/^(male|female)$/i)
  gender!: string;

  @IsString()
  @Matches(/^[A-Z]{2}$/)
  nationality!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  passportNumber?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  passportExpiry?: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Matches(/^\+\d{1,4}$/)
  phoneCountryCode!: string;

  @IsString()
  @Matches(/^\d{4,20}$/)
  phoneNumber!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  middleName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  documentType?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  issuingCountry?: string;
}

export type PassengerSourceDto = TravelerProfilePassengerSourceDto | InlinePassengerSourceDto;

const LEGACY_PASSENGER_FIELDS = [
  'givenName',
  'familyName',
  'dateOfBirth',
  'gender',
  'nationality',
  'passportNumber',
  'passportExpiry',
] as const;

const LEGACY_REQUIRED_PASSENGER_FIELDS = [
  'givenName',
  'familyName',
  'dateOfBirth',
  'gender',
] as const;

function missingLegacyPassengerFields(passenger: Record<string, unknown>): string[] {
  return LEGACY_REQUIRED_PASSENGER_FIELDS.filter(
    (field) => passenger[field] === undefined || passenger[field] === null,
  );
}

@ValidatorConstraint({ name: 'passengerSource', async: false })
class PassengerSourceConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const passenger = args.object as Record<string, unknown>;
    if (!value || typeof value !== 'object') {
      return missingLegacyPassengerFields(passenger).length === 0;
    }
    const source = value as { type?: unknown };
    const passengerWithFlag = args.object as { useProfile?: unknown };
    if (passengerWithFlag.useProfile !== undefined) return false;
    return source.type === 'traveler_profile' || source.type === 'inline';
  }

  defaultMessage(args: ValidationArguments): string {
    const passenger = args.object as Record<string, unknown> & { useProfile?: unknown };
    if (passenger.useProfile !== undefined) return 'PASSENGER_SOURCE_CONFLICT';
    const missingFields = missingLegacyPassengerFields(passenger);
    return missingFields.length > 0
      ? `PASSENGER_SOURCE_LEGACY_FIELDS: ${missingFields.join(', ')}`
      : 'Passenger source is invalid';
  }
}

@ValidatorConstraint({ name: 'canonicalPassengerShape', async: false })
class CanonicalPassengerShapeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const passenger = args.object as Record<string, unknown>;
    const legacyFields = LEGACY_PASSENGER_FIELDS.filter((field) => passenger[field] !== undefined);
    if (value === undefined || value === null) return missingLegacyPassengerFields(passenger).length === 0;
    return legacyFields.length === 0;
  }

  defaultMessage(args: ValidationArguments): string {
    const passenger = args.object as Record<string, unknown>;
    const legacyFields = LEGACY_PASSENGER_FIELDS.filter((field) => passenger[field] !== undefined);
    const missingFields = missingLegacyPassengerFields(passenger);
    if ((args.value === undefined || args.value === null) && missingFields.length > 0) {
      return `PASSENGER_SOURCE_LEGACY_FIELDS: ${missingFields.join(', ')}`;
    }
    return legacyFields.length > 0
      ? `PASSENGER_SOURCE_LEGACY_FIELDS: ${legacyFields.join(', ')}`
      : 'source is required';
  }
}

@ValidatorConstraint({ name: 'canonicalPassengerMetadata', async: false })
class CanonicalPassengerMetadataConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined || value === null) return true;
    const passenger = args.object as { offerPassengerId?: unknown };
    return typeof passenger.offerPassengerId === 'string' && passenger.offerPassengerId.length <= 100 && /\S/.test(passenger.offerPassengerId);
  }

  defaultMessage(): string {
    return 'offerPassengerId is required and bounded';
  }
}

export class CreateIntentPassengerDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/\S/)
  offerPassengerId!: string;

  @IsEnum(PassengerType)
  type!: PassengerType;

  @IsOptional()
  @IsBoolean()
  useProfile?: boolean;

  // Kept only for the existing singular create flow during the Phase 8
  // compatibility window. Canonical source payloads reject these fields.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  givenName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  familyName?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(male|female)$/i)
  gender?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  nationality?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  passportNumber?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  passportExpiry?: string;

  @ValidateNested()
  @Type(() => Object, {
    discriminator: {
      property: 'type',
      subTypes: [
        { name: 'traveler_profile', value: TravelerProfilePassengerSourceDto },
        { name: 'inline', value: InlinePassengerSourceDto },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  @Validate(PassengerSourceConstraint)
  @Validate(CanonicalPassengerShapeConstraint)
  @Validate(CanonicalPassengerMetadataConstraint)
  source!: PassengerSourceDto;
}

export class CreateIntentDto {
  @IsUUID('4')
  flightOfferId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateIntentPassengerDto)
  @HasValidPassengerMatrix()
  passengers!: CreateIntentPassengerDto[];

  // Advisory context is accepted for correlation only; authoritative create
  // always recomputes scope from server-owned itinerary data.
  @IsOptional()
  @IsIn(['DOMESTIC', 'INTERNATIONAL', 'UNKNOWN'])
  readinessScope?: 'DOMESTIC' | 'INTERNATIONAL' | 'UNKNOWN';
}
