import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
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
import type { BookingReadinessResult } from '@shared/types';

@ValidatorConstraint({ name: 'handoffSource', async: false })
export class HandoffSourceConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as any;
    const hasOffer = typeof obj.flightOfferId === 'string' && obj.flightOfferId.trim().length > 0;
    const hasToken = typeof obj.handoffToken === 'string' && obj.handoffToken.trim().length > 0;
    return (hasOffer && !hasToken) || (!hasOffer && hasToken);
  }

  defaultMessage(): string {
    return 'Exactly one of flightOfferId or handoffToken must be provided';
  }
}

export function HasValidHandoffSource(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    registerDecorator({
      name: 'hasValidHandoffSource',
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      validator: HandoffSourceConstraint,
    });
  };
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_CODE_PATTERN = /^(?:[A-Z]{2})?$/;
const PHONE_COUNTRY_CODE_PATTERN = /^\+\d{1,4}$/;
const PHONE_NUMBER_PATTERN = /^\d{4,15}$/;
const PASSPORT_NUMBER_PATTERN = /^[A-Za-z0-9]{3,50}$/;

type ReadinessPassengerSourceRecord = Record<string, unknown>;

const TRAVELER_PROFILE_SOURCE_KEYS = new Set([
  'type',
  'travelerProfileId',
  'expectedProfileRevision',
]);

const INLINE_SOURCE_KEYS = new Set([
  'type',
  'givenName',
  'middleName',
  'familyName',
  'dateOfBirth',
  'gender',
  'nationality',
  'passportNumber',
  'passportExpiry',
  'email',
  'phoneCountryCode',
  'phoneNumber',
  'title',
  'documentType',
  'issuingCountry',
]);

function isRecord(value: unknown): value is ReadinessPassengerSourceRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: ReadinessPassengerSourceRecord,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function countPassengerTypes(passengers: readonly unknown[]): {
  adults: number;
  children: number;
  infants: number;
} {
  return passengers.reduce<{
    adults: number;
    children: number;
    infants: number;
  }>(
    (counts, passenger) => {
      if (!isRecord(passenger)) {
        return counts;
      }

      if (passenger.passengerType === PassengerType.ADULT) {
        counts.adults += 1;
      } else if (passenger.passengerType === PassengerType.CHILD) {
        counts.children += 1;
      } else if (passenger.passengerType === PassengerType.INFANT) {
        counts.infants += 1;
      }

      return counts;
    },
    { adults: 0, children: 0, infants: 0 },
  );
}

function HasValidReadinessPassengerMatrix(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    registerDecorator({
      name: 'hasValidPassengerMatrix',
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (!Array.isArray(value) || value.length < 1 || value.length > 9) {
            return false;
          }

          const counts = countPassengerTypes(value);
          return counts.adults >= 1 && counts.infants <= counts.adults;
        },
        defaultMessage(args: ValidationArguments): string {
          if (!Array.isArray(args.value) || args.value.length === 0) {
            return 'At least one passenger is required';
          }

          const counts = countPassengerTypes(args.value);
          if (args.value.length > 9) {
            return 'Total passengers cannot exceed 9';
          }
          if (counts.adults < 1) {
            return 'At least one adult passenger is required';
          }
          if (counts.infants > counts.adults) {
            return 'Number of infants cannot exceed number of adults';
          }

          return 'Invalid passenger breakdown';
        },
      },
    });
  };
}

@ValidatorConstraint({ name: 'bookingReadinessPassengerSource', async: false })
class BookingReadinessPassengerSourceConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!isRecord(value) || typeof value.type !== 'string') {
      return false;
    }

    if (value.type === 'traveler_profile') {
      return hasOnlyKeys(value, TRAVELER_PROFILE_SOURCE_KEYS);
    }

    if (value.type === 'inline') {
      return hasOnlyKeys(value, INLINE_SOURCE_KEYS);
    }

    return false;
  }

  defaultMessage(args: ValidationArguments): string {
    if (isRecord(args.value)) {
      const allowedKeys =
        args.value.type === 'traveler_profile' ? TRAVELER_PROFILE_SOURCE_KEYS : INLINE_SOURCE_KEYS;
      const unexpectedKey = Object.keys(args.value).find((key) => !allowedKeys.has(key));
      if (unexpectedKey) {
        return `source.${unexpectedKey} should not exist`;
      }
    }

    return 'source must contain exactly one supported passenger source variant';
  }
}

function HasValidReadinessPassengerSource(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    registerDecorator({
      name: 'bookingReadinessPassengerSource',
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      validator: BookingReadinessPassengerSourceConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'uniqueReadinessOfferPassengerIds', async: false })
class UniqueReadinessOfferPassengerIdsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) {
      return true;
    }

    const ids = value
      .filter(isRecord)
      .map((passenger) => passenger.offerPassengerId)
      .filter((id): id is string => typeof id === 'string');

    return new Set(ids).size === ids.length;
  }

  defaultMessage(): string {
    return 'offerPassengerId values must be unique';
  }
}

function HasUniqueReadinessOfferPassengerIds(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    registerDecorator({
      name: 'uniqueReadinessOfferPassengerIds',
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      validator: UniqueReadinessOfferPassengerIdsConstraint,
    });
  };
}

export class BookingReadinessTravelerProfileSourceDto {
  @IsIn(['traveler_profile'])
  type!: 'traveler_profile';

  @IsUUID('4')
  travelerProfileId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedProfileRevision?: number;
}

export class BookingReadinessInlineSourceDto {
  @IsIn(['inline'])
  type!: 'inline';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  givenName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  middleName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  familyName?: string | null;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(DATE_ONLY_PATTERN)
  dateOfBirth?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  gender?: string | null;

  @IsOptional()
  @Matches(COUNTRY_CODE_PATTERN)
  nationality?: string | null;

  @IsOptional()
  @Matches(PASSPORT_NUMBER_PATTERN)
  passportNumber?: string | null;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(DATE_ONLY_PATTERN)
  passportExpiry?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string | null;

  @IsOptional()
  @Matches(PHONE_COUNTRY_CODE_PATTERN)
  phoneCountryCode?: string | null;

  @IsOptional()
  @Matches(PHONE_NUMBER_PATTERN)
  phoneNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  documentType?: string | null;

  @IsOptional()
  @Matches(COUNTRY_CODE_PATTERN)
  issuingCountry?: string | null;
}

export type BookingReadinessPassengerSourceDto =
  | BookingReadinessTravelerProfileSourceDto
  | BookingReadinessInlineSourceDto;

export class BookingReadinessPassengerDto {
  @IsString()
  @MaxLength(100)
  @Matches(/\S/)
  offerPassengerId!: string;

  @IsEnum(PassengerType)
  passengerType!: PassengerType;

  @Validate(BookingReadinessPassengerSourceConstraint)
  @ValidateNested()
  @Type(() => BookingReadinessTravelerProfileSourceDto, {
    discriminator: {
      property: 'type',
      subTypes: [
        { name: 'traveler_profile', value: BookingReadinessTravelerProfileSourceDto },
        { name: 'inline', value: BookingReadinessInlineSourceDto },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  @HasValidReadinessPassengerSource()
  source!: BookingReadinessPassengerSourceDto;
}

export class BookingReadinessRequestDto {
  @IsOptional()
  @IsUUID('4')
  flightOfferId?: string;

  @IsOptional()
  @IsString()
  handoffToken?: string;

  @HasValidHandoffSource()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(9)
  @ValidateNested({ each: true })
  @Type(() => BookingReadinessPassengerDto)
  @HasValidReadinessPassengerMatrix()
  @HasUniqueReadinessOfferPassengerIds()
  passengers!: BookingReadinessPassengerDto[];
}

export type BookingReadinessResponseDto = BookingReadinessResult;
