import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FlightSearchOfferViewSchema,
  FlightSearchOutcomeSchema,
  FlightSearchQuerySchema,
  FlightSelectionOutcomeSchema,
  type FlightSearchOutcome,
  type FlightSelectionOutcome,
} from './flight-search.types';

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <Value>() =>
  Value extends Right ? 1 : 2
  ? true
  : false;
type Assert<Condition extends true> = Condition;

type ExpectedFlightSelectionOutcome =
  | { ok: true; checkoutPath: string }
  | {
      ok: false;
      reason: 'OFFER_EXPIRED' | 'OFFER_UNAVAILABLE' | 'UNAUTHENTICATED';
      message: string;
      retryable: boolean;
    };
type FlightSelectionOutcomeInferenceParity = Assert<
  Equal<FlightSelectionOutcome, ExpectedFlightSelectionOutcome>
>;
void (0 as unknown as FlightSelectionOutcomeInferenceParity);

const offer = {
  id: 'local-offer-01',
  price: 250.5,
  currency: 'USD',
  airline: 'Vietnam Airlines',
  flightNumber: 'VN123',
  origin: 'SGN',
  destination: 'HAN',
  departureAt: '2026-09-01T09:00:00Z',
  arrivalAt: '2026-09-01T11:10:00Z',
  duration: 'PT2H10M',
  stops: 0,
  slices: [
    {
      origin: 'SGN',
      destination: 'HAN',
      departureAt: '2026-09-01T09:00:00Z',
      arrivalAt: '2026-09-01T11:10:00Z',
      duration: 'PT2H10M',
      stops: 0,
      segments: [
        {
          airline: 'Vietnam Airlines',
          flightNumber: 'VN123',
          origin: 'SGN',
          destination: 'HAN',
          departureAt: '2026-09-01T09:00:00Z',
          arrivalAt: '2026-09-01T11:10:00Z',
          duration: 'PT2H10M',
          cabinClass: 'economy',
        },
      ],
    },
  ],
};

const futureDate = (daysFromToday: number): string => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
};

const validQuery = {
  origin: 'SGN',
  destination: 'HAN',
  departureDate: futureDate(2),
  returnDate: null,
  adults: 1,
  children: 0,
  infants: 0,
  cabinClass: 'economy' as const,
};

describe('Flight Search shared contracts', () => {
  it('parses valid query and success outcome', () => {
    assert.equal(
      FlightSearchQuerySchema.parse(validQuery).origin,
      'SGN',
    );

    const parsed: FlightSearchOutcome = FlightSearchOutcomeSchema.parse({
      ok: true,
      offers: [offer],
      meta: { totalCount: 1, currency: 'USD', minPrice: 250.5, maxPrice: 250.5, airlines: ['Vietnam Airlines'] },
    });
    assert.equal(parsed.ok, true);
  });

  it('parses valid search and selection failure outcomes', () => {
    assert.deepEqual(FlightSearchOutcomeSchema.parse({
      ok: false, reason: 'RATE_LIMITED', message: 'Try again shortly', retryable: true,
    }), { ok: false, reason: 'RATE_LIMITED', message: 'Try again shortly', retryable: true });
    assert.deepEqual(FlightSelectionOutcomeSchema.parse({
      ok: false, reason: 'OFFER_EXPIRED', message: 'Choose another offer', retryable: true,
    }), { ok: false, reason: 'OFFER_EXPIRED', message: 'Choose another offer', retryable: true });
  });

  it('parses a valid selection success outcome', () => {
    assert.deepEqual(FlightSelectionOutcomeSchema.parse({ ok: true, checkoutPath: '/checkout/local-offer-01' }),
      { ok: true, checkoutPath: '/checkout/local-offer-01' });
  });

  it('rejects unexpected provider fields, malformed values, and unsupported reasons', () => {
    assert.throws(() => FlightSearchOfferViewSchema.parse({ ...offer, duffelOfferId: 'off_123' }));
    assert.throws(() => FlightSearchQuerySchema.parse({
      origin: 'sgn', destination: 'HAN', departureDate: '2026/09/01', returnDate: null,
      adults: 0, children: 0, infants: 0, cabinClass: 'economy',
    }));
    assert.throws(() => FlightSearchOutcomeSchema.parse({
      ok: false, reason: 'PROVIDER_ERROR', message: 'No', retryable: false,
    }));
    assert.throws(() => FlightSelectionOutcomeSchema.parse({ ok: true }));
  });

  it('rejects semantically invalid search queries', () => {
    assert.throws(() => FlightSearchQuerySchema.parse({ ...validQuery, destination: 'SGN' }));
    assert.throws(() => FlightSearchQuerySchema.parse({ ...validQuery, adults: 8, children: 1, infants: 1 }));
    assert.throws(() => FlightSearchQuerySchema.parse({ ...validQuery, infants: 2 }));
    assert.throws(() => FlightSearchQuerySchema.parse({
      ...validQuery,
      departureDate: futureDate(3),
      returnDate: futureDate(2),
    }));
    assert.throws(() => FlightSearchQuerySchema.parse({ ...validQuery, departureDate: '2026-02-31' }));
    assert.throws(() => FlightSearchQuerySchema.parse({ ...validQuery, departureDate: '2000-01-01' }));
  });
});
