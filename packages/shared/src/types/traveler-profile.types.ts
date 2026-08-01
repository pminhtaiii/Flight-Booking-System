export interface TravelerIdentity {
  givenName: string | null;
  middleName?: string | null;
  familyName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  title: string | null;
}

export interface TravelerContact {
  email: string | null;
  phoneCountryCode: string | null;
  phoneNumber: string | null;
}

export interface TravelerDocument {
  documentType: string | null;
  passportNumber: string | null;
  passportExpiry: string | null;
  issuingCountry: string | null;
  nationality: string | null;
}

export interface TravelerPreferences {
  seatPreference?: string | null;
  classPreference?: string | null;
  preferredAirlines?: string[] | null;
  blacklistedAirlines?: string[] | null;
  dietaryNeeds?: string | null;
}

export type TravelerIdentityField = 'givenName' | 'middleName' | 'familyName' | 'dateOfBirth' | 'gender' | 'title';
export const TRAVELER_IDENTITY_FIELDS: TravelerIdentityField[] = [
  'givenName',
  'middleName',
  'familyName',
  'dateOfBirth',
  'gender',
  'title',
];

export type TravelerContactField = 'email' | 'phoneCountryCode' | 'phoneNumber';
export const TRAVELER_CONTACT_FIELDS: TravelerContactField[] = [
  'email',
  'phoneCountryCode',
  'phoneNumber',
];

export type TravelerDocumentField = 'documentType' | 'passportNumber' | 'passportExpiry' | 'issuingCountry' | 'nationality';
export const TRAVELER_DOCUMENT_FIELDS: TravelerDocumentField[] = [
  'documentType',
  'passportNumber',
  'passportExpiry',
  'issuingCountry',
  'nationality',
];

export type ReadinessScope = 'DOMESTIC' | 'INTERNATIONAL' | 'UNKNOWN';

export type ReadinessStatus = 'filled' | 'missing' | 'invalid' | 'warning' | 'unknown';

export type ReadinessReasonCode =
  | 'REQUIRED'
  | 'PASSPORT_VALIDITY_REQUIRES_VERIFICATION'
  | 'UNSUPPORTED_DOCUMENT_TYPE'
  | 'EXPIRED'
  | 'AIRPORT_COUNTRY_UNAVAILABLE'
  | 'PROFILE_CHANGED'
  | 'READINESS_DEPENDENCY_UNAVAILABLE';

export interface ReadinessFieldResult {
  name: string;
  status: ReadinessStatus;
  reason: ReadinessReasonCode | string | null;
  blocking: boolean;
}

export interface ReadinessSectionResult {
  name: string;
  fields: ReadinessFieldResult[];
}

export interface ReadinessPassengerResult {
  passengerType: string;
  passengerOrdinal: number;
  ready: boolean;
  profileRevision?: number | null;
  sections: ReadinessSectionResult[];
}

export interface BookingReadinessResult {
  scope: ReadinessScope;
  ready: boolean;
  passengers: ReadinessPassengerResult[];
}

export interface MaskedContactSummary {
  email: string;
  phoneNumber: string;
}

export interface MaskedDocumentSummary {
  documentType: string | null;
  passportNumber: string | null;
  passportExpiry: string | null;
  issuingCountry: string | null;
  nationality: string | null;
}

export interface MaskedPassengerSummary {
  passengerType: string;
  passengerOrdinal: number;
  givenName: string;
  familyName: string;
  middleName?: string | null;
  title?: string | null;
  gender?: string | null;
  dateOfBirth?: string | null;
  contact: MaskedContactSummary;
  travelDocument?: MaskedDocumentSummary | null;
}
