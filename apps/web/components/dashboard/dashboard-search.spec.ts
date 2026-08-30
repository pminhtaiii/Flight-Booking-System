import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSearchUrl, normalizeAirportCode, validateQuickSearch } from './dashboard-search';

const fixedToday = new Date('2026-08-30T00:00:00.000Z');

test('normalizeAirportCode trims whitespace and uppercases the airport code', () => {
  assert.equal(normalizeAirportCode(' sgn '), 'SGN');
});

test('validateQuickSearch rejects an empty origin', () => {
  const result = validateQuickSearch(
    { origin: ' ', destination: 'HAN', departureDate: '2026-09-01' },
    fixedToday,
  );

  assert.equal(result.valid, false);
});

test('validateQuickSearch rejects an empty destination', () => {
  const result = validateQuickSearch(
    { origin: 'SGN', destination: '', departureDate: '2026-09-01' },
    fixedToday,
  );

  assert.equal(result.valid, false);
});

test('validateQuickSearch rejects an origin shorter than three characters', () => {
  const result = validateQuickSearch(
    { origin: 'SG', destination: 'HAN', departureDate: '2026-09-01' },
    fixedToday,
  );

  assert.equal(result.valid, false);
});

test('validateQuickSearch rejects a destination shorter than three characters', () => {
  const result = validateQuickSearch(
    { origin: 'SGN', destination: 'HA', departureDate: '2026-09-01' },
    fixedToday,
  );

  assert.equal(result.valid, false);
});

test('validateQuickSearch rejects equal normalized origin and destination', () => {
  const result = validateQuickSearch(
    { origin: ' sgn ', destination: 'SGN', departureDate: '2026-09-01' },
    fixedToday,
  );

  assert.equal(result.valid, false);
});

test('validateQuickSearch rejects a departure date before today', () => {
  const result = validateQuickSearch(
    { origin: 'SGN', destination: 'HAN', departureDate: '2026-08-29' },
    fixedToday,
  );

  assert.equal(result.valid, false);
});

test('validateQuickSearch accepts a same-day departure', () => {
  const result = validateQuickSearch(
    { origin: 'SGN', destination: 'HAN', departureDate: '2026-08-30' },
    fixedToday,
  );

  assert.equal(result.valid, true);
});

test('validateQuickSearch returns a sanitized payload for valid input', () => {
  const result = validateQuickSearch(
    {
      origin: ' sgn ',
      destination: ' han ',
      departureDate: '2026-09-01',
      adults: 2,
      cabinClass: 'business',
    },
    fixedToday,
  );

  assert.equal(result.valid, true);
  if (result.valid) {
    assert.deepEqual(result.value, {
      origin: 'SGN',
      destination: 'HAN',
      departureDate: '2026-09-01',
    });
  }
});

test('buildSearchUrl preserves the required query parameter order', () => {
  assert.equal(
    buildSearchUrl({
      origin: ' sgn ',
      destination: 'han',
      departureDate: '2026-09-01',
    }),
    '/search?origin=SGN&destination=HAN&departureDate=2026-09-01&adults=1&cabinClass=economy',
  );
});
