import { BookingReadinessEvaluator } from './booking-readiness.evaluator';
import { DEFAULT_PASSPORT_ADVISORY_BUFFER_DAYS, MAX_PASSPORT_ADVISORY_BUFFER_DAYS, MIN_PASSPORT_ADVISORY_BUFFER_DAYS, parseBookingReadinessConfig } from './booking-readiness.config';
import type {
  BookingReadinessEvaluationInput,
  BookingReadinessPassengerInput,
  BookingReadinessResultReasonCode,
} from './booking-readiness.types';

function createPassenger(overrides: Partial<BookingReadinessPassengerInput> = {}): BookingReadinessPassengerInput {
  return {
    passengerType: 'ADULT',
    passengerOrdinal: 1,
    profileRevision: 7,
    givenName: 'Ada',
    middleName: 'Lovelace',
    familyName: 'Byron',
    dateOfBirth: '1990-05-10',
    gender: 'male',
    title: 'Mr',
    email: 'ada@example.com',
    phoneCountryCode: '+1',
    phoneNumber: '4155550123',
    documentType: 'passport',
    passportNumber: 'AB1234567',
    passportExpiry: '2027-06-30',
    issuingCountry: 'US',
    nationality: 'US',
    ...overrides,
  };
}

function createInput(overrides: Partial<BookingReadinessEvaluationInput> = {}): BookingReadinessEvaluationInput {
  return {
    passengers: [createPassenger()],
    segments: [{ originCountryCode: 'US', destinationCountryCode: 'US' }],
    tripCompletionDate: '2026-12-20',
    supportedDocumentTypes: ['passport'],
    advisoryBufferDays: DEFAULT_PASSPORT_ADVISORY_BUFFER_DAYS,
    currentDate: '2026-08-03',
    entryEligibility: { include: false },
    ...overrides,
  };
}

function findField(
  result: ReturnType<BookingReadinessEvaluator['evaluate']>,
  passengerOrdinal: number,
  sectionName: string,
  fieldName: string,
) {
  const passenger = result.passengers.find((candidate) => candidate.passengerOrdinal === passengerOrdinal);
  const section = passenger?.sections.find((candidate) => candidate.name === sectionName);
  return section?.fields.find((candidate) => candidate.name === fieldName);
}

describe('BookingReadinessEvaluator', () => {
  const evaluator = new BookingReadinessEvaluator();

  describe('T027 table-driven evaluator matrix', () => {
    it.each<
      readonly [string, BookingReadinessEvaluationInput, { scope: string; ready: boolean; passengerReady: boolean; field?: { section: string; name: string; status: string; reason: BookingReadinessResultReasonCode | null; blocking: boolean } }]
    >([
      [
        'returns ready for a complete domestic passenger',
        createInput(),
        { scope: 'DOMESTIC', ready: true, passengerReady: true },
      ],
      [
        'blocks when domestic givenName is missing',
        createInput({ passengers: [createPassenger({ givenName: '   ' })] }),
        {
          scope: 'DOMESTIC',
          ready: false,
          passengerReady: false,
          field: { section: 'identity', name: 'givenName', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks when domestic familyName is missing',
        createInput({ passengers: [createPassenger({ familyName: null })] }),
        {
          scope: 'DOMESTIC',
          ready: false,
          passengerReady: false,
          field: { section: 'identity', name: 'familyName', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks when domestic dateOfBirth is missing',
        createInput({ passengers: [createPassenger({ dateOfBirth: undefined })] }),
        {
          scope: 'DOMESTIC',
          ready: false,
          passengerReady: false,
          field: { section: 'identity', name: 'dateOfBirth', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks when domestic dateOfBirth is in the future',
        createInput({ passengers: [createPassenger({ dateOfBirth: '2026-09-01' })] }),
        {
          scope: 'DOMESTIC',
          ready: false,
          passengerReady: false,
          field: { section: 'identity', name: 'dateOfBirth', status: 'invalid', reason: 'INVALID_DATE', blocking: true },
        },
      ],
      [
        'blocks when domestic gender is missing',
        createInput({ passengers: [createPassenger({ gender: ' ' })] }),
        {
          scope: 'DOMESTIC',
          ready: false,
          passengerReady: false,
          field: { section: 'identity', name: 'gender', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks when domestic title is missing',
        createInput({ passengers: [createPassenger({ title: '' })] }),
        {
          scope: 'DOMESTIC',
          ready: false,
          passengerReady: false,
          field: { section: 'identity', name: 'title', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks when domestic email is missing',
        createInput({ passengers: [createPassenger({ email: '  ' })] }),
        {
          scope: 'DOMESTIC',
          ready: false,
          passengerReady: false,
          field: { section: 'contact', name: 'email', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks when domestic phoneCountryCode is missing',
        createInput({ passengers: [createPassenger({ phoneCountryCode: null })] }),
        {
          scope: 'DOMESTIC',
          ready: false,
          passengerReady: false,
          field: { section: 'contact', name: 'phoneCountryCode', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks when domestic phoneNumber is missing',
        createInput({ passengers: [createPassenger({ phoneNumber: undefined })] }),
        {
          scope: 'DOMESTIC',
          ready: false,
          passengerReady: false,
          field: { section: 'contact', name: 'phoneNumber', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'keeps domestic passenger ready when optional middleName is absent',
        createInput({ passengers: [createPassenger({ middleName: null })] }),
        { scope: 'DOMESTIC', ready: true, passengerReady: true },
      ],
      [
        'keeps domestic passenger ready when optional middleName is present',
        createInput({ passengers: [createPassenger({ middleName: 'Augusta' })] }),
        { scope: 'DOMESTIC', ready: true, passengerReady: true },
      ],
      [
        'ignores incomplete passport data for domestic readiness',
        createInput({ passengers: [createPassenger({ documentType: null, passportNumber: null, passportExpiry: null, issuingCountry: null, nationality: null })] }),
        { scope: 'DOMESTIC', ready: true, passengerReady: true },
      ],
      [
        'returns ready for a complete international passenger',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }] }),
        { scope: 'INTERNATIONAL', ready: true, passengerReady: true },
      ],
      [
        'blocks when international documentType is missing',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }], passengers: [createPassenger({ documentType: '' })] }),
        {
          scope: 'INTERNATIONAL',
          ready: false,
          passengerReady: false,
          field: { section: 'travel_document', name: 'documentType', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks when international passportNumber is missing',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }], passengers: [createPassenger({ passportNumber: ' ' })] }),
        {
          scope: 'INTERNATIONAL',
          ready: false,
          passengerReady: false,
          field: { section: 'travel_document', name: 'passportNumber', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks when international passportExpiry is missing',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }], passengers: [createPassenger({ passportExpiry: null })] }),
        {
          scope: 'INTERNATIONAL',
          ready: false,
          passengerReady: false,
          field: { section: 'travel_document', name: 'passportExpiry', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks when international issuingCountry is missing',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }], passengers: [createPassenger({ issuingCountry: '' })] }),
        {
          scope: 'INTERNATIONAL',
          ready: false,
          passengerReady: false,
          field: { section: 'travel_document', name: 'issuingCountry', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks when international nationality is missing',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }], passengers: [createPassenger({ nationality: '  ' })] }),
        {
          scope: 'INTERNATIONAL',
          ready: false,
          passengerReady: false,
          field: { section: 'travel_document', name: 'nationality', status: 'missing', reason: 'REQUIRED', blocking: true },
        },
      ],
      [
        'blocks unsupported international document types',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }], passengers: [createPassenger({ documentType: 'visa' })] }),
        {
          scope: 'INTERNATIONAL',
          ready: false,
          passengerReady: false,
          field: { section: 'travel_document', name: 'documentType', status: 'invalid', reason: 'UNSUPPORTED_DOCUMENT_TYPE', blocking: true },
        },
      ],
      [
        'blocks invalid document countries',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }], passengers: [createPassenger({ issuingCountry: 'USA' })] }),
        {
          scope: 'INTERNATIONAL',
          ready: false,
          passengerReady: false,
          field: { section: 'travel_document', name: 'issuingCountry', status: 'invalid', reason: 'INVALID_COUNTRY', blocking: true },
        },
      ],
      [
        'blocks invalid passport number format',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }], passengers: [createPassenger({ passportNumber: '!@#' })] }),
        {
          scope: 'INTERNATIONAL',
          ready: false,
          passengerReady: false,
          field: { section: 'travel_document', name: 'passportNumber', status: 'invalid', reason: 'INVALID_DOCUMENT_NUMBER', blocking: true },
        },
      ],
      [
        'blocks expired passports',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }], passengers: [createPassenger({ passportExpiry: '2026-12-19' })] }),
        {
          scope: 'INTERNATIONAL',
          ready: false,
          passengerReady: false,
          field: { section: 'travel_document', name: 'passportExpiry', status: 'invalid', reason: 'EXPIRED', blocking: true },
        },
      ],
      [
        'returns a warning when the passport falls within the advisory buffer',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }], passengers: [createPassenger({ passportExpiry: '2027-06-18' })] }),
        {
          scope: 'INTERNATIONAL',
          ready: true,
          passengerReady: true,
          field: { section: 'travel_document', name: 'passportExpiry', status: 'warning', reason: 'PASSPORT_VALIDITY_REQUIRES_VERIFICATION', blocking: false },
        },
      ],
      [
        'keeps an international passenger ready when the passport is outside the advisory buffer',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }], passengers: [createPassenger({ passportExpiry: '2027-06-19' })] }),
        {
          scope: 'INTERNATIONAL',
          ready: true,
          passengerReady: true,
          field: { section: 'travel_document', name: 'passportExpiry', status: 'filled', reason: null, blocking: false },
        },
      ],
      [
        'returns unknown scope for missing airport-country data',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: null }] }),
        {
          scope: 'UNKNOWN',
          ready: false,
          passengerReady: false,
          field: { section: 'itinerary', name: 'scope', status: 'unknown', reason: 'AIRPORT_COUNTRY_UNAVAILABLE', blocking: true },
        },
      ],
      [
        'detects a cross-border itinerary',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }] }),
        { scope: 'INTERNATIONAL', ready: true, passengerReady: true },
      ],
      [
        'marks the full itinerary international when any segment crosses a border',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'US' }, { originCountryCode: 'US', destinationCountryCode: 'CA' }] }),
        { scope: 'INTERNATIONAL', ready: true, passengerReady: true },
      ],
      [
        'keeps all-domestic segments domestic',
        createInput({ segments: [{ originCountryCode: 'US', destinationCountryCode: 'US' }, { originCountryCode: 'US', destinationCountryCode: 'US' }] }),
        { scope: 'DOMESTIC', ready: true, passengerReady: true },
      ],
      [
        'returns unknown scope for empty segment input',
        createInput({ segments: [] }),
        {
          scope: 'UNKNOWN',
          ready: false,
          passengerReady: false,
          field: { section: 'itinerary', name: 'scope', status: 'unknown', reason: 'ITINERARY_UNAVAILABLE', blocking: true },
        },
      ],
    ])('%s', (_name, input, expected) => {
      const result = evaluator.evaluate(input);

      expect(result.scope).toBe(expected.scope);
      expect(result.ready).toBe(expected.ready);
      expect(result.passengers[0]?.ready).toBe(expected.passengerReady);

      if (expected.field) {
        const { section, ...expectedFieldWithoutSection } = expected.field;
        expect(findField(result, 1, section, expected.field.name)).toMatchObject(expectedFieldWithoutSection);
      }
    });

    it('evaluates multiple passengers independently', () => {
      const result = evaluator.evaluate(
        createInput({
          segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }],
          passengers: [
            createPassenger({ passengerOrdinal: 1, passportExpiry: '2027-06-18' }),
            createPassenger({ passengerOrdinal: 2, email: '' }),
          ],
        }),
      );

      expect(result.scope).toBe('INTERNATIONAL');
      expect(result.ready).toBe(false);
      expect(result.passengers.map((passenger) => passenger.ready)).toEqual([true, false]);
      expect(findField(result, 1, 'travel_document', 'passportExpiry')).toMatchObject({
        status: 'warning',
        reason: 'PASSPORT_VALIDITY_REQUIRES_VERIFICATION',
        blocking: false,
      });
      expect(findField(result, 2, 'contact', 'email')).toMatchObject({
        status: 'missing',
        reason: 'REQUIRED',
        blocking: true,
      });
    });

    it('keeps warning-only passengers ready but blocks when warnings are mixed with blockers', () => {
      const warningOnly = evaluator.evaluate(
        createInput({
          segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }],
          passengers: [createPassenger({ passportExpiry: '2027-06-18' })],
        }),
      );

      const mixed = evaluator.evaluate(
        createInput({
          segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }],
          passengers: [createPassenger({ passportExpiry: '2027-06-18', email: '' })],
        }),
      );

      expect(warningOnly.ready).toBe(true);
      expect(warningOnly.passengers[0]?.ready).toBe(true);
      expect(mixed.ready).toBe(false);
      expect(mixed.passengers[0]?.ready).toBe(false);
    });

    it('does not mutate the input objects', () => {
      const input = createInput({
        segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }],
      });
      const before = JSON.parse(JSON.stringify(input));

      evaluator.evaluate(input);

      expect(input).toEqual(before);
    });
  });

  describe('passport-expiry boundary coverage', () => {
    it.each<
      readonly [
        string,
        {
          passportExpiry: string;
          tripCompletionDate?: string;
          advisoryBufferDays?: number;
        },
        {
          status: string;
          reason: BookingReadinessResultReasonCode | null;
          blocking: boolean;
        },
      ]
    >([
      [
        'treats a passport expiring exactly on trip completion as a non-blocking warning',
        {
          passportExpiry: '2026-12-20',
        },
        {
          status: 'warning',
          reason: 'PASSPORT_VALIDITY_REQUIRES_VERIFICATION',
          blocking: false,
        },
      ],
      [
        'treats a passport expiring one day after trip completion as a non-blocking warning',
        {
          passportExpiry: '2026-12-21',
        },
        {
          status: 'warning',
          reason: 'PASSPORT_VALIDITY_REQUIRES_VERIFICATION',
          blocking: false,
        },
      ],
      [
        'keeps the exact advisory boundary inside the warning window',
        {
          passportExpiry: '2027-06-18',
        },
        {
          status: 'warning',
          reason: 'PASSPORT_VALIDITY_REQUIRES_VERIFICATION',
          blocking: false,
        },
      ],
      [
        'treats one day outside the advisory boundary as filled',
        {
          passportExpiry: '2027-06-19',
        },
        {
          status: 'filled',
          reason: null,
          blocking: false,
        },
      ],
      [
        'handles leap-day trip completion with date-only comparisons',
        {
          passportExpiry: '2028-03-01',
          tripCompletionDate: '2028-02-29',
          advisoryBufferDays: 1,
        },
        {
          status: 'warning',
          reason: 'PASSPORT_VALIDITY_REQUIRES_VERIFICATION',
          blocking: false,
        },
      ],
      [
        'rejects malformed passport-expiry date strings',
        {
          passportExpiry: '2027-02-30',
        },
        {
          status: 'invalid',
          reason: 'INVALID_DATE',
          blocking: true,
        },
      ],
      [
        'returns a blocking unknown when trip completion is unavailable',
        {
          passportExpiry: '2027-06-18',
          tripCompletionDate: '   ',
        },
        {
          status: 'unknown',
          reason: 'TRIP_COMPLETION_UNAVAILABLE',
          blocking: true,
        },
      ],
      [
        'preserves date-only behavior by rejecting timezone-qualified expiry timestamps',
        {
          passportExpiry: '2027-06-18T23:30:00-05:00',
        },
        {
          status: 'invalid',
          reason: 'INVALID_DATE',
          blocking: true,
        },
      ],
    ])('%s', (_name, overrides, expected) => {
      const result = evaluator.evaluate(
        createInput({
          segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }],
          tripCompletionDate: overrides.tripCompletionDate ?? '2026-12-20',
          advisoryBufferDays: overrides.advisoryBufferDays ?? DEFAULT_PASSPORT_ADVISORY_BUFFER_DAYS,
          passengers: [createPassenger({ passportExpiry: overrides.passportExpiry })],
        }),
      );

      expect(findField(result, 1, 'travel_document', 'passportExpiry')).toMatchObject(expected);
    });
  });

  describe('T028 unknown-scope and deferred-entry rules', () => {
    it('treats missing origin country as blocking UNKNOWN scope', () => {
      const result = evaluator.evaluate(
        createInput({
          segments: [{ originCountryCode: null, destinationCountryCode: 'US' }],
        }),
      );

      expect(result.scope).toBe('UNKNOWN');
      expect(result.ready).toBe(false);
      expect(findField(result, 1, 'itinerary', 'scope')).toMatchObject({
        status: 'unknown',
        reason: 'AIRPORT_COUNTRY_UNAVAILABLE',
        blocking: true,
      });
      expect(Object.prototype.hasOwnProperty.call(result, 'statusCode')).toBe(false);
    });

    it('treats missing destination country as blocking UNKNOWN scope without probing provider callbacks or services', () => {
      const forbiddenCallback = jest.fn();
      const baseInput = createInput({
        segments: [{ originCountryCode: 'US', destinationCountryCode: null }],
        entryEligibility: { include: true },
      });
      const guardedInput = new Proxy(
        {
          ...baseInput,
          segments: [
            new Proxy(
              {
                ...baseInput.segments[0],
                fillMissingCountry: forbiddenCallback,
              },
              {
                get(target, property, receiver) {
                  if (property === 'fillMissingCountry') {
                    throw new Error('Unexpected provider callback access');
                  }

                  return Reflect.get(target, property, receiver);
                },
              },
            ),
          ],
          entryEligibility: new Proxy(
            {
              include: true,
              resolveAuthoritativeResult: forbiddenCallback,
            },
            {
              get(target, property, receiver) {
                if (property === 'resolveAuthoritativeResult') {
                  throw new Error('Unexpected entry-eligibility callback access');
                }

                return Reflect.get(target, property, receiver);
              },
            },
          ),
          airportsService: forbiddenCallback,
        },
        {
          get(target, property, receiver) {
            if (property === 'airportsService') {
              throw new Error('Unexpected service dependency access');
            }

            return Reflect.get(target, property, receiver);
          },
        },
      ) as BookingReadinessEvaluationInput;
      const result = evaluator.evaluate(
        guardedInput,
      );

      expect(result.scope).toBe('UNKNOWN');
      expect(result.ready).toBe(false);
      expect(findField(result, 1, 'itinerary', 'scope')).toMatchObject({
        status: 'unknown',
        reason: 'AIRPORT_COUNTRY_UNAVAILABLE',
        blocking: true,
      });
      expect(findField(result, 1, 'entry_eligibility', 'destinationEntryEligibility')).toMatchObject({
        status: 'unknown',
        reason: 'ENTRY_ELIGIBILITY_UNKNOWN',
        blocking: false,
      });
      expect(forbiddenCallback).not.toHaveBeenCalled();
    });

    it('projects deferred entry eligibility as non-blocking unknown without changing scope or readiness', () => {
      const domesticResult = evaluator.evaluate(
        createInput({
          entryEligibility: { include: true },
        }),
      );

      const internationalResult = evaluator.evaluate(
        createInput({
          segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }],
          entryEligibility: { include: true },
        }),
      );

      expect(domesticResult.scope).toBe('DOMESTIC');
      expect(domesticResult.ready).toBe(true);
      expect(findField(domesticResult, 1, 'entry_eligibility', 'destinationEntryEligibility')).toMatchObject({
        status: 'unknown',
        reason: 'ENTRY_ELIGIBILITY_UNKNOWN',
        blocking: false,
      });

      expect(internationalResult.scope).toBe('INTERNATIONAL');
      expect(internationalResult.ready).toBe(true);
      expect(findField(internationalResult, 1, 'entry_eligibility', 'destinationEntryEligibility')).toMatchObject({
        status: 'unknown',
        reason: 'ENTRY_ELIGIBILITY_UNKNOWN',
        blocking: false,
      });
    });

    it('accepts an already-known safe entry-eligibility result without changing readiness', () => {
      const result = evaluator.evaluate(
        createInput({
          segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }],
          entryEligibility: {
            include: true,
            result: {
              status: 'filled',
              reason: null,
              blocking: false,
            },
          },
        }),
      );

      expect(result.scope).toBe('INTERNATIONAL');
      expect(result.ready).toBe(true);
      expect(findField(result, 1, 'entry_eligibility', 'destinationEntryEligibility')).toMatchObject({
        status: 'filled',
        reason: null,
        blocking: false,
      });
    });
  });
});

describe('parseBookingReadinessConfig', () => {
  it('defaults to 180 when PASSPORT_ADVISORY_BUFFER_DAYS is missing', () => {
    expect(parseBookingReadinessConfig({})).toEqual({
      passportAdvisoryBufferDays: DEFAULT_PASSPORT_ADVISORY_BUFFER_DAYS,
    });
  });

  it('accepts valid integer values', () => {
    expect(parseBookingReadinessConfig({ PASSPORT_ADVISORY_BUFFER_DAYS: '45' })).toEqual({
      passportAdvisoryBufferDays: 45,
    });
  });

  it('clamps negative values to the documented minimum', () => {
    expect(parseBookingReadinessConfig({ PASSPORT_ADVISORY_BUFFER_DAYS: '-5' })).toEqual({
      passportAdvisoryBufferDays: MIN_PASSPORT_ADVISORY_BUFFER_DAYS,
    });
  });

  it('normalizes fractional values deterministically', () => {
    expect(parseBookingReadinessConfig({ PASSPORT_ADVISORY_BUFFER_DAYS: '45.9' })).toEqual({
      passportAdvisoryBufferDays: 45,
    });
  });

  it('falls back safely for non-numeric values', () => {
    expect(parseBookingReadinessConfig({ PASSPORT_ADVISORY_BUFFER_DAYS: 'abc' })).toEqual({
      passportAdvisoryBufferDays: DEFAULT_PASSPORT_ADVISORY_BUFFER_DAYS,
    });
  });

  it('clamps extremely large values to the documented maximum', () => {
    expect(parseBookingReadinessConfig({ PASSPORT_ADVISORY_BUFFER_DAYS: '999999' })).toEqual({
      passportAdvisoryBufferDays: MAX_PASSPORT_ADVISORY_BUFFER_DAYS,
    });
  });

  it('uses the parsed buffer passed into the evaluator instead of reading process.env inside evaluation', () => {
    const previousPassportAdvisoryBufferDays = process.env.PASSPORT_ADVISORY_BUFFER_DAYS;

    try {
      process.env.PASSPORT_ADVISORY_BUFFER_DAYS = '999999';

      const config = parseBookingReadinessConfig({ PASSPORT_ADVISORY_BUFFER_DAYS: '10' });
      const evaluator = new BookingReadinessEvaluator();
      const result = evaluator.evaluate(
        createInput({
          segments: [{ originCountryCode: 'US', destinationCountryCode: 'CA' }],
          advisoryBufferDays: config.passportAdvisoryBufferDays,
          passengers: [createPassenger({ passportExpiry: '2026-12-25' })],
        }),
      );

      expect(findField(result, 1, 'travel_document', 'passportExpiry')).toMatchObject({
        status: 'warning',
        reason: 'PASSPORT_VALIDITY_REQUIRES_VERIFICATION',
        blocking: false,
      });
    } finally {
      if (previousPassportAdvisoryBufferDays === undefined) {
        delete process.env.PASSPORT_ADVISORY_BUFFER_DAYS;
      } else {
        process.env.PASSPORT_ADVISORY_BUFFER_DAYS = previousPassportAdvisoryBufferDays;
      }
    }
  });
});
