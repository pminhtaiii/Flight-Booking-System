import type {
  BookingReadinessEvaluationFieldResult,
  BookingReadinessEvaluationInput,
  BookingReadinessEvaluationPassengerResult,
  BookingReadinessEvaluationResult,
  BookingReadinessEvaluationSectionResult,
  BookingReadinessFieldName,
  BookingReadinessPassengerInput,
  BookingReadinessResultReasonCode,
  BookingReadinessScopeResult,
  BookingReadinessSectionName,
} from './booking-readiness.types';

type ParsedDate = {
  year: number;
  month: number;
  day: number;
  iso: string;
};

const SUPPORTED_GENDERS = new Set(['male', 'female']);
const SUPPORTED_TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_COUNTRY_CODE_PATTERN = /^\+\d{1,4}$/;
const PHONE_NUMBER_PATTERN = /^\d{4,15}$/;
const PASSPORT_NUMBER_PATTERN = /^[A-Za-z0-9]{3,50}$/;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toTrimmedString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

function parseDateOnly(value: string | null | undefined): ParsedDate | null {
  const normalizedValue = toTrimmedString(value);

  if (!normalizedValue) {
    return null;
  }

  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/.exec(normalizedValue);
  if (!match?.groups) {
    return null;
  }

  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(utcDate.getTime()) ||
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    year,
    month,
    day,
    iso: normalizedValue,
  };
}

function compareParsedDates(left: ParsedDate, right: ParsedDate): number {
  if (left.year !== right.year) {
    return left.year - right.year;
  }

  if (left.month !== right.month) {
    return left.month - right.month;
  }

  return left.day - right.day;
}

function addDaysToParsedDate(value: ParsedDate, days: number): ParsedDate {
  const utcDate = new Date(Date.UTC(value.year, value.month - 1, value.day));
  utcDate.setUTCDate(utcDate.getUTCDate() + days);

  const year = utcDate.getUTCFullYear();
  const month = utcDate.getUTCMonth() + 1;
  const day = utcDate.getUTCDate();

  return {
    year,
    month,
    day,
    iso: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
  };
}

function fieldResult(
  name: BookingReadinessFieldName,
  status: BookingReadinessEvaluationFieldResult['status'],
  reason: BookingReadinessResultReasonCode | null,
  blocking: boolean,
): BookingReadinessEvaluationFieldResult {
  return {
    name,
    status,
    reason,
    blocking,
  };
}

function sectionResult(
  name: BookingReadinessSectionName,
  fields: BookingReadinessEvaluationFieldResult[],
): BookingReadinessEvaluationSectionResult {
  return {
    name,
    fields,
  };
}

function passengerReady(sections: readonly BookingReadinessEvaluationSectionResult[]): boolean {
  return sections.every((section) => section.fields.every((field) => !field.blocking));
}

function normalizedDocumentTypes(documentTypes: readonly string[]): Set<string> {
  return new Set(
    documentTypes
      .map((documentType) => toTrimmedString(documentType)?.toLowerCase() ?? null)
      .filter((documentType): documentType is string => documentType !== null),
  );
}

function isValidCountryCode(value: string | null | undefined): boolean {
  const normalizedValue = toTrimmedString(value);
  return normalizedValue !== null && COUNTRY_CODE_PATTERN.test(normalizedValue);
}

function evaluateRequiredStringField(
  fieldName: BookingReadinessFieldName,
  value: string | null | undefined,
): BookingReadinessEvaluationFieldResult {
  return toTrimmedString(value) === null
    ? fieldResult(fieldName, 'missing', 'REQUIRED', true)
    : fieldResult(fieldName, 'filled', null, false);
}

function evaluateSupportedStringField(
  fieldName: BookingReadinessFieldName,
  value: string | null | undefined,
  supportedValues: ReadonlySet<string>,
  invalidReason: Extract<BookingReadinessResultReasonCode, 'INVALID_GENDER' | 'INVALID_TITLE'>,
): BookingReadinessEvaluationFieldResult {
  const normalizedValue = toTrimmedString(value);

  if (normalizedValue === null) {
    return fieldResult(fieldName, 'missing', 'REQUIRED', true);
  }

  return supportedValues.has(normalizedValue.toLowerCase())
    ? fieldResult(fieldName, 'filled', null, false)
    : fieldResult(fieldName, 'invalid', invalidReason, true);
}

function evaluateDateOfBirth(value: string | null | undefined, currentDate: ParsedDate): BookingReadinessEvaluationFieldResult {
  const normalizedValue = toTrimmedString(value);

  if (normalizedValue === null) {
    return fieldResult('dateOfBirth', 'missing', 'REQUIRED', true);
  }

  const parsedValue = parseDateOnly(normalizedValue);
  if (parsedValue === null || compareParsedDates(parsedValue, currentDate) > 0) {
    return fieldResult('dateOfBirth', 'invalid', 'INVALID_DATE', true);
  }

  return fieldResult('dateOfBirth', 'filled', null, false);
}

function evaluateEmail(value: string | null | undefined): BookingReadinessEvaluationFieldResult {
  const normalizedValue = toTrimmedString(value);

  if (normalizedValue === null) {
    return fieldResult('email', 'missing', 'REQUIRED', true);
  }

  return EMAIL_PATTERN.test(normalizedValue)
    ? fieldResult('email', 'filled', null, false)
    : fieldResult('email', 'invalid', 'INVALID_EMAIL', true);
}

function evaluatePhoneCountryCode(value: string | null | undefined): BookingReadinessEvaluationFieldResult {
  const normalizedValue = toTrimmedString(value);

  if (normalizedValue === null) {
    return fieldResult('phoneCountryCode', 'missing', 'REQUIRED', true);
  }

  return PHONE_COUNTRY_CODE_PATTERN.test(normalizedValue)
    ? fieldResult('phoneCountryCode', 'filled', null, false)
    : fieldResult('phoneCountryCode', 'invalid', 'INVALID_PHONE', true);
}

function evaluatePhoneNumber(value: string | null | undefined): BookingReadinessEvaluationFieldResult {
  const normalizedValue = toTrimmedString(value);

  if (normalizedValue === null) {
    return fieldResult('phoneNumber', 'missing', 'REQUIRED', true);
  }

  return PHONE_NUMBER_PATTERN.test(normalizedValue)
    ? fieldResult('phoneNumber', 'filled', null, false)
    : fieldResult('phoneNumber', 'invalid', 'INVALID_PHONE', true);
}

function evaluateDocumentType(
  value: string | null | undefined,
  supportedDocumentTypes: ReadonlySet<string>,
): BookingReadinessEvaluationFieldResult {
  const normalizedValue = toTrimmedString(value);

  if (normalizedValue === null) {
    return fieldResult('documentType', 'missing', 'REQUIRED', true);
  }

  return supportedDocumentTypes.has(normalizedValue.toLowerCase())
    ? fieldResult('documentType', 'filled', null, false)
    : fieldResult('documentType', 'invalid', 'UNSUPPORTED_DOCUMENT_TYPE', true);
}

function evaluatePassportNumber(value: string | null | undefined): BookingReadinessEvaluationFieldResult {
  const normalizedValue = toTrimmedString(value);

  if (normalizedValue === null) {
    return fieldResult('passportNumber', 'missing', 'REQUIRED', true);
  }

  return PASSPORT_NUMBER_PATTERN.test(normalizedValue)
    ? fieldResult('passportNumber', 'filled', null, false)
    : fieldResult('passportNumber', 'invalid', 'INVALID_DOCUMENT_NUMBER', true);
}

function evaluateCountryField(fieldName: 'issuingCountry' | 'nationality', value: string | null | undefined): BookingReadinessEvaluationFieldResult {
  const normalizedValue = toTrimmedString(value);

  if (normalizedValue === null) {
    return fieldResult(fieldName, 'missing', 'REQUIRED', true);
  }

  return isValidCountryCode(normalizedValue)
    ? fieldResult(fieldName, 'filled', null, false)
    : fieldResult(fieldName, 'invalid', 'INVALID_COUNTRY', true);
}

function evaluatePassportExpiry(
  value: string | null | undefined,
  tripCompletionDate: ParsedDate | null,
  advisoryBufferDays: number,
): BookingReadinessEvaluationFieldResult {
  const normalizedValue = toTrimmedString(value);

  if (normalizedValue === null) {
    return fieldResult('passportExpiry', 'missing', 'REQUIRED', true);
  }

  const parsedExpiry = parseDateOnly(normalizedValue);
  if (parsedExpiry === null) {
    return fieldResult('passportExpiry', 'invalid', 'INVALID_DATE', true);
  }

  if (tripCompletionDate === null) {
    return fieldResult('passportExpiry', 'unknown', 'TRIP_COMPLETION_UNAVAILABLE', true);
  }

  if (compareParsedDates(parsedExpiry, tripCompletionDate) < 0) {
    return fieldResult('passportExpiry', 'invalid', 'EXPIRED', true);
  }

  const advisoryBoundary = addDaysToParsedDate(tripCompletionDate, advisoryBufferDays);

  if (compareParsedDates(parsedExpiry, advisoryBoundary) <= 0) {
    return fieldResult('passportExpiry', 'warning', 'PASSPORT_VALIDITY_REQUIRES_VERIFICATION', false);
  }

  return fieldResult('passportExpiry', 'filled', null, false);
}

function evaluateIdentitySection(
  passenger: BookingReadinessPassengerInput,
  currentDate: ParsedDate,
): BookingReadinessEvaluationSectionResult {
  return sectionResult('identity', [
    evaluateRequiredStringField('givenName', passenger.givenName),
    fieldResult('middleName', 'filled', null, false),
    evaluateRequiredStringField('familyName', passenger.familyName),
    evaluateDateOfBirth(passenger.dateOfBirth, currentDate),
    evaluateSupportedStringField('gender', passenger.gender, SUPPORTED_GENDERS, 'INVALID_GENDER'),
    evaluateSupportedStringField('title', passenger.title, SUPPORTED_TITLES, 'INVALID_TITLE'),
  ]);
}

function evaluateContactSection(passenger: BookingReadinessPassengerInput): BookingReadinessEvaluationSectionResult {
  return sectionResult('contact', [
    evaluateEmail(passenger.email),
    evaluatePhoneCountryCode(passenger.phoneCountryCode),
    evaluatePhoneNumber(passenger.phoneNumber),
  ]);
}

function evaluateTravelDocumentSection(
  passenger: BookingReadinessPassengerInput,
  supportedDocumentTypes: ReadonlySet<string>,
  tripCompletionDate: ParsedDate | null,
  advisoryBufferDays: number,
): BookingReadinessEvaluationSectionResult {
  return sectionResult('travel_document', [
    evaluateDocumentType(passenger.documentType, supportedDocumentTypes),
    evaluatePassportNumber(passenger.passportNumber),
    evaluatePassportExpiry(passenger.passportExpiry, tripCompletionDate, advisoryBufferDays),
    evaluateCountryField('issuingCountry', passenger.issuingCountry),
    evaluateCountryField('nationality', passenger.nationality),
  ]);
}

function evaluateEntryEligibilitySection(
  entryEligibility: BookingReadinessEvaluationInput['entryEligibility'],
): BookingReadinessEvaluationSectionResult | null {
  if (entryEligibility?.include !== true) {
    return null;
  }

  if (entryEligibility.result?.status === 'filled') {
    return sectionResult('entry_eligibility', [
      fieldResult('destinationEntryEligibility', 'filled', null, false),
    ]);
  }

  return sectionResult('entry_eligibility', [
    fieldResult('destinationEntryEligibility', 'unknown', 'ENTRY_ELIGIBILITY_UNKNOWN', false),
  ]);
}

function determineScope(segments: readonly BookingReadinessEvaluationInput['segments'][number][]): BookingReadinessScopeResult {
  if (segments.length === 0) {
    return {
      scope: 'UNKNOWN',
      reason: 'ITINERARY_UNAVAILABLE',
    };
  }

  let hasUsableSegment = false;
  let isInternational = false;

  for (const segment of segments) {
    const originCountryCode = toTrimmedString(segment.originCountryCode);
    const destinationCountryCode = toTrimmedString(segment.destinationCountryCode);

    if (originCountryCode === null || destinationCountryCode === null) {
      return {
        scope: 'UNKNOWN',
        reason: 'AIRPORT_COUNTRY_UNAVAILABLE',
      };
    }

    if (!isValidCountryCode(originCountryCode) || !isValidCountryCode(destinationCountryCode)) {
      return {
        scope: 'UNKNOWN',
        reason: 'AIRPORT_COUNTRY_UNAVAILABLE',
      };
    }

    hasUsableSegment = true;

    if (originCountryCode !== destinationCountryCode) {
      isInternational = true;
    }
  }

  if (!hasUsableSegment) {
    return {
      scope: 'UNKNOWN',
      reason: 'ITINERARY_UNAVAILABLE',
    };
  }

  return {
    scope: isInternational ? 'INTERNATIONAL' : 'DOMESTIC',
    reason: null,
  };
}

function unknownScopeSections(
  reason: BookingReadinessScopeResult['reason'],
  entryEligibility: BookingReadinessEvaluationInput['entryEligibility'],
): BookingReadinessEvaluationSectionResult[] {
  const sections: BookingReadinessEvaluationSectionResult[] = [
    sectionResult('itinerary', [fieldResult('scope', 'unknown', reason, true)]),
  ];

  const entryEligibilitySection = evaluateEntryEligibilitySection(entryEligibility);
  if (entryEligibilitySection !== null) {
    sections.push(entryEligibilitySection);
  }

  return sections;
}

function buildPassengerResult(
  passenger: BookingReadinessPassengerInput,
  sections: BookingReadinessEvaluationSectionResult[],
): BookingReadinessEvaluationPassengerResult {
  return {
    passengerType: passenger.passengerType,
    passengerOrdinal: passenger.passengerOrdinal,
    ready: passengerReady(sections),
    profileRevision: passenger.profileRevision ?? null,
    sections,
  };
}

export class BookingReadinessEvaluator {
  evaluate(input: BookingReadinessEvaluationInput): BookingReadinessEvaluationResult {
    const currentDate = parseDateOnly(input.currentDate);

    if (currentDate === null) {
      throw new Error('currentDate must be a valid YYYY-MM-DD date');
    }

    const tripCompletionDate = parseDateOnly(input.tripCompletionDate);
    const scopeResult = determineScope(input.segments);
    const supportedDocumentTypes = normalizedDocumentTypes(input.supportedDocumentTypes);

    const passengers = input.passengers.map((passenger) => {
      if (scopeResult.scope === 'UNKNOWN') {
        return buildPassengerResult(passenger, unknownScopeSections(scopeResult.reason, input.entryEligibility));
      }

      const sections: BookingReadinessEvaluationSectionResult[] = [
        evaluateIdentitySection(passenger, currentDate),
        evaluateContactSection(passenger),
      ];

      if (scopeResult.scope === 'INTERNATIONAL') {
        sections.push(
          evaluateTravelDocumentSection(
            passenger,
            supportedDocumentTypes,
            tripCompletionDate,
            input.advisoryBufferDays,
          ),
        );
      }

      const entryEligibilitySection = evaluateEntryEligibilitySection(input.entryEligibility);
      if (entryEligibilitySection !== null) {
        sections.push(entryEligibilitySection);
      }

      return buildPassengerResult(passenger, sections);
    });

    return {
      scope: scopeResult.scope,
      ready: scopeResult.scope !== 'UNKNOWN' && passengers.every((passenger) => passenger.ready),
      passengers,
    };
  }
}
