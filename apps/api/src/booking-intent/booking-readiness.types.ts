import type {
  BookingReadinessResult,
  PassengerType,
  ReadinessFieldResult,
  ReadinessPassengerResult,
  ReadinessReasonCode,
  ReadinessScope,
  ReadinessSectionResult,
  ReadinessStatus,
  TravelerContactField,
  TravelerDocumentField,
  TravelerIdentityField,
} from '@shared/types';

export type BookingReadinessSectionName =
  | 'itinerary'
  | 'identity'
  | 'contact'
  | 'travel_document'
  | 'entry_eligibility';

export type BookingReadinessFieldName =
  | 'scope'
  | 'destinationEntryEligibility'
  | TravelerIdentityField
  | TravelerContactField
  | TravelerDocumentField;

export type BookingReadinessResultReasonCode =
  | ReadinessReasonCode
  | 'ENTRY_ELIGIBILITY_UNKNOWN'
  | 'INVALID_COUNTRY'
  | 'INVALID_DATE'
  | 'INVALID_DOCUMENT_NUMBER'
  | 'INVALID_EMAIL'
  | 'INVALID_GENDER'
  | 'INVALID_PHONE'
  | 'INVALID_TITLE'
  | 'ITINERARY_UNAVAILABLE'
  | 'TRIP_COMPLETION_UNAVAILABLE';

export type BookingReadinessDateInput = string | null | undefined;

export type BookingReadinessPassengerInput = {
  passengerType: PassengerType;
  passengerOrdinal: number;
  profileRevision?: number | null;
  givenName?: string | null;
  middleName?: string | null;
  familyName?: string | null;
  dateOfBirth?: BookingReadinessDateInput;
  gender?: string | null;
  title?: string | null;
  email?: string | null;
  phoneCountryCode?: string | null;
  phoneNumber?: string | null;
  documentType?: string | null;
  passportNumber?: string | null;
  passportExpiry?: BookingReadinessDateInput;
  issuingCountry?: string | null;
  nationality?: string | null;
};

export type BookingReadinessSegmentInput = {
  originCountryCode?: string | null;
  destinationCountryCode?: string | null;
  arrivalDate?: BookingReadinessDateInput;
};

export type BookingReadinessEntryEligibilityInput =
  | {
      include: false;
    }
  | {
      include: true;
      result?:
        | {
            status: 'filled';
            reason: null;
            blocking: false;
          }
        | {
            status: 'unknown';
            reason?: 'ENTRY_ELIGIBILITY_UNKNOWN' | null;
            blocking: false;
          }
        | null;
    };

export type BookingReadinessEvaluationInput = {
  passengers: readonly BookingReadinessPassengerInput[];
  segments: readonly BookingReadinessSegmentInput[];
  tripCompletionDate?: BookingReadinessDateInput;
  supportedDocumentTypes: readonly string[];
  advisoryBufferDays: number;
  currentDate: string;
  entryEligibility?: BookingReadinessEntryEligibilityInput;
};

export type BookingReadinessEvaluationResult = BookingReadinessResult;

export type BookingReadinessEvaluationPassengerResult = ReadinessPassengerResult;

export type BookingReadinessEvaluationSectionResult = ReadinessSectionResult & {
  name: BookingReadinessSectionName;
  fields: BookingReadinessEvaluationFieldResult[];
};

export type BookingReadinessEvaluationFieldResult = ReadinessFieldResult & {
  name: BookingReadinessFieldName;
  status: ReadinessStatus;
  reason: BookingReadinessResultReasonCode | null;
};

export type BookingReadinessScopeResult =
  | {
      scope: Exclude<ReadinessScope, 'UNKNOWN'>;
      reason: null;
    }
  | {
      scope: 'UNKNOWN';
      reason: Extract<
        BookingReadinessResultReasonCode,
        'AIRPORT_COUNTRY_UNAVAILABLE' | 'ITINERARY_UNAVAILABLE'
      >;
    };
