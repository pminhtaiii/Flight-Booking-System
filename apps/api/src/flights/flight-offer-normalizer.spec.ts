import { DuffelOffer } from '@/duffel/duffel.types';
import {
  normalizeFlightOffers,
  normalizeOffer,
  parseISO8601Duration,
  generateDeterministicUUID,
} from './flight-offer-normalizer';

describe('FlightOfferNormalizer (T015)', () => {
  const createMockOffer = (overrides: Partial<DuffelOffer> = {}): DuffelOffer => {
    const defaultOffer: DuffelOffer = {
      id: 'off_00001',
      total_amount: '350.00',
      total_currency: 'USD',
      passenger_identity_documents_required: false,
      passengers: [
        {
          id: 'pas_001',
          type: 'adult',
        },
      ],
      slices: [
        {
          id: 'sli_001',
          duration: 'PT2H30M',
          origin: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
          destination: { id: 'plc_jfk', name: 'John F Kennedy', iata_code: 'JFK', type: 'airport' },
          segments: [
            {
              id: 'seg_001',
              duration: 'PT2H30M',
              departing_at: '2026-09-01T08:30:00',
              arriving_at: '2026-09-01T17:00:00',
              origin: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
              destination: { id: 'plc_jfk', name: 'John F Kennedy', iata_code: 'JFK', type: 'airport' },
              marketing_carrier: { id: 'arl_ba', name: 'British Airways', iata_code: 'BA' },
              operating_carrier: { id: 'arl_ba', name: 'British Airways', iata_code: 'BA' },
              marketing_carrier_flight_number: '123',
              passengers: [
                {
                  passenger_id: 'pas_001',
                  cabin_class: 'economy',
                  baggages: [{ type: 'checked', quantity: 1 }],
                },
              ],
            },
          ],
        },
      ],
    };

    return { ...defaultOffer, ...overrides };
  };

  describe('Deterministic ID Generation', () => {
    it('generates consistent deterministic UUID v4 format from offer ID', () => {
      const offerId = 'off_sample_12345';
      const uuid1 = generateDeterministicUUID(offerId);
      const uuid2 = generateDeterministicUUID(offerId);

      expect(uuid1).toBe(uuid2);
      expect(uuid1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('generates different UUIDs for different offer IDs', () => {
      const uuidA = generateDeterministicUUID('off_001');
      const uuidB = generateDeterministicUUID('off_002');

      expect(uuidA).not.toBe(uuidB);
    });

    it('maps offer.id to deterministic id on normalized input', () => {
      const offer = createMockOffer({ id: 'off_unique_999' });
      const normalized = normalizeOffer(offer, 0);

      expect(normalized).not.toBeNull();
      expect(normalized?.id).toBe(generateDeterministicUUID('off_unique_999'));
    });
  });

  describe('Canonical Order & Original Index Preservation', () => {
    it('preserves originalIndex matching the position in the raw offers array', () => {
      const offers = [
        createMockOffer({ id: 'off_1' }),
        createMockOffer({ id: 'off_2' }),
        createMockOffer({ id: 'off_3' }),
      ];

      const result = normalizeFlightOffers(offers);

      expect(result.normalizedOffers).toHaveLength(3);
      expect(result.normalizedOffers[0].originalIndex).toBe(0);
      expect(result.normalizedOffers[1].originalIndex).toBe(1);
      expect(result.normalizedOffers[2].originalIndex).toBe(2);
      expect(result.droppedCount).toBe(0);
      expect(result.currency).toBe('USD');
    });
  });

  describe('Price and Currency Extraction', () => {
    it('parses total_amount as floating point number and extracts total_currency', () => {
      const offer = createMockOffer({
        total_amount: '1249.99',
        total_currency: 'EUR',
      });

      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.price).toBe(1249.99);
      expect(normalized?.currency).toBe('EUR');
    });
  });

  describe('Full-Itinerary Aggregate Duration', () => {
    it('parses ISO8601 duration strings correctly', () => {
      expect(parseISO8601Duration('PT2H30M')).toBe(150);
      expect(parseISO8601Duration('PT45M')).toBe(45);
      expect(parseISO8601Duration('PT5H')).toBe(300);
      expect(parseISO8601Duration('P1DT2H30M')).toBe(1590);
      expect(parseISO8601Duration('P2D')).toBe(2880);
      expect(parseISO8601Duration('')).toBe(0);
      expect(parseISO8601Duration(null)).toBe(0);
      expect(parseISO8601Duration(undefined)).toBe(0);
    });

    it('sums duration across multiple slices for round-trip itineraries', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_outbound',
            duration: 'PT3H15M', // 195 mins
            origin: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'John F Kennedy', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT3H15M',
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T14:15:00',
                origin: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'John F Kennedy', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_ua', name: 'United', iata_code: 'UA' },
                operating_carrier: { id: 'arl_ua', name: 'United', iata_code: 'UA' },
                marketing_carrier_flight_number: '100',
              },
            ],
          },
          {
            id: 'sli_inbound',
            duration: 'PT2H45M', // 165 mins
            origin: { id: 'plc_jfk', name: 'John F Kennedy', iata_code: 'JFK', type: 'airport' },
            destination: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
            segments: [
              {
                id: 'seg_2',
                duration: 'PT2H45M',
                departing_at: '2026-09-05T10:00:00',
                arriving_at: '2026-09-05T15:45:00',
                origin: { id: 'plc_jfk', name: 'John F Kennedy', iata_code: 'JFK', type: 'airport' },
                destination: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
                marketing_carrier: { id: 'arl_ua', name: 'United', iata_code: 'UA' },
                operating_carrier: { id: 'arl_ua', name: 'United', iata_code: 'UA' },
                marketing_carrier_flight_number: '200',
              },
            ],
          },
        ],
      });

      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.duration).toBe(360); // 195 + 165 = 360
    });
  });

  describe('Full-Itinerary Aggregate Stops', () => {
    it('calculates 0 stops for a direct one-way flight', () => {
      const offer = createMockOffer();
      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.stops).toBe(0);
    });

    it('calculates 1 stop for a 2-segment one-way flight', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT6H00M',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT2H30M',
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T10:30:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_ord', name: 'ORD', iata_code: 'ORD', type: 'airport' },
                marketing_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                operating_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                marketing_carrier_flight_number: '1',
              },
              {
                id: 'seg_2',
                duration: 'PT2H30M',
                departing_at: '2026-09-01T12:00:00',
                arriving_at: '2026-09-01T14:30:00',
                origin: { id: 'plc_ord', name: 'ORD', iata_code: 'ORD', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                operating_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                marketing_carrier_flight_number: '2',
              },
            ],
          },
        ],
      });

      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.stops).toBe(1);
    });

    it('sums stops across all slices in round-trip (e.g. 1 stop outbound + 2 stops return = 3 stops)', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_outbound',
            duration: 'PT6H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT3H',
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T11:00:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_ord', name: 'ORD', iata_code: 'ORD', type: 'airport' },
                marketing_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                operating_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                marketing_carrier_flight_number: '1',
              },
              {
                id: 'seg_2',
                duration: 'PT3H',
                departing_at: '2026-09-01T12:00:00',
                arriving_at: '2026-09-01T15:00:00',
                origin: { id: 'plc_ord', name: 'ORD', iata_code: 'ORD', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                operating_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                marketing_carrier_flight_number: '2',
              },
            ],
          },
          {
            id: 'sli_return',
            duration: 'PT9H',
            origin: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            destination: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            segments: [
              {
                id: 'seg_3',
                duration: 'PT2H',
                departing_at: '2026-09-05T08:00:00',
                arriving_at: '2026-09-05T10:00:00',
                origin: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                destination: { id: 'plc_bos', name: 'BOS', iata_code: 'BOS', type: 'airport' },
                marketing_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                operating_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                marketing_carrier_flight_number: '3',
              },
              {
                id: 'seg_4',
                duration: 'PT3H',
                departing_at: '2026-09-05T11:00:00',
                arriving_at: '2026-09-05T14:00:00',
                origin: { id: 'plc_bos', name: 'BOS', iata_code: 'BOS', type: 'airport' },
                destination: { id: 'plc_ord', name: 'ORD', iata_code: 'ORD', type: 'airport' },
                marketing_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                operating_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                marketing_carrier_flight_number: '4',
              },
              {
                id: 'seg_5',
                duration: 'PT3H',
                departing_at: '2026-09-05T15:00:00',
                arriving_at: '2026-09-05T18:00:00',
                origin: { id: 'plc_ord', name: 'ORD', iata_code: 'ORD', type: 'airport' },
                destination: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                marketing_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                operating_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                marketing_carrier_flight_number: '5',
              },
            ],
          },
        ],
      });

      const normalized = normalizeOffer(offer, 0);

      // (2 - 1) + (3 - 1) = 1 + 2 = 3
      expect(normalized?.stops).toBe(3);
    });
  });

  describe('Outbound Local-Clock Facts', () => {
    it('extracts local clock outbound departure hour from first segment departing_at', () => {
      const offer1 = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT5H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT5H',
                departing_at: '2026-09-01T08:30:00',
                arriving_at: '2026-09-01T17:00:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                operating_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                marketing_carrier_flight_number: '1',
              },
            ],
          },
        ],
      });

      expect(normalizeOffer(offer1, 0)?.outboundDepartureHour).toBe(8);

      const offer2 = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT5H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT5H',
                departing_at: '2026-09-01T00:15:00+09:00',
                arriving_at: '2026-09-01T06:00:00+09:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                operating_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                marketing_carrier_flight_number: '1',
              },
            ],
          },
        ],
      });

      expect(normalizeOffer(offer2, 0)?.outboundDepartureHour).toBe(0);

      const offer3 = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT5H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT5H',
                departing_at: '2026-09-01T23:45:00Z',
                arriving_at: '2026-09-02T05:00:00Z',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                operating_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                marketing_carrier_flight_number: '1',
              },
            ],
          },
        ],
      });

      expect(normalizeOffer(offer3, 0)?.outboundDepartureHour).toBe(23);
    });

    it('extracts local clock inbound arrival hour from outbound final segment arriving_at', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT8H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT3H',
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T11:00:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_ord', name: 'ORD', iata_code: 'ORD', type: 'airport' },
                marketing_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                operating_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                marketing_carrier_flight_number: '1',
              },
              {
                id: 'seg_2',
                duration: 'PT3H',
                departing_at: '2026-09-01T13:00:00',
                arriving_at: '2026-09-01T16:45:00',
                origin: { id: 'plc_ord', name: 'ORD', iata_code: 'ORD', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                operating_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                marketing_carrier_flight_number: '2',
              },
            ],
          },
        ],
      });

      expect(normalizeOffer(offer, 0)?.inboundArrivalHour).toBe(16);
    });
  });

  describe('Carrier Codes and Names Collection', () => {
    it('collects, trims, uppercases, and deduplicates all marketing and operating carrier codes across all segments', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT8H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_lhr', name: 'LHR', iata_code: 'LHR', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT4H',
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T12:00:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_aa', name: 'American Airlines', iata_code: ' aa ' },
                operating_carrier: { id: 'arl_ba', name: 'British Airways', iata_code: 'ba' },
                marketing_carrier_flight_number: '100',
              },
              {
                id: 'seg_2',
                duration: 'PT4H',
                departing_at: '2026-09-01T14:00:00',
                arriving_at: '2026-09-01T18:00:00',
                origin: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                destination: { id: 'plc_lhr', name: 'LHR', iata_code: 'LHR', type: 'airport' },
                marketing_carrier: { id: 'arl_ba', name: 'British Airways', iata_code: 'BA' },
                operating_carrier: { id: 'arl_ib', name: 'Iberia', iata_code: 'IB' },
                marketing_carrier_flight_number: '200',
              },
            ],
          },
        ],
      });

      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.carrierCodes).toEqual(['AA', 'BA', 'IB']);
      expect(normalized?.carrierNamesByCode).toEqual({
        AA: 'American Airlines',
        BA: 'British Airways',
        IB: 'Iberia',
      });
    });
  });

  describe('Longest Cabin Class Resolution', () => {
    it('resolves cabin class from the longest segment across all slices', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT10H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_fra', name: 'FRA', iata_code: 'FRA', type: 'airport' },
            segments: [
              {
                id: 'seg_short_feeder',
                duration: 'PT1H30M', // 90 min
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T09:30:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_den', name: 'DEN', iata_code: 'DEN', type: 'airport' },
                marketing_carrier: { id: 'arl_lh', name: 'Lufthansa', iata_code: 'LH' },
                operating_carrier: { id: 'arl_lh', name: 'Lufthansa', iata_code: 'LH' },
                marketing_carrier_flight_number: '1',
                passengers: [
                  {
                    passenger_id: 'pas_1',
                    cabin_class: 'economy',
                  },
                ],
              },
              {
                id: 'seg_long_transatlantic',
                duration: 'PT8H30M', // 510 min
                departing_at: '2026-09-01T11:00:00',
                arriving_at: '2026-09-02T03:30:00',
                origin: { id: 'plc_den', name: 'DEN', iata_code: 'DEN', type: 'airport' },
                destination: { id: 'plc_fra', name: 'FRA', iata_code: 'FRA', type: 'airport' },
                marketing_carrier: { id: 'arl_lh', name: 'Lufthansa', iata_code: 'LH' },
                operating_carrier: { id: 'arl_lh', name: 'Lufthansa', iata_code: 'LH' },
                marketing_carrier_flight_number: '2',
                passengers: [
                  {
                    passenger_id: 'pas_1',
                    cabin_class: 'business',
                  },
                ],
              },
            ],
          },
        ],
      });

      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.cabinClass).toBe('business');
    });

    it('picks the first longest segment cabin when there is a tie in duration', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT8H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_lhr', name: 'LHR', iata_code: 'LHR', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT4H',
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T12:00:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_ord', name: 'ORD', iata_code: 'ORD', type: 'airport' },
                marketing_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                operating_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                marketing_carrier_flight_number: '1',
                passengers: [{ passenger_id: 'pas_1', cabin_class: 'premium_economy' }],
              },
              {
                id: 'seg_2',
                duration: 'PT4H',
                departing_at: '2026-09-01T14:00:00',
                arriving_at: '2026-09-01T18:00:00',
                origin: { id: 'plc_ord', name: 'ORD', iata_code: 'ORD', type: 'airport' },
                destination: { id: 'plc_lhr', name: 'LHR', iata_code: 'LHR', type: 'airport' },
                marketing_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                operating_carrier: { id: 'arl_aa', name: 'AA', iata_code: 'AA' },
                marketing_carrier_flight_number: '2',
                passengers: [{ passenger_id: 'pas_1', cabin_class: 'economy' }],
              },
            ],
          },
        ],
      });

      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.cabinClass).toBe('premium_economy');
    });
  });

  describe('Checked Baggage Tri-State Resolution', () => {
    it('returns true when representative passenger on the longest segment of every slice has at least 1 checked bag', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT5H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT5H',
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T13:00:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                operating_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                marketing_carrier_flight_number: '1',
                passengers: [
                  {
                    passenger_id: 'pas_1',
                    cabin_class: 'economy',
                    baggages: [
                      { type: 'carry_on', quantity: 1 },
                      { type: 'checked', quantity: 2 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });

      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.hasCheckedBaggage).toBe(true);
    });

    it('returns false when longest segment has baggages array with only carry_on bags', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT5H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT5H',
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T13:00:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                operating_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                marketing_carrier_flight_number: '1',
                passengers: [
                  {
                    passenger_id: 'pas_1',
                    cabin_class: 'economy',
                    baggages: [{ type: 'carry_on', quantity: 1 }],
                  },
                ],
              },
            ],
          },
        ],
      });

      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.hasCheckedBaggage).toBe(false);
    });

    it('returns false when checked bag has quantity 0', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT5H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT5H',
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T13:00:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                operating_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                marketing_carrier_flight_number: '1',
                passengers: [
                  {
                    passenger_id: 'pas_1',
                    cabin_class: 'economy',
                    baggages: [{ type: 'checked', quantity: 0 }],
                  },
                ],
              },
            ],
          },
        ],
      });

      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.hasCheckedBaggage).toBe(false);
    });

    it('returns false in multi-slice round-trip when one slice has checked bag but the other does not', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_outbound',
            duration: 'PT5H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT5H',
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T13:00:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                operating_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                marketing_carrier_flight_number: '1',
                passengers: [
                  {
                    passenger_id: 'pas_1',
                    cabin_class: 'economy',
                    baggages: [{ type: 'checked', quantity: 1 }],
                  },
                ],
              },
            ],
          },
          {
            id: 'sli_return',
            duration: 'PT5H',
            origin: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            destination: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            segments: [
              {
                id: 'seg_2',
                duration: 'PT5H',
                departing_at: '2026-09-05T08:00:00',
                arriving_at: '2026-09-05T13:00:00',
                origin: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                destination: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                marketing_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                operating_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                marketing_carrier_flight_number: '2',
                passengers: [
                  {
                    passenger_id: 'pas_1',
                    cabin_class: 'economy',
                    baggages: [{ type: 'carry_on', quantity: 1 }],
                  },
                ],
              },
            ],
          },
        ],
      });

      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.hasCheckedBaggage).toBe(false);
    });

    it('returns null when baggage information is completely omitted across all segments', () => {
      const offer = createMockOffer({
        slices: [
          {
            id: 'sli_1',
            duration: 'PT5H',
            origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
            segments: [
              {
                id: 'seg_1',
                duration: 'PT5H',
                departing_at: '2026-09-01T08:00:00',
                arriving_at: '2026-09-01T13:00:00',
                origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                marketing_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                operating_carrier: { id: 'arl_dl', name: 'Delta', iata_code: 'DL' },
                marketing_carrier_flight_number: '1',
                passengers: [
                  {
                    passenger_id: 'pas_1',
                    cabin_class: 'economy',
                    // baggages undefined
                  },
                ],
              },
            ],
          },
        ],
      });

      const normalized = normalizeOffer(offer, 0);

      expect(normalized?.hasCheckedBaggage).toBeNull();
    });
  });

  describe('Malformed Offer Rejection & Validation (T016)', () => {
    describe('Price Validation (INVALID_PRICE)', () => {
      it('rejects offer with negative price and records INVALID_PRICE', () => {
        const offer = createMockOffer({ total_amount: '-150.00' });
        expect(normalizeOffer(offer, 0)).toBeNull();

        const result = normalizeFlightOffers([offer]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(1);
        expect(result.rejectionCounts).toEqual({ INVALID_PRICE: 1 });
        expect(result.currency).toBeNull();
      });

      it('rejects offer with zero price and records INVALID_PRICE', () => {
        const offer = createMockOffer({ total_amount: '0.00' });
        expect(normalizeOffer(offer, 0)).toBeNull();

        const result = normalizeFlightOffers([offer]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(1);
        expect(result.rejectionCounts).toEqual({ INVALID_PRICE: 1 });
      });

      it('rejects offer with NaN / non-numeric price string and records INVALID_PRICE', () => {
        const offer = createMockOffer({ total_amount: 'free' });
        expect(normalizeOffer(offer, 0)).toBeNull();

        const result = normalizeFlightOffers([offer]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(1);
        expect(result.rejectionCounts).toEqual({ INVALID_PRICE: 1 });
      });

      it('rejects offer with Infinity price and records INVALID_PRICE', () => {
        const offer = createMockOffer({ total_amount: 'Infinity' });
        expect(normalizeOffer(offer, 0)).toBeNull();

        const result = normalizeFlightOffers([offer]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(1);
        expect(result.rejectionCounts).toEqual({ INVALID_PRICE: 1 });
      });

      it('rejects offer with missing or empty total_amount or total_currency', () => {
        const offerEmptyAmount = createMockOffer({ total_amount: '' });
        const offerMissingCurrency = createMockOffer({ total_currency: '' });

        expect(normalizeOffer(offerEmptyAmount, 0)).toBeNull();
        expect(normalizeOffer(offerMissingCurrency, 0)).toBeNull();

        const result = normalizeFlightOffers([offerEmptyAmount, offerMissingCurrency]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(2);
        expect(result.rejectionCounts).toEqual({ INVALID_PRICE: 2 });
      });
    });

    describe('Duration Validation (INVALID_DURATION)', () => {
      it('rejects offer with zero total duration and records INVALID_DURATION', () => {
        const offer = createMockOffer({
          slices: [
            {
              id: 'sli_1',
              duration: 'PT0M',
              origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
              destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
              segments: [
                {
                  id: 'seg_1',
                  duration: 'PT0M',
                  departing_at: '2026-09-01T08:00:00',
                  arriving_at: '2026-09-01T08:00:00',
                  origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                  destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                  marketing_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                  operating_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                  marketing_carrier_flight_number: '1',
                },
              ],
            },
          ],
        });

        expect(normalizeOffer(offer, 0)).toBeNull();

        const result = normalizeFlightOffers([offer]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(1);
        expect(result.rejectionCounts).toEqual({ INVALID_DURATION: 1 });
      });

      it('rejects offer with missing slice duration resulting in 0 duration', () => {
        const offer = createMockOffer({
          slices: [
            {
              id: 'sli_1',
              duration: '',
              origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
              destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
              segments: [
                {
                  id: 'seg_1',
                  duration: '',
                  departing_at: '2026-09-01T08:00:00',
                  arriving_at: '2026-09-01T10:00:00',
                  origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                  destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                  marketing_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                  operating_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                  marketing_carrier_flight_number: '1',
                },
              ],
            },
          ],
        });

        expect(normalizeOffer(offer, 0)).toBeNull();

        const result = normalizeFlightOffers([offer]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(1);
        expect(result.rejectionCounts).toEqual({ INVALID_DURATION: 1 });
      });
    });

    describe('Structure Validation (MALFORMED_OFFER / MISSING_SLICES_OR_SEGMENTS)', () => {
      it('rejects offer with missing or empty ID and records MALFORMED_OFFER', () => {
        const offerMissingId = createMockOffer({ id: '' });
        expect(normalizeOffer(offerMissingId, 0)).toBeNull();

        const result = normalizeFlightOffers([offerMissingId]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(1);
        expect(result.rejectionCounts).toEqual({ MALFORMED_OFFER: 1 });
      });

      it('rejects offer with missing or empty slices and records MISSING_SLICES_OR_SEGMENTS', () => {
        const offerEmptySlices = createMockOffer({ slices: [] });
        expect(normalizeOffer(offerEmptySlices, 0)).toBeNull();

        const result = normalizeFlightOffers([offerEmptySlices]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(1);
        expect(result.rejectionCounts).toEqual({ MISSING_SLICES_OR_SEGMENTS: 1 });
      });

      it('rejects offer where a slice has no segments and records MISSING_SLICES_OR_SEGMENTS', () => {
        const offerEmptySegments = createMockOffer({
          slices: [
            {
              id: 'sli_1',
              duration: 'PT2H',
              origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
              destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
              segments: [],
            },
          ],
        });

        expect(normalizeOffer(offerEmptySegments, 0)).toBeNull();

        const result = normalizeFlightOffers([offerEmptySegments]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(1);
        expect(result.rejectionCounts).toEqual({ MISSING_SLICES_OR_SEGMENTS: 1 });
      });
    });

    describe('Timestamp Validation (INVALID_TIMESTAMP)', () => {
      it('rejects offer when first outbound segment departing_at is unparseable', () => {
        const offer = createMockOffer({
          slices: [
            {
              id: 'sli_1',
              duration: 'PT2H',
              origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
              destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
              segments: [
                {
                  id: 'seg_1',
                  duration: 'PT2H',
                  departing_at: 'invalid-datetime',
                  arriving_at: '2026-09-01T10:00:00',
                  origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                  destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                  marketing_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                  operating_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                  marketing_carrier_flight_number: '1',
                },
              ],
            },
          ],
        });

        expect(normalizeOffer(offer, 0)).toBeNull();

        const result = normalizeFlightOffers([offer]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(1);
        expect(result.rejectionCounts).toEqual({ INVALID_TIMESTAMP: 1 });
      });

      it('rejects offer when last outbound segment arriving_at is missing or unparseable', () => {
        const offer = createMockOffer({
          slices: [
            {
              id: 'sli_1',
              duration: 'PT2H',
              origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
              destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
              segments: [
                {
                  id: 'seg_1',
                  duration: 'PT2H',
                  departing_at: '2026-09-01T08:00:00',
                  arriving_at: '',
                  origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                  destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                  marketing_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                  operating_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                  marketing_carrier_flight_number: '1',
                },
              ],
            },
          ],
        });

        expect(normalizeOffer(offer, 0)).toBeNull();

        const result = normalizeFlightOffers([offer]);
        expect(result.normalizedOffers).toHaveLength(0);
        expect(result.droppedCount).toBe(1);
        expect(result.rejectionCounts).toEqual({ INVALID_TIMESTAMP: 1 });
      });
    });

    describe('First-Valid-Currency Selection & Mixed Currency Dropping (MIXED_CURRENCY)', () => {
      it('locks currency from the first valid offer and drops subsequent conflicting currency offers', () => {
        const offerUSD1 = createMockOffer({ id: 'off_usd_1', total_currency: 'USD', total_amount: '200.00' });
        const offerEUR = createMockOffer({ id: 'off_eur_1', total_currency: 'EUR', total_amount: '180.00' });
        const offerUSD2 = createMockOffer({ id: 'off_usd_2', total_currency: 'USD', total_amount: '250.00' });
        const offerGBP = createMockOffer({ id: 'off_gbp_1', total_currency: 'GBP', total_amount: '150.00' });

        const result = normalizeFlightOffers([offerUSD1, offerEUR, offerUSD2, offerGBP]);

        expect(result.currency).toBe('USD');
        expect(result.normalizedOffers).toHaveLength(2);
        expect(result.normalizedOffers[0].id).toBe(generateDeterministicUUID('off_usd_1'));
        expect(result.normalizedOffers[0].originalIndex).toBe(0);
        expect(result.normalizedOffers[1].id).toBe(generateDeterministicUUID('off_usd_2'));
        expect(result.normalizedOffers[1].originalIndex).toBe(2);
        expect(result.droppedCount).toBe(2);
        expect(result.rejectionCounts).toEqual({ MIXED_CURRENCY: 2 });
      });

      it('skips invalid first offers to lock currency on the first valid offer', () => {
        const invalidFirst = createMockOffer({ id: 'off_invalid_1', total_amount: '-50.00', total_currency: 'EUR' });
        const validFirstGBP = createMockOffer({ id: 'off_gbp_1', total_amount: '300.00', total_currency: 'GBP' });
        const validSecondUSD = createMockOffer({ id: 'off_usd_1', total_amount: '350.00', total_currency: 'USD' });
        const validThirdGBP = createMockOffer({ id: 'off_gbp_2', total_amount: '400.00', total_currency: 'GBP' });

        const result = normalizeFlightOffers([invalidFirst, validFirstGBP, validSecondUSD, validThirdGBP]);

        expect(result.currency).toBe('GBP');
        expect(result.normalizedOffers).toHaveLength(2);
        expect(result.normalizedOffers[0].originalIndex).toBe(1);
        expect(result.normalizedOffers[1].originalIndex).toBe(3);
        expect(result.droppedCount).toBe(2);
        expect(result.rejectionCounts).toEqual({
          INVALID_PRICE: 1,
          MIXED_CURRENCY: 1,
        });
      });
    });

    describe('Aggregate Rejection Counts & All-Invalid Fallback', () => {
      it('aggregates multiple distinct rejection reasons accurately', () => {
        const invalidPrice = createMockOffer({ id: 'off_bad_price', total_amount: '0.00', total_currency: 'USD' });
        const invalidDuration = createMockOffer({
          id: 'off_bad_dur',
          slices: [
            {
              id: 'sli_1',
              duration: 'PT0S',
              origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
              destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
              segments: [
                {
                  id: 'seg_1',
                  duration: 'PT0S',
                  departing_at: '2026-09-01T08:00:00',
                  arriving_at: '2026-09-01T08:00:00',
                  origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
                  destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
                  marketing_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                  operating_carrier: { id: 'arl_ba', name: 'BA', iata_code: 'BA' },
                  marketing_carrier_flight_number: '1',
                },
              ],
            },
          ],
        });
        const missingSegments = createMockOffer({
          id: 'off_bad_seg',
          slices: [
            {
              id: 'sli_1',
              duration: 'PT2H',
              origin: { id: 'plc_sfo', name: 'SFO', iata_code: 'SFO', type: 'airport' },
              destination: { id: 'plc_jfk', name: 'JFK', iata_code: 'JFK', type: 'airport' },
              segments: [],
            },
          ],
        });
        const validOffer1 = createMockOffer({ id: 'off_valid_1', total_amount: '300.00', total_currency: 'USD' });
        const mixedCurrency = createMockOffer({ id: 'off_mixed', total_amount: '200.00', total_currency: 'JPY' });

        const result = normalizeFlightOffers([
          invalidPrice,
          invalidDuration,
          missingSegments,
          validOffer1,
          mixedCurrency,
        ]);

        expect(result.normalizedOffers).toHaveLength(1);
        expect(result.normalizedOffers[0].id).toBe(generateDeterministicUUID('off_valid_1'));
        expect(result.normalizedOffers[0].originalIndex).toBe(3);
        expect(result.currency).toBe('USD');
        expect(result.droppedCount).toBe(4);
        expect(result.rejectionCounts).toEqual({
          INVALID_PRICE: 1,
          INVALID_DURATION: 1,
          MISSING_SLICES_OR_SEGMENTS: 1,
          MIXED_CURRENCY: 1,
        });
      });

      it('returns empty normalizedOffers, droppedCount = rawOffers.length, correct counts, and currency = null when all offers are invalid', () => {
        const invalid1 = createMockOffer({ total_amount: '-50' });
        const invalid2 = createMockOffer({ slices: [] });

        const result = normalizeFlightOffers([invalid1, invalid2]);

        expect(result.normalizedOffers).toEqual([]);
        expect(result.droppedCount).toBe(2);
        expect(result.currency).toBeNull();
        expect(result.rejectionCounts).toEqual({
          INVALID_PRICE: 1,
          MISSING_SLICES_OR_SEGMENTS: 1,
        });
      });

      it('returns empty result with 0 droppedCount and null currency for empty input array', () => {
        const result = normalizeFlightOffers([]);

        expect(result.normalizedOffers).toEqual([]);
        expect(result.droppedCount).toBe(0);
        expect(result.currency).toBeNull();
        expect(result.rejectionCounts).toEqual({});
      });
    });
  });
});
