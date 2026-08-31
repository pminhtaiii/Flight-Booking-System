import { HourWindow, PriceSensitivity } from '@shared/types';

export class ProfileResponseIdentityDto {
  givenName!: string | null;
  middleName?: string | null;
  familyName!: string | null;
  dateOfBirth!: string | null;
  gender!: string | null;
  title!: string | null;
}

export class ProfileResponseContactDto {
  email!: string | null;
  phoneCountryCode!: string | null;
  phoneNumber!: string | null;
}

export class ProfileResponseTravelDocumentDto {
  documentType!: string | null;
  passportNumber!: string | null;
  passportExpiry!: string | null;
  issuingCountry!: string | null;
  nationality!: string | null;
}

export class ProfileResponsePreferencesDto {
  seatPreference?: string | null;
  classPreference?: string | null;
  preferredAirlines?: string[];
  blacklistedAirlines?: string[];
  preferredDepartureWindow?: HourWindow | null;
  preferredArrivalWindow?: HourWindow | null;
  maxStops?: number | null;
  priceSensitivity?: PriceSensitivity | null;
  requiresCheckedBaggage?: boolean | null;
}

export class ProfileResponseDto {
  profileId!: string | null;
  identity!: ProfileResponseIdentityDto | null;
  contact!: ProfileResponseContactDto | null;
  travelDocument!: ProfileResponseTravelDocumentDto | null;
  preferences!: ProfileResponsePreferencesDto | null;
  revision!: number;
  updatedAt?: string;
}
