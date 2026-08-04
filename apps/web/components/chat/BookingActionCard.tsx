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
};

type BookingActionCardProps = {
  event: SafeActionRequiredEvent;
  onNavigate: (target: SafeActionRequiredEvent['target']) => void;
};

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const valueKeys = Object.keys(value);
  return valueKeys.length === keys.length && valueKeys.every((key) => keys.includes(key));
}

function parseField(value: unknown): SafeActionRequiredEvent['passengers'][number]['sections'][number]['fields'][number] | null {
  if (!isExactRecord(value, ['name', 'status', 'reason'])
    || !isOneOf(value.name, FIELD_NAMES)
    || !isOneOf(value.status, STATUSES)
    || !isOneOf(value.reason, REASON_CODES)) {
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
  if (!isExactRecord(value, ['passengerType', 'passengerOrdinal', 'sections'])
    || !isOneOf(value.passengerType, PASSENGER_TYPES)
    || typeof value.passengerOrdinal !== 'number'
    || !Number.isInteger(value.passengerOrdinal)
    || value.passengerOrdinal < 1
    || value.passengerOrdinal > 9
    || !Array.isArray(value.sections)) {
    return null;
  }

  const sections = value.sections.map(parseSection);
  return sections.every((section): section is NonNullable<typeof section> => section !== null)
    ? { passengerType: value.passengerType, passengerOrdinal: value.passengerOrdinal, sections }
    : null;
}

export function parseActionRequiredEvent(value: unknown): SafeActionRequiredEvent | null {
  if (!isExactRecord(value, ['action', 'scope', 'passengers', 'target'])
    || !isOneOf(value.action, ACTIONS)
    || !isOneOf(value.scope, SCOPES)
    || !Array.isArray(value.passengers)) {
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

  return { action: value.action, scope: value.scope, passengers, target };
}

export function BookingActionCard({ event, onNavigate }: BookingActionCardProps): JSX.Element {
  const isCheckoutHandoff = event.target === '/checkout/passengers';

  return (
    <section data-testid="booking-action-card" className="card my-2 flex flex-col gap-3 p-4" aria-labelledby="booking-action-title">
      <h2 id="booking-action-title" className="text-lg font-semibold text-text-primary">Action Required</h2>
      <p className="text-sm text-text-secondary">
        Before we can confirm your {event.scope.toLowerCase()} booking, some details are needed.
      </p>
      <div className="flex flex-col gap-2">
        {event.passengers.map((passenger) => (
          <div key={`${passenger.passengerType}-${passenger.passengerOrdinal}`} className="border-l-4 border-accent pl-3 py-1">
            <p className="text-sm font-medium text-text-primary">
              Passenger {passenger.passengerOrdinal} ({passenger.passengerType === 'ADULT' ? 'Adult' : passenger.passengerType === 'CHILD' ? 'Child' : 'Infant'})
            </p>
            <ul className="mt-1 list-inside list-disc text-xs text-text-secondary">
              {passenger.sections.flatMap((section) => section.fields.map((field) => {
                const reasonText = field.reason === 'REQUIRED' ? 'Missing' : field.reason.replace(/_/g, ' ');
                const fieldName = section.name === 'travel_document'
                  ? `travel document ${field.name.replace(/([A-Z])/g, ' $1').toLowerCase()}`
                  : field.name.replace(/([A-Z])/g, ' $1').toLowerCase();

                return <li key={`${section.name}-${field.name}`}>{reasonText} {fieldName}</li>;
              }))}
            </ul>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onNavigate(event.target)} className="btn-primary mt-2 w-fit">
        {isCheckoutHandoff ? 'Complete passenger details' : 'Complete profile'}
      </button>
    </section>
  );
}
