import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CarrierCodeSchema,
  HourWindowSchema,
  MaxStopsSchema,
  PriceSensitivitySchema,
  RequiresCheckedBaggageSchema,
  canonicalizeCarrierCodes,
  type HourWindow,
  type PriceSensitivity,
  type TravelerPreferences,
} from './traveler-profile.types';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type ExpectedHourWindow = {
  start: number;
  end: number;
};
type HourWindowInferenceParity = Assert<Equal<HourWindow, ExpectedHourWindow>>;
void (0 as unknown as HourWindowInferenceParity);

type ExpectedPriceSensitivity = 'BUDGET' | 'MODERATE' | 'FLEXIBLE';
type PriceSensitivityInferenceParity = Assert<
  Equal<PriceSensitivity, ExpectedPriceSensitivity>
>;
void (0 as unknown as PriceSensitivityInferenceParity);

describe('T003: Hour-window and Price-sensitivity shared contracts', () => {
  describe('HourWindowSchema', () => {
    it('parses valid ordinary hour windows', () => {
      const window = HourWindowSchema.parse({ start: 9, end: 17 });
      assert.deepEqual(window, { start: 9, end: 17 });
    });

    it('parses valid overnight windows where start > end', () => {
      const overnight = HourWindowSchema.parse({ start: 22, end: 6 });
      assert.deepEqual(overnight, { start: 22, end: 6 });
    });

    it('parses same start and end hour windows', () => {
      const sameHour = HourWindowSchema.parse({ start: 10, end: 10 });
      assert.deepEqual(sameHour, { start: 10, end: 10 });
    });

    it('parses boundary hour values (0 and 23)', () => {
      assert.deepEqual(HourWindowSchema.parse({ start: 0, end: 23 }), { start: 0, end: 23 });
      assert.deepEqual(HourWindowSchema.parse({ start: 23, end: 0 }), { start: 23, end: 0 });
    });

    it('rejects out of range hours (< 0 or > 23)', () => {
      assert.throws(() => HourWindowSchema.parse({ start: -1, end: 12 }));
      assert.throws(() => HourWindowSchema.parse({ start: 9, end: 24 }));
      assert.throws(() => HourWindowSchema.parse({ start: 25, end: 30 }));
    });

    it('rejects non-integer float values', () => {
      assert.throws(() => HourWindowSchema.parse({ start: 9.5, end: 17 }));
      assert.throws(() => HourWindowSchema.parse({ start: 9, end: 17.25 }));
    });

    it('rejects missing fields or non-object payloads', () => {
      assert.throws(() => HourWindowSchema.parse({ start: 9 }));
      assert.throws(() => HourWindowSchema.parse({ end: 17 }));
      assert.throws(() => HourWindowSchema.parse({}));
      assert.throws(() => HourWindowSchema.parse(null));
      assert.throws(() => HourWindowSchema.parse(undefined));
      assert.throws(() => HourWindowSchema.parse('9-17'));
    });

    it('strictly rejects extraneous unknown keys', () => {
      assert.throws(() =>
        HourWindowSchema.parse({
          start: 9,
          end: 17,
          timeZone: 'UTC',
        }),
      );
      assert.throws(() =>
        HourWindowSchema.parse({
          start: 9,
          end: 17,
          extra: true,
        }),
      );
    });
  });

  describe('PriceSensitivitySchema', () => {
    it('accepts valid price sensitivity enum values', () => {
      assert.equal(PriceSensitivitySchema.parse('BUDGET'), 'BUDGET');
      assert.equal(PriceSensitivitySchema.parse('MODERATE'), 'MODERATE');
      assert.equal(PriceSensitivitySchema.parse('FLEXIBLE'), 'FLEXIBLE');
    });

    it('rejects lowercase, mixed-case, and invalid enum values', () => {
      assert.throws(() => PriceSensitivitySchema.parse('budget'));
      assert.throws(() => PriceSensitivitySchema.parse('Moderate'));
      assert.throws(() => PriceSensitivitySchema.parse('flexible'));
      assert.throws(() => PriceSensitivitySchema.parse('CHEAP'));
      assert.throws(() => PriceSensitivitySchema.parse('EXPENSIVE'));
      assert.throws(() => PriceSensitivitySchema.parse(''));
      assert.throws(() => PriceSensitivitySchema.parse(null));
      assert.throws(() => PriceSensitivitySchema.parse(undefined));
    });
  });
});

describe('T004: Airline canonicalization, maxStops, and baggage contracts', () => {
  describe('CarrierCodeSchema', () => {
    it('accepts valid 2-3 alphanumeric uppercase carrier codes', () => {
      assert.equal(CarrierCodeSchema.parse('VN'), 'VN');
      assert.equal(CarrierCodeSchema.parse('AA'), 'AA');
      assert.equal(CarrierCodeSchema.parse('6X'), '6X');
      assert.equal(CarrierCodeSchema.parse('B6'), 'B6');
      assert.equal(CarrierCodeSchema.parse('AFR'), 'AFR');
      assert.equal(CarrierCodeSchema.parse('BA1'), 'BA1');
    });

    it('rejects invalid carrier codes (length != 2..3, lowercase, symbols)', () => {
      assert.throws(() => CarrierCodeSchema.parse('V'));
      assert.throws(() => CarrierCodeSchema.parse('VIETNAM'));
      assert.throws(() => CarrierCodeSchema.parse('vn'));
      assert.throws(() => CarrierCodeSchema.parse('V-'));
      assert.throws(() => CarrierCodeSchema.parse(''));
      assert.throws(() => CarrierCodeSchema.parse(null));
    });
  });

  describe('canonicalizeCarrierCodes', () => {
    it('trims whitespace and uppercases carrier codes', () => {
      assert.deepEqual(canonicalizeCarrierCodes(['  vn  ', 'aa ', ' b6']), [
        'VN',
        'AA',
        'B6',
      ]);
    });

    it('filters out empty, whitespace-only, and invalid carrier codes', () => {
      assert.deepEqual(
        canonicalizeCarrierCodes(['', '   ', 'INVALID_LONG', 'X', 'VN', '1', 'AFR']),
        ['VN', 'AFR'],
      );
    });

    it('deduplicates codes preserving first-seen insertion order', () => {
      assert.deepEqual(
        canonicalizeCarrierCodes(['VN', 'vn', '  VN  ', 'AA', 'aa', 'VN', 'DL']),
        ['VN', 'AA', 'DL'],
      );
    });

    it('handles empty input arrays', () => {
      assert.deepEqual(canonicalizeCarrierCodes([]), []);
      assert.deepEqual(canonicalizeCarrierCodes(['', '   ', 'invalid']), []);
    });
  });

  describe('MaxStopsSchema', () => {
    it('accepts valid integers between 0 and 8', () => {
      for (let i = 0; i <= 8; i++) {
        assert.equal(MaxStopsSchema.parse(i), i);
      }
    });

    it('accepts null', () => {
      assert.equal(MaxStopsSchema.parse(null), null);
    });

    it('rejects negative numbers, numbers > 8, and floats', () => {
      assert.throws(() => MaxStopsSchema.parse(-1));
      assert.throws(() => MaxStopsSchema.parse(9));
      assert.throws(() => MaxStopsSchema.parse(100));
      assert.throws(() => MaxStopsSchema.parse(1.5));
      assert.throws(() => MaxStopsSchema.parse(0.1));
      assert.throws(() => MaxStopsSchema.parse('2'));
    });
  });

  describe('RequiresCheckedBaggageSchema', () => {
    it('accepts boolean values and null', () => {
      assert.equal(RequiresCheckedBaggageSchema.parse(true), true);
      assert.equal(RequiresCheckedBaggageSchema.parse(false), false);
      assert.equal(RequiresCheckedBaggageSchema.parse(null), null);
    });

    it('rejects non-boolean non-null values', () => {
      assert.throws(() => RequiresCheckedBaggageSchema.parse('true'));
      assert.throws(() => RequiresCheckedBaggageSchema.parse('false'));
      assert.throws(() => RequiresCheckedBaggageSchema.parse(1));
      assert.throws(() => RequiresCheckedBaggageSchema.parse(0));
      assert.throws(() => RequiresCheckedBaggageSchema.parse({}));
    });
  });

  describe('TravelerPreferences interface scoring fields', () => {
    it('allows valid populated, null, and omitted scoring preference fields', () => {
      const preferencesWithAllFields: TravelerPreferences = {
        seatPreference: 'WINDOW',
        classPreference: 'ECONOMY',
        preferredAirlines: ['VN', 'AA'],
        blacklistedAirlines: ['XX'],
        dietaryNeeds: 'VEGAN',
        preferredDepartureWindow: { start: 9, end: 17 },
        preferredArrivalWindow: { start: 18, end: 22 },
        maxStops: 1,
        priceSensitivity: 'BUDGET',
        requiresCheckedBaggage: true,
      };
      assert.equal(preferencesWithAllFields.maxStops, 1);
      assert.equal(preferencesWithAllFields.priceSensitivity, 'BUDGET');
      assert.equal(preferencesWithAllFields.requiresCheckedBaggage, true);
      assert.deepEqual(preferencesWithAllFields.preferredDepartureWindow, { start: 9, end: 17 });
      assert.deepEqual(preferencesWithAllFields.preferredArrivalWindow, { start: 18, end: 22 });

      const preferencesWithNulls: TravelerPreferences = {
        preferredDepartureWindow: null,
        preferredArrivalWindow: null,
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      };
      assert.equal(preferencesWithNulls.preferredDepartureWindow, null);
      assert.equal(preferencesWithNulls.preferredArrivalWindow, null);
      assert.equal(preferencesWithNulls.maxStops, null);
      assert.equal(preferencesWithNulls.priceSensitivity, null);
      assert.equal(preferencesWithNulls.requiresCheckedBaggage, null);

      const emptyPreferences: TravelerPreferences = {};
      assert.equal(emptyPreferences.preferredDepartureWindow, undefined);
      assert.equal(emptyPreferences.maxStops, undefined);
    });
  });
});
