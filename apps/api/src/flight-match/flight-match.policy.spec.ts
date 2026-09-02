import { ExplanationKeySchema, type PriceSensitivity } from '@shared/types';
import {
  SCORING_POLICY_VERSION,
  BASE_WEIGHTS,
  BASELINE_POOL_SUM,
  PERSONALIZED_POOL_SUM,
  POLICY_DIMENSION_ORDER,
  BASELINE_DIMENSIONS,
  PERSONALIZED_DIMENSIONS,
  BASELINE_REMAINDER_ORDER,
  CABIN_RANK,
  getCabinAdjacency,
  PRICE_SENSITIVITY_MULTIPLIERS,
  DEFAULT_PRICE_SENSITIVITY_MULTIPLIER,
  getPriceSensitivityMultiplier,
  MATCH_LEVEL_THRESHOLDS,
  getMatchLevel,
  RED_EYE_HOURS,
  isRedEyeDeparture,
  getRedEyePenalty,
  SCHEDULE_SHOULDER_HOURS,
  ALL_EXPLANATION_KEYS,
  clamp,
  round6,
  roundHalfAwayFromZero,
  determineSignal,
  calculateMedian,
  circularHourDistance,
  isHourInWindow,
  hourDistanceToWindow,
  compareObjectiveTiers,
  type HourWindow,
} from './flight-match.policy';
import type { FlightMatchInput } from './flight-match.types';

describe('FlightMatchPolicy (T017)', () => {
  describe('Policy Version', () => {
    it('defines SCORING_POLICY_VERSION as flight-match-v1', () => {
      expect(SCORING_POLICY_VERSION).toBe('flight-match-v1');
    });
  });

  describe('Base Weights and Pool Invariants', () => {
    it('defines exact base weights across all 8 dimensions', () => {
      expect(BASE_WEIGHTS).toEqual({
        PRICE: 0.20,
        AIRLINE: 0.15,
        ARRIVAL_SCHEDULE: 0.15,
        STOPS: 0.12,
        CABIN: 0.10,
        DEPARTURE_SCHEDULE: 0.10,
        BAGGAGE: 0.10,
        DURATION: 0.08,
      });
    });

    it('sums all base weights to exactly 1.000000', () => {
      const sum = Object.values(BASE_WEIGHTS).reduce((acc: number, w: number) => acc + w, 0);
      expect(Number(sum.toFixed(6))).toBe(1.0);
    });

    it('baseline pool dimensions sum to exactly 0.40', () => {
      const baselineSum = BASELINE_DIMENSIONS.reduce(
        (acc: number, dim) => acc + BASE_WEIGHTS[dim],
        0,
      );
      expect(Number(baselineSum.toFixed(6))).toBe(0.4);
      expect(BASELINE_POOL_SUM).toBe(0.4);
    });

    it('personalized pool dimensions sum to exactly 0.60', () => {
      const personalizedSum = PERSONALIZED_DIMENSIONS.reduce(
        (acc: number, dim) => acc + BASE_WEIGHTS[dim],
        0,
      );
      expect(Number(personalizedSum.toFixed(6))).toBe(0.6);
      expect(PERSONALIZED_POOL_SUM).toBe(0.6);
    });
  });

  describe('Dimension Order and Partitioning', () => {
    it('defines canonical POLICY_DIMENSION_ORDER with all 8 dimensions in priority order', () => {
      expect(POLICY_DIMENSION_ORDER).toEqual([
        'PRICE',
        'AIRLINE',
        'ARRIVAL_SCHEDULE',
        'STOPS',
        'CABIN',
        'DEPARTURE_SCHEDULE',
        'BAGGAGE',
        'DURATION',
      ]);
    });

    it('defines BASELINE_DIMENSIONS as [PRICE, STOPS, DURATION]', () => {
      expect(BASELINE_DIMENSIONS).toEqual(['PRICE', 'STOPS', 'DURATION']);
    });

    it('defines PERSONALIZED_DIMENSIONS as [AIRLINE, ARRIVAL_SCHEDULE, CABIN, DEPARTURE_SCHEDULE, BAGGAGE]', () => {
      expect(PERSONALIZED_DIMENSIONS).toEqual([
        'AIRLINE',
        'ARRIVAL_SCHEDULE',
        'CABIN',
        'DEPARTURE_SCHEDULE',
        'BAGGAGE',
      ]);
    });

    it('defines BASELINE_REMAINDER_ORDER as [PRICE, STOPS, DURATION]', () => {
      expect(BASELINE_REMAINDER_ORDER).toEqual(['PRICE', 'STOPS', 'DURATION']);
    });

    it('partitions all 8 dimensions completely between baseline and personalized without overlap', () => {
      const combined = [...BASELINE_DIMENSIONS, ...PERSONALIZED_DIMENSIONS];
      expect(combined).toHaveLength(8);
      expect(new Set(combined).size).toBe(8);
      for (const dim of POLICY_DIMENSION_ORDER) {
        expect(combined).toContain(dim);
      }
    });
  });

  describe('Cabin Ranks and Adjacency', () => {
    it('defines CABIN_RANK with 4 hierarchical levels from economy to first', () => {
      expect(CABIN_RANK).toEqual({
        economy: 0,
        premium_economy: 1,
        business: 2,
        first: 3,
      });
    });

    it('returns "exact" for identical cabin classes', () => {
      expect(getCabinAdjacency('economy', 'economy')).toBe('exact');
      expect(getCabinAdjacency('premium_economy', 'premium_economy')).toBe('exact');
      expect(getCabinAdjacency('business', 'business')).toBe('exact');
      expect(getCabinAdjacency('first', 'first')).toBe('exact');
    });

    it('returns "exact" with case-insensitivity and whitespace trimming', () => {
      expect(getCabinAdjacency('Economy ', 'economy')).toBe('exact');
      expect(getCabinAdjacency('BUSINESS', 'business')).toBe('exact');
      expect(getCabinAdjacency(' Premium_Economy ', 'PREMIUM_ECONOMY')).toBe('exact');
    });

    it('returns "adjacent" for cabin classes 1 rank apart in either direction', () => {
      expect(getCabinAdjacency('economy', 'premium_economy')).toBe('adjacent');
      expect(getCabinAdjacency('premium_economy', 'economy')).toBe('adjacent');
      expect(getCabinAdjacency('premium_economy', 'business')).toBe('adjacent');
      expect(getCabinAdjacency('business', 'premium_economy')).toBe('adjacent');
      expect(getCabinAdjacency('business', 'first')).toBe('adjacent');
      expect(getCabinAdjacency('first', 'business')).toBe('adjacent');
    });

    it('returns "mismatch" for cabin classes 2 or more ranks apart', () => {
      expect(getCabinAdjacency('economy', 'business')).toBe('mismatch');
      expect(getCabinAdjacency('business', 'economy')).toBe('mismatch');
      expect(getCabinAdjacency('economy', 'first')).toBe('mismatch');
      expect(getCabinAdjacency('first', 'economy')).toBe('mismatch');
      expect(getCabinAdjacency('premium_economy', 'first')).toBe('mismatch');
      expect(getCabinAdjacency('first', 'premium_economy')).toBe('mismatch');
    });

    it('returns "mismatch" when either cabin class is unknown or invalid', () => {
      expect(getCabinAdjacency('unknown', 'economy')).toBe('mismatch');
      expect(getCabinAdjacency('economy', 'invalid')).toBe('mismatch');
      expect(getCabinAdjacency('', '')).toBe('mismatch');
    });
  });

  describe('Price Sensitivity Multipliers', () => {
    it('defines PRICE_SENSITIVITY_MULTIPLIERS with expected values', () => {
      expect(PRICE_SENSITIVITY_MULTIPLIERS).toEqual({
        BUDGET: 1.25,
        MODERATE: 1.0,
        FLEXIBLE: 0.75,
      });
    });

    it('defines DEFAULT_PRICE_SENSITIVITY_MULTIPLIER as 1.0', () => {
      expect(DEFAULT_PRICE_SENSITIVITY_MULTIPLIER).toBe(1.0);
    });

    it('getPriceSensitivityMultiplier resolves multiplier correctly', () => {
      expect(getPriceSensitivityMultiplier('BUDGET')).toBe(1.25);
      expect(getPriceSensitivityMultiplier('MODERATE')).toBe(1.0);
      expect(getPriceSensitivityMultiplier('FLEXIBLE')).toBe(0.75);
      expect(getPriceSensitivityMultiplier(null)).toBe(1.0);
      expect(getPriceSensitivityMultiplier(undefined)).toBe(1.0);
      expect(getPriceSensitivityMultiplier('UNKNOWN' as unknown as PriceSensitivity)).toBe(1.0);
    });
  });

  describe('Match Level Thresholds and Buckets', () => {
    it('defines MATCH_LEVEL_THRESHOLDS with expected floor values', () => {
      expect(MATCH_LEVEL_THRESHOLDS).toEqual({
        STRONG: 75,
        GOOD: 50,
        FAIR: 25,
        WEAK: 0,
      });
    });

    it('maps scores into correct match level brackets via getMatchLevel', () => {
      // STRONG: 75..100
      expect(getMatchLevel(100)).toBe('STRONG');
      expect(getMatchLevel(75)).toBe('STRONG');

      // GOOD: 50..74
      expect(getMatchLevel(74)).toBe('GOOD');
      expect(getMatchLevel(50)).toBe('GOOD');

      // FAIR: 25..49
      expect(getMatchLevel(49)).toBe('FAIR');
      expect(getMatchLevel(25)).toBe('FAIR');

      // WEAK: 0..24
      expect(getMatchLevel(24)).toBe('WEAK');
      expect(getMatchLevel(0)).toBe('WEAK');
      expect(getMatchLevel(-5)).toBe('WEAK');
    });
  });

  describe('Red-Eye Hours and Penalty', () => {
    it('defines RED_EYE_HOURS as [0, 1, 2, 3, 4]', () => {
      expect(RED_EYE_HOURS).toEqual([0, 1, 2, 3, 4]);
    });

    it('identifies red-eye hours correctly with isRedEyeDeparture', () => {
      expect(isRedEyeDeparture(0)).toBe(true);
      expect(isRedEyeDeparture(1)).toBe(true);
      expect(isRedEyeDeparture(2)).toBe(true);
      expect(isRedEyeDeparture(3)).toBe(true);
      expect(isRedEyeDeparture(4)).toBe(true);

      expect(isRedEyeDeparture(5)).toBe(false);
      expect(isRedEyeDeparture(6)).toBe(false);
      expect(isRedEyeDeparture(12)).toBe(false);
      expect(isRedEyeDeparture(23)).toBe(false);
      expect(isRedEyeDeparture(-1)).toBe(false);
      expect(isRedEyeDeparture(24)).toBe(false);
    });

    it('returns penalty 1 for red-eye hours and 0 otherwise with getRedEyePenalty', () => {
      expect(getRedEyePenalty(0)).toBe(1);
      expect(getRedEyePenalty(3)).toBe(1);
      expect(getRedEyePenalty(4)).toBe(1);
      expect(getRedEyePenalty(5)).toBe(0);
      expect(getRedEyePenalty(14)).toBe(0);
      expect(getRedEyePenalty(23)).toBe(0);
    });
  });

  describe('Schedule Shoulder Hours', () => {
    it('defines SCHEDULE_SHOULDER_HOURS as 6', () => {
      expect(SCHEDULE_SHOULDER_HOURS).toBe(6);
    });
  });

  describe('Explanation Allowlist', () => {
    it('contains all 24 allowlisted explanation keys', () => {
      expect(ALL_EXPLANATION_KEYS).toHaveLength(24);
      expect(new Set(ALL_EXPLANATION_KEYS).size).toBe(24);
    });

    it('all keys pass ExplanationKeySchema validation', () => {
      for (const key of ALL_EXPLANATION_KEYS) {
        const result = ExplanationKeySchema.safeParse(key);
        expect(result.success).toBe(true);
      }
    });

    it('matches exact allowlisted set of explanation keys', () => {
      expect(ALL_EXPLANATION_KEYS).toEqual([
        'match.price.below_median',
        'match.price.at_median',
        'match.price.above_median',
        'match.airline.preferred',
        'match.airline.neutral',
        'match.arrival.in_window',
        'match.arrival.near_window',
        'match.arrival.outside_window',
        'match.stops.within_preference',
        'match.stops.exceeds_preference',
        'match.stops.relative',
        'match.cabin.exact',
        'match.cabin.adjacent',
        'match.cabin.mismatch',
        'match.departure.in_window',
        'match.departure.near_window',
        'match.departure.outside_window',
        'match.baggage.checked_included',
        'match.baggage.checked_missing',
        'match.baggage.not_required',
        'match.duration.below_median',
        'match.duration.at_median',
        'match.duration.above_median',
        'constraint.airline.blacklisted',
      ]);
    });
  });
});

describe('FlightMatchPolicy Helpers & Math (T018)', () => {
  describe('clamp', () => {
    it('returns min when value is below min', () => {
      expect(clamp(-5, 0, 100)).toBe(0);
      expect(clamp(-100, -50, 50)).toBe(-50);
      expect(clamp(0.1, 0.2, 0.9)).toBe(0.2);
    });

    it('returns max when value is above max', () => {
      expect(clamp(150, 0, 100)).toBe(100);
      expect(clamp(100.5, 0, 100)).toBe(100);
      expect(clamp(1.5, 0, 1)).toBe(1);
    });

    it('returns value when within [min, max] range', () => {
      expect(clamp(42, 0, 100)).toBe(42);
      expect(clamp(0.5, 0, 1)).toBe(0.5);
      expect(clamp(-5, -10, 0)).toBe(-5);
    });

    it('handles exact boundary values', () => {
      expect(clamp(0, 0, 100)).toBe(0);
      expect(clamp(100, 0, 100)).toBe(100);
    });

    it('handles min === max case', () => {
      expect(clamp(5, 10, 10)).toBe(10);
      expect(clamp(15, 10, 10)).toBe(10);
      expect(clamp(10, 10, 10)).toBe(10);
    });

    it('handles negative ranges', () => {
      expect(clamp(-15, -10, -5)).toBe(-10);
      expect(clamp(-2, -10, -5)).toBe(-5);
      expect(clamp(-7, -10, -5)).toBe(-7);
    });
  });

  describe('round6', () => {
    it('rounds numbers to exact 6 decimal places', () => {
      expect(round6(0.1234567)).toBe(0.123457);
      expect(round6(0.1234564)).toBe(0.123456);
      expect(round6(0.1234565)).toBe(0.123457);
    });

    it('preserves values with 6 or fewer decimal places', () => {
      expect(round6(1)).toBe(1);
      expect(round6(1.5)).toBe(1.5);
      expect(round6(0.123456)).toBe(0.123456);
      expect(round6(0.12)).toBe(0.12);
    });

    it('handles floating point epsilon issues', () => {
      expect(round6(0.1 + 0.2)).toBe(0.3);
      expect(round6(0.7 + 0.1)).toBe(0.8);
      expect(round6(0.2 + 0.4)).toBe(0.6);
    });

    it('handles recurring fractions', () => {
      expect(round6(1 / 3)).toBe(0.333333);
      expect(round6(2 / 3)).toBe(0.666667);
      expect(round6(1 / 6)).toBe(0.166667);
    });

    it('handles negative numbers', () => {
      expect(round6(-0.1234567)).toBe(-0.123457);
      expect(round6(-0.1234564)).toBe(-0.123456);
      expect(round6(-1 / 3)).toBe(-0.333333);
    });

    it('handles zero and signed zero cleanly', () => {
      expect(round6(0)).toBe(0);
      expect(round6(-0)).toBe(0);
      expect(Object.is(round6(-0), -0)).toBe(false);
    });
  });

  describe('roundHalfAwayFromZero', () => {
    it('rounds positive half-values up (away from zero)', () => {
      expect(roundHalfAwayFromZero(0.5)).toBe(1);
      expect(roundHalfAwayFromZero(1.5)).toBe(2);
      expect(roundHalfAwayFromZero(2.5)).toBe(3);
      expect(roundHalfAwayFromZero(74.5)).toBe(75);
      expect(roundHalfAwayFromZero(99.5)).toBe(100);
    });

    it('rounds negative half-values down (away from zero)', () => {
      expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
      expect(roundHalfAwayFromZero(-1.5)).toBe(-2);
      expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
      expect(roundHalfAwayFromZero(-74.5)).toBe(-75);
    });

    it('rounds positive non-half values correctly', () => {
      expect(roundHalfAwayFromZero(2.49)).toBe(2);
      expect(roundHalfAwayFromZero(2.51)).toBe(3);
      expect(roundHalfAwayFromZero(74.499999)).toBe(74);
      expect(roundHalfAwayFromZero(74.500001)).toBe(75);
    });

    it('rounds negative non-half values correctly', () => {
      expect(roundHalfAwayFromZero(-2.49)).toBe(-2);
      expect(roundHalfAwayFromZero(-2.51)).toBe(-3);
      expect(roundHalfAwayFromZero(-74.499999)).toBe(-74);
      expect(roundHalfAwayFromZero(-74.500001)).toBe(-75);
    });

    it('preserves exact integers and zero', () => {
      expect(roundHalfAwayFromZero(0)).toBe(0);
      expect(roundHalfAwayFromZero(42)).toBe(42);
      expect(roundHalfAwayFromZero(-42)).toBe(-42);
      expect(roundHalfAwayFromZero(-0)).toBe(0);
    });
  });

  describe('determineSignal', () => {
    it('returns POSITIVE for subScores >= 0.67', () => {
      expect(determineSignal(1.0)).toBe('POSITIVE');
      expect(determineSignal(0.85)).toBe('POSITIVE');
      expect(determineSignal(0.67)).toBe('POSITIVE');
    });

    it('returns NEUTRAL for subScores >= 0.34 and < 0.67', () => {
      expect(determineSignal(0.669999)).toBe('NEUTRAL');
      expect(determineSignal(0.66)).toBe('NEUTRAL');
      expect(determineSignal(0.50)).toBe('NEUTRAL');
      expect(determineSignal(0.34)).toBe('NEUTRAL');
    });

    it('returns NEGATIVE for subScores < 0.34', () => {
      expect(determineSignal(0.339999)).toBe('NEGATIVE');
      expect(determineSignal(0.33)).toBe('NEGATIVE');
      expect(determineSignal(0.1)).toBe('NEGATIVE');
      expect(determineSignal(0.0)).toBe('NEGATIVE');
    });

    it('handles exact threshold boundaries', () => {
      expect(determineSignal(0.67)).toBe('POSITIVE');
      expect(determineSignal(0.669999)).toBe('NEUTRAL');
      expect(determineSignal(0.34)).toBe('NEUTRAL');
      expect(determineSignal(0.339999)).toBe('NEGATIVE');
    });
  });

  describe('getMatchLevel', () => {
    it('maps scores >= 75 to STRONG', () => {
      expect(getMatchLevel(100)).toBe('STRONG');
      expect(getMatchLevel(85)).toBe('STRONG');
      expect(getMatchLevel(75)).toBe('STRONG');
    });

    it('maps scores >= 50 and < 75 to GOOD', () => {
      expect(getMatchLevel(74)).toBe('GOOD');
      expect(getMatchLevel(60)).toBe('GOOD');
      expect(getMatchLevel(50)).toBe('GOOD');
    });

    it('maps scores >= 25 and < 50 to FAIR', () => {
      expect(getMatchLevel(49)).toBe('FAIR');
      expect(getMatchLevel(35)).toBe('FAIR');
      expect(getMatchLevel(25)).toBe('FAIR');
    });

    it('maps scores < 25 to WEAK', () => {
      expect(getMatchLevel(24)).toBe('WEAK');
      expect(getMatchLevel(10)).toBe('WEAK');
      expect(getMatchLevel(0)).toBe('WEAK');
      expect(getMatchLevel(-5)).toBe('WEAK');
    });

    it('verifies exact boundary transitions (75, 74, 50, 49, 25, 24)', () => {
      expect(getMatchLevel(75)).toBe('STRONG');
      expect(getMatchLevel(74)).toBe('GOOD');
      expect(getMatchLevel(50)).toBe('GOOD');
      expect(getMatchLevel(49)).toBe('FAIR');
      expect(getMatchLevel(25)).toBe('FAIR');
      expect(getMatchLevel(24)).toBe('WEAK');
    });
  });

  describe('calculateMedian', () => {
    it('returns 0 for empty array', () => {
      expect(calculateMedian([])).toBe(0);
    });

    it('returns single element for array of length 1', () => {
      expect(calculateMedian([42])).toBe(42);
      expect(calculateMedian([0])).toBe(0);
      expect(calculateMedian([100.5])).toBe(100.5);
    });

    it('returns middle element for odd length arrays', () => {
      expect(calculateMedian([10, 30, 20])).toBe(20);
      expect(calculateMedian([5, 1, 9, 3, 7])).toBe(5);
      expect(calculateMedian([100, 200, 300])).toBe(200);
    });

    it('returns arithmetic mean of two middle elements for even length arrays', () => {
      expect(calculateMedian([10, 40, 20, 30])).toBe(25);
      expect(calculateMedian([1, 2])).toBe(1.5);
      expect(calculateMedian([10, 20])).toBe(15);
      expect(calculateMedian([100, 400, 200, 300])).toBe(250);
    });

    it('rounds even length mean to 6 decimal places via round6', () => {
      // (0.1111111 + 0.2222222) / 2 = 0.16666665 -> round6 = 0.166667
      expect(calculateMedian([0.1111111, 0.2222222])).toBe(0.166667);
      // (1/3 + 2/3) / 2 = 0.5
      expect(calculateMedian([1 / 3, 2 / 3])).toBe(0.5);
    });

    it('does not mutate the input array', () => {
      const input = Object.freeze([50, 10, 40, 20, 30]);
      const result = calculateMedian(input);
      expect(result).toBe(30);
      expect(input).toEqual([50, 10, 40, 20, 30]);
    });
  });

  describe('circularHourDistance', () => {
    it('returns 0 for identical hours', () => {
      expect(circularHourDistance(0, 0)).toBe(0);
      expect(circularHourDistance(10, 10)).toBe(0);
      expect(circularHourDistance(23, 23)).toBe(0);
    });

    it('calculates distance across midnight wrap-around', () => {
      expect(circularHourDistance(23, 1)).toBe(2);
      expect(circularHourDistance(1, 23)).toBe(2);
      expect(circularHourDistance(0, 23)).toBe(1);
      expect(circularHourDistance(23, 0)).toBe(1);
      expect(circularHourDistance(22, 2)).toBe(4);
      expect(circularHourDistance(2, 22)).toBe(4);
    });

    it('calculates distance for opposite sides of 24h clock (max 12)', () => {
      expect(circularHourDistance(6, 18)).toBe(12);
      expect(circularHourDistance(18, 6)).toBe(12);
      expect(circularHourDistance(0, 12)).toBe(12);
      expect(circularHourDistance(12, 0)).toBe(12);
    });

    it('calculates standard non-wrapping distances', () => {
      expect(circularHourDistance(9, 14)).toBe(5);
      expect(circularHourDistance(14, 9)).toBe(5);
      expect(circularHourDistance(3, 8)).toBe(5);
    });

    it('is symmetric for all inputs', () => {
      for (let h1 = 0; h1 < 24; h1 += 3) {
        for (let h2 = 0; h2 < 24; h2 += 3) {
          expect(circularHourDistance(h1, h2)).toBe(circularHourDistance(h2, h1));
        }
      }
    });
  });

  describe('isHourInWindow and hourDistanceToWindow', () => {
    describe('Normal Window (start <= end)', () => {
      const daytimeWindow: HourWindow = { start: 9, end: 17 };

      it('isHourInWindow returns true for hours within or on boundaries', () => {
        expect(isHourInWindow(9, daytimeWindow)).toBe(true);
        expect(isHourInWindow(17, daytimeWindow)).toBe(true);
        expect(isHourInWindow(12, daytimeWindow)).toBe(true);
        expect(isHourInWindow(10, daytimeWindow)).toBe(true);
        expect(isHourInWindow(16, daytimeWindow)).toBe(true);
      });

      it('isHourInWindow returns false for hours outside window', () => {
        expect(isHourInWindow(8, daytimeWindow)).toBe(false);
        expect(isHourInWindow(18, daytimeWindow)).toBe(false);
        expect(isHourInWindow(0, daytimeWindow)).toBe(false);
        expect(isHourInWindow(23, daytimeWindow)).toBe(false);
      });

      it('hourDistanceToWindow returns 0 for hours inside or on boundaries', () => {
        expect(hourDistanceToWindow(9, daytimeWindow)).toBe(0);
        expect(hourDistanceToWindow(17, daytimeWindow)).toBe(0);
        expect(hourDistanceToWindow(12, daytimeWindow)).toBe(0);
      });

      it('hourDistanceToWindow returns shortest circular distance to window boundary when outside', () => {
        expect(hourDistanceToWindow(8, daytimeWindow)).toBe(1);
        expect(hourDistanceToWindow(7, daytimeWindow)).toBe(2);
        expect(hourDistanceToWindow(18, daytimeWindow)).toBe(1);
        expect(hourDistanceToWindow(19, daytimeWindow)).toBe(2);
        // Hour 23: dist to 17 is 6, dist to 9 is 10 -> min is 6
        expect(hourDistanceToWindow(23, daytimeWindow)).toBe(6);
        // Hour 0: dist to 17 is 7, dist to 9 is 9 -> min is 7
        expect(hourDistanceToWindow(0, daytimeWindow)).toBe(7);
      });
    });

    describe('Overnight Window (start > end)', () => {
      const overnightWindow: HourWindow = { start: 22, end: 6 };

      it('isHourInWindow returns true for hours within or on boundaries', () => {
        expect(isHourInWindow(22, overnightWindow)).toBe(true);
        expect(isHourInWindow(23, overnightWindow)).toBe(true);
        expect(isHourInWindow(0, overnightWindow)).toBe(true);
        expect(isHourInWindow(1, overnightWindow)).toBe(true);
        expect(isHourInWindow(5, overnightWindow)).toBe(true);
        expect(isHourInWindow(6, overnightWindow)).toBe(true);
      });

      it('isHourInWindow returns false for hours outside overnight window', () => {
        expect(isHourInWindow(7, overnightWindow)).toBe(false);
        expect(isHourInWindow(12, overnightWindow)).toBe(false);
        expect(isHourInWindow(21, overnightWindow)).toBe(false);
      });

      it('hourDistanceToWindow returns 0 for hours inside overnight window', () => {
        expect(hourDistanceToWindow(22, overnightWindow)).toBe(0);
        expect(hourDistanceToWindow(23, overnightWindow)).toBe(0);
        expect(hourDistanceToWindow(0, overnightWindow)).toBe(0);
        expect(hourDistanceToWindow(6, overnightWindow)).toBe(0);
      });

      it('hourDistanceToWindow returns shortest circular distance to overnight boundary', () => {
        expect(hourDistanceToWindow(21, overnightWindow)).toBe(1);
        expect(hourDistanceToWindow(20, overnightWindow)).toBe(2);
        expect(hourDistanceToWindow(7, overnightWindow)).toBe(1);
        expect(hourDistanceToWindow(8, overnightWindow)).toBe(2);
        // Hour 14: dist to 22 is 8, dist to 6 is 8 -> min is 8
        expect(hourDistanceToWindow(14, overnightWindow)).toBe(8);
      });
    });

    describe('Single-Hour Window (start === end)', () => {
      const singleHourWindow: HourWindow = { start: 10, end: 10 };

      it('isHourInWindow returns true only for exact hour', () => {
        expect(isHourInWindow(10, singleHourWindow)).toBe(true);
        expect(isHourInWindow(9, singleHourWindow)).toBe(false);
        expect(isHourInWindow(11, singleHourWindow)).toBe(false);
      });

      it('hourDistanceToWindow calculates distance correctly', () => {
        expect(hourDistanceToWindow(10, singleHourWindow)).toBe(0);
        expect(hourDistanceToWindow(12, singleHourWindow)).toBe(2);
        expect(hourDistanceToWindow(8, singleHourWindow)).toBe(2);
      });
    });
  });

  describe('compareObjectiveTiers', () => {
    const makeOffer = (overrides: Partial<FlightMatchInput> = {}): FlightMatchInput => ({
      id: 'test-offer',
      price: 200,
      currency: 'USD',
      stops: 0,
      duration: 120,
      outboundDepartureHour: 10,
      outboundArrivalHour: 12,
      carrierCodes: ['VN'],
      cabinClass: 'economy',
      hasCheckedBaggage: true,
      originalIndex: 0,
      ...overrides,
    });

    it('orders by stops ascending', () => {
      const a = makeOffer({ stops: 0 });
      const b = makeOffer({ stops: 1 });
      expect(compareObjectiveTiers(a, b)).toBeLessThan(0);
      expect(compareObjectiveTiers(b, a)).toBeGreaterThan(0);
    });

    it('orders by price ascending when stops are equal', () => {
      const a = makeOffer({ stops: 0, price: 100 });
      const b = makeOffer({ stops: 0, price: 200 });
      expect(compareObjectiveTiers(a, b)).toBeLessThan(0);
      expect(compareObjectiveTiers(b, a)).toBeGreaterThan(0);
    });

    it('orders by duration ascending when stops and price are equal', () => {
      const a = makeOffer({ stops: 0, price: 100, duration: 100 });
      const b = makeOffer({ stops: 0, price: 100, duration: 150 });
      expect(compareObjectiveTiers(a, b)).toBeLessThan(0);
      expect(compareObjectiveTiers(b, a)).toBeGreaterThan(0);
    });

    it('orders daytime ahead of red-eye when stops, price, duration are equal', () => {
      const daytime = makeOffer({ stops: 0, price: 100, duration: 100, outboundDepartureHour: 9 });
      const redeye = makeOffer({ stops: 0, price: 100, duration: 100, outboundDepartureHour: 3 });
      expect(compareObjectiveTiers(daytime, redeye)).toBeLessThan(0);
      expect(compareObjectiveTiers(redeye, daytime)).toBeGreaterThan(0);
    });

    it('orders by originalIndex when all other tiers are equal', () => {
      const a = makeOffer({ stops: 0, price: 100, duration: 100, outboundDepartureHour: 9, originalIndex: 1 });
      const b = makeOffer({ stops: 0, price: 100, duration: 100, outboundDepartureHour: 9, originalIndex: 5 });
      expect(compareObjectiveTiers(a, b)).toBeLessThan(0);
      expect(compareObjectiveTiers(b, a)).toBeGreaterThan(0);
    });
  });
});

