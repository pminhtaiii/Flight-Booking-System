import {
  FlightOffer,
  FlightSegment,
  FlightOfferPassenger,
  FlightOfferConditions,
} from './flight-search.port';
import {
  generateDeterministicUUID,
  normalizeDuffelOffer,
  normalizeStoredOffer,
  normalizeFlightOffers,
  FlightOfferNormalizer,
} from './flight-offer.normalizer';

// Strongly typed fixtures for Duffel raw API payloads (zero `any`)
type RawDuffelPassenger = {
  id: string;
  type: string;
};

type RawDuffelPlace = {
  id?: string;
  name?: string;
  iata_code: string;
  type?: string;
};

type RawDuffelCarrier = {
  id?: string;
  name?: string;
  iata_code?: string;
};

type RawDuffelBaggage = {
  type: string;
  quantity?: number;
  weight?: number;
  weight_unit?: string;
};

type RawDuffelSegmentPassenger = {
  passenger_id?: string;
  cabin_class?: string;
  baggages?: RawDuffelBaggage[];
};

type RawDuffelAircraft = {
  id?: string;
  name?: string;
  iata_code?: string;
};

type RawDuffelSegment = {
  id?: string;
  duration?: string;
  departing_at?: string;
  arriving_at?: string;
  origin?: RawDuffelPlace;
  origin_terminal?: string | null;
  destination?: RawDuffelPlace;
  destination_terminal?: string | null;
  marketing_carrier?: RawDuffelCarrier;
  operating_carrier?: RawDuffelCarrier;
  marketing_carrier_flight_number?: string;
  aircraft?: RawDuffelAircraft | null;
  passengers?: RawDuffelSegmentPassenger[];
};

type RawDuffelSlice = {
  id?: string;
  duration?: string;
  origin?: RawDuffelPlace;
  destination?: RawDuffelPlace;
  segments?: RawDuffelSegment[];
};

type RawDuffelConditions = {
  refund_before_departure?: {
    allowed: boolean;
    penalty_amount?: string | null;
    penalty_currency?: string | null;
  } | null;
  change_before_departure?: {
    allowed: boolean;
    penalty_amount?: string | null;
    penalty_currency?: string | null;
  } | null;
};

type RawDuffelOffer = {
  id: string;
  total_amount: string;
  total_currency: string;
  expires_at?: string | null;
  passenger_identity_documents_required?: boolean;
  passengers?: RawDuffelPassenger[];
  slices?: RawDuffelSlice[];
  conditions?: RawDuffelConditions | null;
};

const createMockRawOffer = (overrides: Partial<RawDuffelOffer> = {}): RawDuffelOffer => {
  const baseOffer: RawDuffelOffer = {
    id: 'off_live_duffel_100',
    total_amount: '425.50',
    total_currency: 'USD',
    expires_at: '2026-10-01T23:59:59Z',
    passenger_identity_documents_required: false,
    passengers: [
      { id: 'pas_adult_1', type: 'adult' },
      { id: 'pas_child_1', type: 'child' },
      { id: 'pas_infant_1', type: 'infant_without_seat' },
    ],
    conditions: {
      refund_before_departure: {
        allowed: true,
        penalty_amount: '50.00',
        penalty_currency: 'USD',
      },
      change_before_departure: {
        allowed: true,
        penalty_amount: '25.00',
        penalty_currency: 'USD',
      },
    },
    slices: [
      {
        id: 'sli_outbound_1',
        duration: 'PT5H30M',
        origin: { iata_code: 'SFO', name: 'San Francisco International' },
        destination: { iata_code: 'JFK', name: 'John F Kennedy International' },
        segments: [
          {
            id: 'seg_out_leg1',
            duration: 'PT2H30M',
            departing_at: '2026-10-15T08:00:00',
            arriving_at: '2026-10-15T10:30:00',
            origin: { iata_code: 'SFO', name: 'San Francisco International' },
            origin_terminal: '2',
            destination: { iata_code: 'ORD', name: "O'Hare International" },
            destination_terminal: '1',
            marketing_carrier: { iata_code: 'UA', name: 'United Airlines' },
            operating_carrier: { iata_code: 'UA', name: 'United Airlines' },
            marketing_carrier_flight_number: '101',
            aircraft: { iata_code: '320', name: 'Airbus A320' },
            passengers: [
              {
                passenger_id: 'pas_adult_1',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
              {
                passenger_id: 'pas_child_1',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
            ],
          },
          {
            id: 'seg_out_leg2',
            duration: 'PT2H15M',
            departing_at: '2026-10-15T12:00:00',
            arriving_at: '2026-10-15T15:15:00',
            origin: { iata_code: 'ORD', name: "O'Hare International" },
            origin_terminal: '1',
            destination: { iata_code: 'JFK', name: 'John F Kennedy International' },
            destination_terminal: '4',
            marketing_carrier: { iata_code: 'UA', name: 'United Airlines' },
            operating_carrier: { iata_code: 'UA', name: 'United Airlines' },
            marketing_carrier_flight_number: '202',
            aircraft: { iata_code: '738', name: 'Boeing 737-800' },
            passengers: [
              {
                passenger_id: 'pas_adult_1',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
              {
                passenger_id: 'pas_child_1',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
            ],
          },
        ],
      },
      {
        id: 'sli_return_1',
        duration: 'PT6H00M',
        origin: { iata_code: 'JFK', name: 'John F Kennedy International' },
        destination: { iata_code: 'SFO', name: 'San Francisco International' },
        segments: [
          {
            id: 'seg_ret_leg1',
            duration: 'PT6H00M',
            departing_at: '2026-10-22T09:00:00',
            arriving_at: '2026-10-22T12:00:00',
            origin: { iata_code: 'JFK', name: 'John F Kennedy International' },
            origin_terminal: '7',
            destination: { iata_code: 'SFO', name: 'San Francisco International' },
            destination_terminal: '3',
            marketing_carrier: { iata_code: 'BA', name: 'British Airways' },
            operating_carrier: { iata_code: 'BA', name: 'British Airways' },
            marketing_carrier_flight_number: '303',
            aircraft: { iata_code: '77W', name: 'Boeing 777-300ER' },
            passengers: [
              {
                passenger_id: 'pas_adult_1',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
            ],
          },
        ],
      },
    ],
  };

  return { ...baseOffer, ...overrides };
};

describe('FlightOfferNormalizer (T014 Normalization Parity & Stored Snapshot Tests)', () => {
  describe('Deterministic UUID Generation', () => {
    it('generates consistent RFC 4122 v4 UUID from upstream offer ID', () => {
      const offerId = 'off_test_consistent_123';
      const uuid1 = generateDeterministicUUID(offerId);
      const uuid2 = generateDeterministicUUID(offerId);

      expect(uuid1).toBe(uuid2);
      expect(uuid1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('generates distinct UUIDs for different upstream offer IDs', () => {
      const uuidA = generateDeterministicUUID('off_upstream_aaa');
      const uuidB = generateDeterministicUUID('off_upstream_bbb');

      expect(uuidA).not.toBe(uuidB);
    });
  });

  describe('Live Duffel Offer Normalization (normalizeDuffelOffer)', () => {
    it('normalizes a complete multi-slice, multi-passenger Duffel offer with full parity', () => {
      const rawOffer = createMockRawOffer();
      const expectedUUID = generateDeterministicUUID(rawOffer.id);

      const normalized = normalizeDuffelOffer(rawOffer, 0);

      expect(normalized).not.toBeNull();
      const offer = normalized as FlightOffer;

      // Identity & basic pricing
      expect(offer.id).toBe(expectedUUID);
      expect(offer.supplierOfferId).toBe('off_live_duffel_100');
      expect(offer.totalAmount).toBe('425.50');
      expect(offer.price).toBe(425.5);
      expect(offer.currency).toBe('USD');
      expect(offer.offerExpiresAt).toBe('2026-10-01T23:59:59Z');

      // Passenger mapping: supplierPassengerId and typed enum ('ADULT', 'CHILD', 'INFANT')
      expect(offer.passengers).toHaveLength(3);
      expect(offer.passengers[0]).toEqual<FlightOfferPassenger>({
        supplierPassengerId: 'pas_adult_1',
        type: 'ADULT',
      });
      expect(offer.passengers[1]).toEqual<FlightOfferPassenger>({
        supplierPassengerId: 'pas_child_1',
        type: 'CHILD',
      });
      expect(offer.passengers[2]).toEqual<FlightOfferPassenger>({
        supplierPassengerId: 'pas_infant_1',
        type: 'INFANT',
      });

      // Outbound overview mapping
      expect(offer.airline).toBe('United Airlines');
      expect(offer.flightNumber).toBe('UA101');
      expect(offer.departureAirport).toBe('SFO');
      expect(offer.arrivalAirport).toBe('JFK');
      expect(offer.departureTime).toBe('2026-10-15T08:00:00');
      expect(offer.arrivalTime).toBe('2026-10-15T15:15:00');
      expect(offer.duration).toBe(330); // 5h 30m = 330 minutes
      expect(offer.stops).toBe(1); // 2 outbound segments = 1 stop
      expect(offer.fareClass).toBe('Economy');
      expect(offer.baggageAllowance).toBe('1 checked bag(s)');

      // Outbound segments mapping
      expect(offer.segments).toHaveLength(2);
      expect(offer.segments[0]).toEqual<FlightSegment>({
        supplierSegmentId: 'seg_out_leg1',
        carrierCode: 'UA',
        flightNumber: '101',
        operatingCarrier: 'United Airlines',
        departureAirport: 'SFO',
        departureTerminal: '2',
        departureTime: '2026-10-15T08:00:00',
        arrivalAirport: 'ORD',
        arrivalTerminal: '1',
        arrivalTime: '2026-10-15T10:30:00',
        duration: 150,
        aircraft: 'A320',
        cabinClass: 'economy',
      });

      expect(offer.segments[1]).toEqual<FlightSegment>({
        supplierSegmentId: 'seg_out_leg2',
        carrierCode: 'UA',
        flightNumber: '202',
        operatingCarrier: 'United Airlines',
        departureAirport: 'ORD',
        departureTerminal: '1',
        departureTime: '2026-10-15T12:00:00',
        arrivalAirport: 'JFK',
        arrivalTerminal: '4',
        arrivalTime: '2026-10-15T15:15:00',
        duration: 135,
        aircraft: 'Boeing 737-800',
        cabinClass: 'economy',
      });

      // Return segments mapping
      expect(offer.returnSegments).not.toBeNull();
      expect(offer.returnSegments).toHaveLength(1);
      expect(offer.returnSegments![0]).toEqual<FlightSegment>({
        supplierSegmentId: 'seg_ret_leg1',
        carrierCode: 'BA',
        flightNumber: '303',
        operatingCarrier: 'British Airways',
        departureAirport: 'JFK',
        departureTerminal: '7',
        departureTime: '2026-10-22T09:00:00',
        arrivalAirport: 'SFO',
        arrivalTerminal: '3',
        arrivalTime: '2026-10-22T12:00:00',
        duration: 360,
        aircraft: 'Boeing 777-300ER',
        cabinClass: 'economy',
      });

      // Conditions mapping
      expect(offer.conditions).toEqual<FlightOfferConditions>({
        refundable: true,
        changeable: true,
        changeBeforeDeparture: {
          allowed: true,
          penaltyAmount: '25.00',
          penaltyCurrency: 'USD',
        },
      });

      // MatchInput metadata mapping
      expect(offer.matchInput).toEqual({
        id: expectedUUID,
        price: 425.5,
        currency: 'USD',
        stops: 1,
        duration: 690, // aggregate duration across slices: 330 + 360 = 690 min
        outboundDepartureHour: 8,
        outboundArrivalHour: 15,
        carrierCodes: ['UA', 'BA'],
        carrierNamesByCode: {
          UA: 'United Airlines',
          BA: 'British Airways',
        },
        cabinClass: 'economy',
        hasCheckedBaggage: true,
        originalIndex: 0,
      });

      // Preserves raw supplier payload intact as write-only evidence
      expect(offer.rawSupplierPayload).toEqual(rawOffer);
    });

    it('sets returnSegments to null for one-way flight offers', () => {
      const rawOffer = createMockRawOffer({
        slices: [createMockRawOffer().slices![0]],
      });

      const normalized = normalizeDuffelOffer(rawOffer, 2);

      expect(normalized).not.toBeNull();
      expect(normalized!.returnSegments).toBeNull();
      expect(normalized!.matchInput.originalIndex).toBe(2);
    });

    it('handles weight-based baggage allowances', () => {
      const base = createMockRawOffer();
      base.slices![0].segments![0].passengers![0].baggages = [
        { type: 'checked', weight: 23, weight_unit: 'kg' },
      ];

      const normalized = normalizeDuffelOffer(base, 0);

      expect(normalized).not.toBeNull();
      expect(normalized!.baggageAllowance).toBe('23kg checked');
    });

    it('defaults conditions to false and null when conditions are omitted or partial', () => {
      const rawOffer = createMockRawOffer({
        conditions: null,
      });

      const normalized = normalizeDuffelOffer(rawOffer, 0);

      expect(normalized).not.toBeNull();
      expect(normalized!.conditions).toEqual<FlightOfferConditions>({
        refundable: false,
        changeable: false,
        changeBeforeDeparture: null,
      });
    });

    it('FlightOfferNormalizer class static method behaves identically to standalone function', () => {
      const rawOffer = createMockRawOffer({ id: 'off_class_test' });

      const fromFunction = normalizeDuffelOffer(rawOffer, 1);
      const fromClass = FlightOfferNormalizer.normalizeDuffelOffer(rawOffer, 1);

      expect(fromClass).toEqual(fromFunction);
    });
  });

  describe('Batch Offer Normalization (normalizeFlightOffers)', () => {
    it('preserves canonical array order and assigns sequential originalIndex', () => {
      const rawOffers = [
        createMockRawOffer({ id: 'off_batch_0' }),
        createMockRawOffer({ id: 'off_batch_1' }),
        createMockRawOffer({ id: 'off_batch_2' }),
      ];

      const result = normalizeFlightOffers(rawOffers);

      expect(result.normalizedOffers).toHaveLength(3);
      expect(result.normalizedOffers[0].supplierOfferId).toBe('off_batch_0');
      expect(result.normalizedOffers[0].matchInput.originalIndex).toBe(0);
      expect(result.normalizedOffers[1].supplierOfferId).toBe('off_batch_1');
      expect(result.normalizedOffers[1].matchInput.originalIndex).toBe(1);
      expect(result.normalizedOffers[2].supplierOfferId).toBe('off_batch_2');
      expect(result.normalizedOffers[2].matchInput.originalIndex).toBe(2);
      expect(result.droppedCount).toBe(0);
      expect(result.currency).toBe('USD');
    });

    it('locks currency from the first offer and drops subsequent mixed currencies', () => {
      const rawOffers = [
        createMockRawOffer({ id: 'off_usd_1', total_currency: 'USD' }),
        createMockRawOffer({ id: 'off_eur_1', total_currency: 'EUR' }),
        createMockRawOffer({ id: 'off_usd_2', total_currency: 'USD' }),
      ];

      const result = normalizeFlightOffers(rawOffers);

      expect(result.currency).toBe('USD');
      expect(result.normalizedOffers).toHaveLength(2);
      expect(result.normalizedOffers[0].supplierOfferId).toBe('off_usd_1');
      expect(result.normalizedOffers[1].supplierOfferId).toBe('off_usd_2');
      expect(result.droppedCount).toBe(1);
      expect(result.rejectionCounts['MIXED_CURRENCY']).toBe(1);
    });

    it('FlightOfferNormalizer.normalizeFlightOffers class method matches standalone function', () => {
      const rawOffers = [createMockRawOffer({ id: 'off_batch_test' })];

      const fromFunction = normalizeFlightOffers(rawOffers);
      const fromClass = FlightOfferNormalizer.normalizeFlightOffers(rawOffers);

      expect(fromClass).toEqual(fromFunction);
    });
  });

  describe('Legacy Stored-Offer Normalization (normalizeStoredOffer)', () => {
    describe('Parity with Live Normalization on Valid Snapshot', () => {
      it('decodes a valid stored raw offer snapshot into neutral FlightOffer identical to live normalization', () => {
        const storedSnapshot = createMockRawOffer({ id: 'off_stored_snapshot_1' });
        const expectedUUID = generateDeterministicUUID(storedSnapshot.id);

        const normalized = normalizeStoredOffer(storedSnapshot);

        expect(normalized).not.toBeNull();
        const offer = normalized as FlightOffer;

        expect(offer.id).toBe(expectedUUID);
        expect(offer.supplierOfferId).toBe('off_stored_snapshot_1');
        expect(offer.totalAmount).toBe('425.50');
        expect(offer.price).toBe(425.5);
        expect(offer.currency).toBe('USD');
        expect(offer.passengers).toHaveLength(3);
        expect(offer.passengers[0].supplierPassengerId).toBe('pas_adult_1');
        expect(offer.passengers[0].type).toBe('ADULT');
        expect(offer.segments).toHaveLength(2);
        expect(offer.returnSegments).toHaveLength(1);
        expect(offer.conditions.refundable).toBe(true);
        expect(offer.conditions.changeable).toBe(true);
        expect(offer.matchInput.originalIndex).toBe(0);
        expect(offer.rawSupplierPayload).toEqual(storedSnapshot);
      });

      it('FlightOfferNormalizer.normalizeStoredOffer class method matches standalone function', () => {
        const storedSnapshot = createMockRawOffer({ id: 'off_stored_class_test' });

        const fromFunction = normalizeStoredOffer(storedSnapshot);
        const fromClass = FlightOfferNormalizer.normalizeStoredOffer(storedSnapshot);

        expect(fromClass).toEqual(fromFunction);
      });
    });

    describe('Fail-Closed Rejection on Malformed & Truncated Payloads', () => {
      it('returns null fail-closed when snapshot is null or undefined without throwing', () => {
        expect(normalizeStoredOffer(null)).toBeNull();
        expect(normalizeStoredOffer(undefined)).toBeNull();
      });

      it('returns null fail-closed when snapshot is primitive type (string, number, boolean)', () => {
        expect(normalizeStoredOffer('{"truncated": true')).toBeNull();
        expect(normalizeStoredOffer(12345)).toBeNull();
        expect(normalizeStoredOffer(true)).toBeNull();
        expect(normalizeStoredOffer(false)).toBeNull();
      });

      it('returns null fail-closed when snapshot is an array instead of an object', () => {
        expect(normalizeStoredOffer([])).toBeNull();
        expect(normalizeStoredOffer([createMockRawOffer()])).toBeNull();
      });

      it('returns null fail-closed when snapshot is an empty object or missing id', () => {
        expect(normalizeStoredOffer({})).toBeNull();
        expect(normalizeStoredOffer({ id: '' })).toBeNull();
        expect(normalizeStoredOffer({ id: '   ' })).toBeNull();
        expect(normalizeStoredOffer({ id: 12345 })).toBeNull();
      });

      it('returns null fail-closed when slices array is missing, null, or empty', () => {
        expect(normalizeStoredOffer({ id: 'off_bad', total_amount: '100', total_currency: 'USD' })).toBeNull();
        expect(
          normalizeStoredOffer({ id: 'off_bad', slices: null, total_amount: '100', total_currency: 'USD' }),
        ).toBeNull();
        expect(
          normalizeStoredOffer({ id: 'off_bad', slices: [], total_amount: '100', total_currency: 'USD' }),
        ).toBeNull();
      });

      it('returns null fail-closed when a slice is malformed, missing, or has empty segments', () => {
        expect(
          normalizeStoredOffer({
            id: 'off_bad',
            total_amount: '100',
            total_currency: 'USD',
            slices: [null],
          }),
        ).toBeNull();

        expect(
          normalizeStoredOffer({
            id: 'off_bad',
            total_amount: '100',
            total_currency: 'USD',
            slices: [{}],
          }),
        ).toBeNull();

        expect(
          normalizeStoredOffer({
            id: 'off_bad',
            total_amount: '100',
            total_currency: 'USD',
            slices: [{ segments: [] }],
          }),
        ).toBeNull();

        expect(
          normalizeStoredOffer({
            id: 'off_bad',
            total_amount: '100',
            total_currency: 'USD',
            slices: [{ segments: [null] }],
          }),
        ).toBeNull();
      });

      it('returns null fail-closed when return slice has missing or empty segments in round-trip offer', () => {
        const rawOffer = createMockRawOffer();
        const malformedRoundTrip = {
          ...rawOffer,
          slices: [
            rawOffer.slices![0],
            { id: 'sli_ret_broken', segments: [] },
          ],
        };

        expect(normalizeStoredOffer(malformedRoundTrip)).toBeNull();
      });
    });

    describe('Fail-Closed Rejection on Invalid Timestamps', () => {
      it('returns null fail-closed when departure timestamp is non-ISO format', () => {
        const offer = createMockRawOffer();
        offer.slices![0].segments![0].departing_at = 'not-a-valid-datetime';

        expect(normalizeStoredOffer(offer)).toBeNull();
      });

      it('returns null fail-closed when arrival timestamp is non-ISO format', () => {
        const offer = createMockRawOffer();
        offer.slices![0].segments![offer.slices![0].segments!.length - 1].arriving_at =
          'invalid-arrival-timestamp';

        expect(normalizeStoredOffer(offer)).toBeNull();
      });

      it('returns null fail-closed when calendar date does not exist (e.g. Feb 30th)', () => {
        const offer = createMockRawOffer();
        offer.slices![0].segments![0].departing_at = '2026-02-30T08:00:00Z';

        expect(normalizeStoredOffer(offer)).toBeNull();
      });

      it('returns null fail-closed when timestamp has invalid month or hour', () => {
        const offer = createMockRawOffer();
        offer.slices![0].segments![0].departing_at = '2026-13-10T25:00:00';

        expect(normalizeStoredOffer(offer)).toBeNull();
      });
    });

    describe('Fail-Closed Rejection on Invalid Price or Currency', () => {
      it('returns null fail-closed when total_amount is missing, empty, or non-numeric', () => {
        expect(
          normalizeStoredOffer(createMockRawOffer({ total_amount: '' })),
        ).toBeNull();
        expect(
          normalizeStoredOffer(createMockRawOffer({ total_amount: '   ' })),
        ).toBeNull();
        expect(
          normalizeStoredOffer(createMockRawOffer({ total_amount: 'FREE' })),
        ).toBeNull();
      });

      it('returns null fail-closed when total_amount is zero or negative', () => {
        expect(
          normalizeStoredOffer(createMockRawOffer({ total_amount: '0.00' })),
        ).toBeNull();
        expect(
          normalizeStoredOffer(createMockRawOffer({ total_amount: '-150.00' })),
        ).toBeNull();
      });

      it('returns null fail-closed when total_currency is missing or empty', () => {
        expect(
          normalizeStoredOffer(createMockRawOffer({ total_currency: '' })),
        ).toBeNull();
        expect(
          normalizeStoredOffer(createMockRawOffer({ total_currency: '   ' })),
        ).toBeNull();
      });
    });
  });
});
