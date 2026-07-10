import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PassengerType } from '@prisma/client';

function HasValidPassengerMatrix(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'hasValidPassengerMatrix',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (!Array.isArray(value) || value.length === 0) {
            return false;
          }

          const counts = value.reduce(
            (acc, item) => {
              const passenger = item as { type?: PassengerType };
              if (passenger.type === PassengerType.ADULT) acc.adults += 1;
              if (passenger.type === PassengerType.CHILD) acc.children += 1;
              if (passenger.type === PassengerType.INFANT) acc.infants += 1;
              return acc;
            },
            { adults: 0, children: 0, infants: 0 },
          );

          const total = counts.adults + counts.children + counts.infants;
          if (total > 9) {
            return false;
          }

          if (counts.adults < 1) {
            return false;
          }

          return counts.infants <= counts.adults;
        },
        defaultMessage(args: ValidationArguments) {
          const value = args.value;
          if (!Array.isArray(value) || value.length === 0) {
            return 'At least one passenger is required';
          }

          const counts = value.reduce(
            (acc, item) => {
              const passenger = item as { type?: PassengerType };
              if (passenger.type === PassengerType.ADULT) acc.adults += 1;
              if (passenger.type === PassengerType.CHILD) acc.children += 1;
              if (passenger.type === PassengerType.INFANT) acc.infants += 1;
              return acc;
            },
            { adults: 0, children: 0, infants: 0 },
          );

          if (counts.adults + counts.children + counts.infants > 9) {
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

export class CreateIntentPassengerDto {
  @IsEnum(PassengerType)
  type!: PassengerType;

  @IsString()
  @MaxLength(100)
  givenName!: string;

  @IsString()
  @MaxLength(100)
  familyName!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'dateOfBirth must be in YYYY-MM-DD format',
  })
  dateOfBirth!: string;

  @IsString()
  @Matches(/^(male|female)$/i, {
    message: "Gender must be 'male' or 'female'",
  })
  gender!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/i, {
    message: 'nationality must be a 2-character country code',
  })
  nationality?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  passportNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'passportExpiry must be in YYYY-MM-DD format',
  })
  passportExpiry?: string;

  @IsOptional()
  @IsBoolean()
  useProfile?: boolean;
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
}
