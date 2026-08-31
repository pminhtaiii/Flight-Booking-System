import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
  IsEmail,
  IsDateString,
  Max,
  Matches,
  Min,
  IsNotEmpty,
  ValidateIf,
} from 'class-validator';

export class IdentitySectionDto {
  @IsNotEmpty()
  @IsString()
  givenName!: string;

  @IsOptional()
  @IsString()
  middleName?: string | null;

  @IsNotEmpty()
  @IsString()
  familyName!: string;

  @IsNotEmpty()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateOfBirth must be in YYYY-MM-DD format' })
  dateOfBirth!: string;

  @IsNotEmpty()
  @IsString()
  gender!: string;

  @IsNotEmpty()
  @IsString()
  title!: string;
}

export class ContactSectionDto {
  @IsNotEmpty()
  @IsEmail()
  email!: string;

  @IsNotEmpty()
  @IsString()
  phoneCountryCode!: string;

  @IsNotEmpty()
  @IsString()
  phoneNumber!: string;
}

export class TravelDocumentSectionDto {
  @IsNotEmpty()
  @IsString()
  documentType!: string;

  @IsNotEmpty()
  @IsString()
  passportNumber!: string;

  @IsNotEmpty()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'passportExpiry must be in YYYY-MM-DD format' })
  passportExpiry!: string;

  @IsNotEmpty()
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'issuingCountry must be a 2-character country code' })
  issuingCountry!: string;

  @IsNotEmpty()
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'nationality must be a 2-character country code' })
  nationality!: string;
}

export class HourWindowDto {
  @IsInt()
  @Min(0)
  @Max(23)
  start!: number;

  @IsInt()
  @Min(0)
  @Max(23)
  end!: number;
}

export class PreferencesSectionDto {
  @IsOptional()
  @IsString()
  seatPreference?: string | null;

  @IsOptional()
  @IsString()
  classPreference?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @ValidateNested()
  @Type(() => HourWindowDto)
  preferredDepartureWindow?: HourWindowDto | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @ValidateNested()
  @Type(() => HourWindowDto)
  preferredArrivalWindow?: HourWindowDto | null;
}

export class UpdateProfileDto {
  @IsNotEmpty()
  @IsInt()
  expectedRevision!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => IdentitySectionDto)
  identity?: IdentitySectionDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContactSectionDto)
  contact?: ContactSectionDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => TravelDocumentSectionDto)
  @ValidateIf((o) => o.travelDocument !== null)
  travelDocument?: TravelDocumentSectionDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => PreferencesSectionDto)
  preferences?: PreferencesSectionDto | null;
}
