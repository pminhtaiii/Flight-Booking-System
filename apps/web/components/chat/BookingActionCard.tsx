import React from 'react';

const ACTIONS = ['COMPLETE_PROFILE', 'CONTINUE_CHECKOUT'] as const;
const SCOPES = ['DOMESTIC', 'INTERNATIONAL', 'UNKNOWN'] as const;
const PASSENGER_TYPES = ['ADULT', 'CHILD', 'INFANT'] as const;
const SECTION_NAMES = ['identity', 'contact', 'travel_document', 'itinerary', 'entry_eligibility'] as const;
const FIELD_NAMES = [
  'scope',
  'destinationEntryEligibility',
  'givenName',
  'middleName',
  'familyName',
  'dateOfBirth',
  'gender',
  'title',
  'email',
  'phoneCountryCode',
  'phoneNumber',
  'documentType',
  'passportNumber',
  'passportExpiry',
  'issuingCountry',
  'nationality',
] as const;
const STATUSES = ['filled', 'missing', 'invalid', 'warning', 'unknown'] as const;
const REASON_CODES = [
  'REQUIRED',
  'PASSPORT_VALIDITY_REQUIRES_VERIFICATION',
  'UNSUPPORTED_DOCUMENT_TYPE',
  'EXPIRED',
  'AIRPORT_COUNTRY_UNAVAILABLE',
  'PROFILE_CHANGED',
  'READINESS_DEPENDENCY_UNAVAILABLE',
  'ENTRY_ELIGIBILITY_UNKNOWN',
  'INVALID_COUNTRY',
  'INVALID_DATE',
  'INVALID_DOCUMENT_NUMBER',
  'INVALID_EMAIL',
  'INVALID_GENDER',
  'INVALID_PHONE',
  'INVALID_TITLE',
  'ITINERARY_UNAVAILABLE',
  'TRIP_COMPLETION_UNAVAILABLE',
] as const;

type Action = typeof ACTIONS[number];
type Scope = typeof SCOPES[number];
type PassengerType = typeof PASSENGER_TYPES[number];
type SectionName = typeof SECTION_NAMES[number];
type FieldName = typeof FIELD_NAMES[number];
type Status = typeof STATUSES[number];
type ReasonCode = typeof REASON_CODES[number];

export type SafeActionRequiredEvent = {
  action: Action;
  scope: Scope;
  passengers: Array<{
    passengerType: PassengerType;
    passengerOrdinal: number;
    sections: Array<{
      name: SectionName;
      fields: Array<{
        name: FieldName;
        status: Status;
        reason: ReasonCode;
      }>;
    }>;
  }>;
  target: '/profile' | '/checkout/passengers';
  offerId?: string;
};

type BookingActionCardProps = {
  event: SafeActionRequiredEvent;
  onNavigate: (target: SafeActionRequiredEvent['target']) => void;
};

const FIELD_LABELS: Record<FieldName, string> = {
  scope: 'Scope',
  destinationEntryEligibility: 'Destination Entry Eligibility',
  givenName: 'Given Name',
  middleName: 'Middle Name',
  familyName: 'Family Name',
  dateOfBirth: 'Date of Birth',
  gender: 'Gender',
  title: 'Title',
  email: 'Email',
  phoneCountryCode: 'Phone Country Code',
  phoneNumber: 'Phone Number',
  documentType: 'Document Type',
  passportNumber: 'Passport Number',
  passportExpiry: 'Passport Expiry',
  issuingCountry: 'Issuing Country',
  nationality: 'Nationality',
};

const REASON_LABELS: Partial<Record<ReasonCode, string>> = {
  REQUIRED: 'Missing',
  PASSPORT_VALIDITY_REQUIRES_VERIFICATION: 'Requires verification',
  UNSUPPORTED_DOCUMENT_TYPE: 'Unsupported document type',
  EXPIRED: 'Expired',
  AIRPORT_COUNTRY_UNAVAILABLE: 'Airport country unavailable',
  PROFILE_CHANGED: 'Profile changed',
  READINESS_DEPENDENCY_UNAVAILABLE: 'Dependency unavailable',
  ENTRY_ELIGIBILITY_UNKNOWN: 'Eligibility unknown',
  INVALID_COUNTRY: 'Invalid country',
  INVALID_DATE: 'Invalid date',
  INVALID_DOCUMENT_NUMBER: 'Invalid document number',
  INVALID_EMAIL: 'Invalid email',
  INVALID_GENDER: 'Invalid gender',
  INVALID_PHONE: 'Invalid phone',
  INVALID_TITLE: 'Invalid title',
  ITINERARY_UNAVAILABLE: 'Itinerary unavailable',
  TRIP_COMPLETION_UNAVAILABLE: 'Trip completion unavailable',
};

function formatReason(reason: ReasonCode): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

function formatField(sectionName: SectionName, fieldName: FieldName): string {
  const label = FIELD_LABELS[fieldName] ?? fieldName.replace(/([A-Z])/g, ' $1');
  if (sectionName === 'travel_document') {
    return `travel document ${fieldName.replace(/([A-Z])/g, ' $1').toLowerCase()}`;
  }
  return label;
}

function formatPassengerType(type: PassengerType): string {
  switch (type) {
    case 'ADULT':
      return 'Adult';
    case 'CHILD':
      return 'Child';
    case 'INFANT':
      return 'Infant';
    default:
      return type;
  }
}

function getReasonBanner(event: SafeActionRequiredEvent): { title: string; explanation: string } {
  const hasTravelDocIssues = event.passengers.some((p) =>
    p.sections.some((s) => s.name === 'travel_document' && s.fields.some((f) => f.status !== 'filled'))
  );
  const hasIdentityOrContactIssues = event.passengers.some((p) =>
    p.sections.some((s) => (s.name === 'identity' || s.name === 'contact') && s.fields.some((f) => f.status !== 'filled'))
  );

  if (event.scope === 'INTERNATIONAL') {
    if (hasTravelDocIssues) {
      return {
        title: 'Passport Required for International Flight',
        explanation: 'International flights require verified passport details before booking can be confirmed.',
      };
    }
    return {
      title: 'Profile Details Needed for International Flight',
      explanation: 'Please provide the required traveler details to continue with your international flight booking.',
    };
  }

  if (event.scope === 'DOMESTIC') {
    if (hasIdentityOrContactIssues || !hasTravelDocIssues) {
      return {
        title: 'Profile Details Needed for Domestic Flight',
        explanation: 'Domestic flights require traveler identity and contact information before confirmation.',
      };
    }
    return {
      title: 'Travel Details Needed for Domestic Flight',
      explanation: 'Please complete the required details before proceeding with your booking.',
    };
  }

  return {
    title: 'Action Required',
    explanation: 'Before we can confirm your booking, some details are needed.',
  };
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function isExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const valueKeys = Object.keys(value);
  for (const key of requiredKeys) {
    if (!(key in value)) {
      return false;
    }
  }
  return valueKeys.every((key) => allowedKeys.includes(key));
}

function parseField(value: unknown): SafeActionRequiredEvent['passengers'][number]['sections'][number]['fields'][number] | null {
  if (
    !isExactRecord(value, ['name', 'status', 'reason']) ||
    !isOneOf(value.name, FIELD_NAMES) ||
    !isOneOf(value.status, STATUSES) ||
    !isOneOf(value.reason, REASON_CODES)
  ) {
    return null;
  }

  return { name: value.name, status: value.status, reason: value.reason };
}

function parseSection(value: unknown): SafeActionRequiredEvent['passengers'][number]['sections'][number] | null {
  if (!isExactRecord(value, ['name', 'fields']) || !isOneOf(value.name, SECTION_NAMES) || !Array.isArray(value.fields)) {
    return null;
  }

  const fields = value.fields.map(parseField);
  return fields.every((field): field is NonNullable<typeof field> => field !== null)
    ? { name: value.name, fields }
    : null;
}

function parsePassenger(value: unknown): SafeActionRequiredEvent['passengers'][number] | null {
  if (
    !isExactRecord(value, ['passengerType', 'passengerOrdinal', 'sections']) ||
    !isOneOf(value.passengerType, PASSENGER_TYPES) ||
    typeof value.passengerOrdinal !== 'number' ||
    !Number.isInteger(value.passengerOrdinal) ||
    value.passengerOrdinal < 1 ||
    value.passengerOrdinal > 9 ||
    !Array.isArray(value.sections)
  ) {
    return null;
  }

  const sections = value.sections.map(parseSection);
  return sections.every((section): section is NonNullable<typeof section> => section !== null)
    ? { passengerType: value.passengerType, passengerOrdinal: value.passengerOrdinal, sections }
    : null;
}

export function parseActionRequiredEvent(value: unknown): SafeActionRequiredEvent | null {
  if (
    !isExactRecord(value, ['action', 'scope', 'passengers', 'target', 'offerId'], ['action', 'scope', 'passengers', 'target']) ||
    !isOneOf(value.action, ACTIONS) ||
    !isOneOf(value.scope, SCOPES) ||
    !Array.isArray(value.passengers)
  ) {
    return null;
  }

  const passengers = value.passengers.map(parsePassenger);
  if (!passengers.every((passenger): passenger is NonNullable<typeof passenger> => passenger !== null) || passengers.length === 0) {
    return null;
  }

  const target = value.action === 'COMPLETE_PROFILE' && passengers.length === 1 ? '/profile' : '/checkout/passengers';
  if (value.target !== target) {
    return null;
  }

  let offerId: string | undefined;
  if ('offerId' in value) {
    if (typeof value.offerId !== 'string' || !/^off_[A-Za-z0-9_-]{1,128}$/.test(value.offerId)) {
      return null;
    }
    offerId = value.offerId;
  }

  return {
    action: value.action,
    scope: value.scope,
    passengers,
    target,
    ...(offerId && { offerId }),
  };
}

export function BookingActionCard({ event, onNavigate }: BookingActionCardProps): JSX.Element {
  const isCheckoutHandoff = event.target === '/checkout/passengers';
  const { title, explanation } = getReasonBanner(event);

  return (
    <section
      data-testid="booking-action-card"
      className="card my-2 flex flex-col gap-3 p-4"
      aria-labelledby="booking-action-title"
    >
      <h2 id="booking-action-title" className="text-lg font-semibold text-text-primary">
        {title}
      </h2>
      <p className="text-sm text-text-secondary">{explanation}</p>
      <div className="flex flex-col gap-2">
        {event.passengers.map((passenger) => (
          <div
            key={`${passenger.passengerType}-${passenger.passengerOrdinal}`}
            className="border-l-4 border-accent pl-3 py-1"
          >
            <p className="text-sm font-medium text-text-primary">
              Passenger {passenger.passengerOrdinal} ({formatPassengerType(passenger.passengerType)})
            </p>
            <ul className="mt-1 list-inside list-disc text-xs text-text-secondary">
              {passenger.sections.flatMap((section) =>
                section.fields.map((field) => {
                  const reasonText = formatReason(field.reason);
                  const fieldName = formatField(section.name, field.name);

                  return (
                    <li key={`${section.name}-${field.name}`}>
                      {reasonText} {fieldName}
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onNavigate(event.target)}
        className="btn-primary mt-2 w-fit"
        data-testid="booking-action-button"
        aria-label={isCheckoutHandoff ? 'Complete passenger details' : 'Complete profile'}
      >
        {isCheckoutHandoff ? 'Complete passenger details' : 'Complete profile'}
      </button>
    </section>
  );
}
