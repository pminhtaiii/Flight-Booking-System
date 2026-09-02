import type {
  FlightMatchDimension,
  DimensionSignal,
  MatchLevel,
  PriceSensitivity,
  ExplanationKey,
} from '@shared/types';
import type { FlightMatchInput } from './flight-match.types';

/** Canonical scoring policy version tag for flight match scoring v1. */
export const SCORING_POLICY_VERSION = 'flight-match-v1' as const;

/** Fixed base weights assigned to all eight scoring dimensions totaling 1.000000. */
export const BASE_WEIGHTS: Record<FlightMatchDimension, number> = {
  PRICE: 0.20,
  AIRLINE: 0.15,
  ARRIVAL_SCHEDULE: 0.15,
  STOPS: 0.12,
  CABIN: 0.10,
  DEPARTURE_SCHEDULE: 0.10,
  BAGGAGE: 0.10,
  DURATION: 0.08,
};

/** Canonical order of dimensions for breakdown and evaluation priority. */
export const POLICY_DIMENSION_ORDER: readonly FlightMatchDimension[] = [
  'PRICE',
  'AIRLINE',
  'ARRIVAL_SCHEDULE',
  'STOPS',
  'CABIN',
  'DEPARTURE_SCHEDULE',
  'BAGGAGE',
  'DURATION',
] as const;

/** Objective baseline dimensions that are always computable for any valid flight offer. */
export const BASELINE_DIMENSIONS: readonly FlightMatchDimension[] = [
  'PRICE',
  'STOPS',
  'DURATION',
] as const;

/** Personalized dimensions activated by traveler profile preferences. */
export const PERSONALIZED_DIMENSIONS: readonly FlightMatchDimension[] = [
  'AIRLINE',
  'ARRIVAL_SCHEDULE',
  'CABIN',
  'DEPARTURE_SCHEDULE',
  'BAGGAGE',
] as const;

/** Deterministic priority order for assigning remainder precision to baseline dimensions. */
export const BASELINE_REMAINDER_ORDER: readonly FlightMatchDimension[] = [
  'PRICE',
  'STOPS',
  'DURATION',
] as const;

/** Sum of base weights in the baseline pool: 0.20 + 0.12 + 0.08 = 0.40. */
export const BASELINE_POOL_SUM = 0.40 as const;

/** Sum of base weights in the personalized pool: 0.15 + 0.15 + 0.10 + 0.10 + 0.10 = 0.60. */
export const PERSONALIZED_POOL_SUM = 0.60 as const;

/** Normalized hierarchical cabin class ranks. */
export const CABIN_RANK = {
  economy: 0,
  premium_economy: 1,
  business: 2,
  first: 3,
} as const;

export type CabinClass = keyof typeof CABIN_RANK;
export type CabinAdjacency = 'exact' | 'adjacent' | 'mismatch';

/**
 * Evaluates adjacency between a requested cabin class and an offer's cabin class.
 * - 'exact': rank distance = 0
 * - 'adjacent': rank distance = 1
 * - 'mismatch': rank distance >= 2 or unknown class
 */
export function getCabinAdjacency(
  requestedCabin: string,
  offerCabin: string,
): CabinAdjacency {
  const reqKey = requestedCabin.toLowerCase().trim();
  const offerKey = offerCabin.toLowerCase().trim();

  // Validate cabin class keys against CABIN_RANK mapping
  const reqRank = reqKey in CABIN_RANK ? CABIN_RANK[reqKey as CabinClass] : undefined;
  const offerRank = offerKey in CABIN_RANK ? CABIN_RANK[offerKey as CabinClass] : undefined;

  if (reqRank === undefined || offerRank === undefined) {
    return 'mismatch';
  }

  const distance = Math.abs(reqRank - offerRank);
  if (distance === 0) return 'exact';
  if (distance === 1) return 'adjacent';
  return 'mismatch';
}

/** Multipliers applied to price scoring spread based on traveler price sensitivity. */
export const PRICE_SENSITIVITY_MULTIPLIERS: Record<PriceSensitivity, number> = {
  BUDGET: 1.25,
  MODERATE: 1.0,
  FLEXIBLE: 0.75,
} as const;

export const DEFAULT_PRICE_SENSITIVITY_MULTIPLIER = 1.0 as const;

/**
 * Returns the price sensitivity multiplier for a given price sensitivity tier,
 * defaulting to 1.0 for null, undefined, or unrecognized values.
 */
export function getPriceSensitivityMultiplier(
  sensitivity?: PriceSensitivity | null,
): number {
  if (!sensitivity) {
    return DEFAULT_PRICE_SENSITIVITY_MULTIPLIER;
  }
  return PRICE_SENSITIVITY_MULTIPLIERS[sensitivity] ?? DEFAULT_PRICE_SENSITIVITY_MULTIPLIER;
}

/** Match level minimum score floor thresholds. */
export const MATCH_LEVEL_THRESHOLDS = {
  STRONG: 75,
  GOOD: 50,
  FAIR: 25,
  WEAK: 0,
} as const;

/**
 * Correlates a rounded 0..100 final match score to its match level tier:
 * - STRONG: 75..100
 * - GOOD: 50..74
 * - FAIR: 25..49
 * - WEAK: 0..24
 */
export function getMatchLevel(score: number): MatchLevel {
  if (score >= MATCH_LEVEL_THRESHOLDS.STRONG) return 'STRONG';
  if (score >= MATCH_LEVEL_THRESHOLDS.GOOD) return 'GOOD';
  if (score >= MATCH_LEVEL_THRESHOLDS.FAIR) return 'FAIR';
  return 'WEAK';
}

/** Local-clock departure hours categorized as red-eye flights (00:00 to 04:59). */
export const RED_EYE_HOURS = [0, 1, 2, 3, 4] as const;

/**
 * Returns true if the departure local hour falls within red-eye hours (0..4).
 */
export function isRedEyeDeparture(hour: number): boolean {
  // RED_EYE_HOURS defines hours 0..4 as red-eye departure times
  return Number.isInteger(hour) && (RED_EYE_HOURS as readonly number[]).includes(hour);
}

/**
 * Returns penalty weight for red-eye departure (1 if hour in 0..4, else 0).
 */
export function getRedEyePenalty(hour: number): number {
  return isRedEyeDeparture(hour) ? 1 : 0;
}

/** Schedule tolerance shoulder window in hours for departure and arrival windows. */
export const SCHEDULE_SHOULDER_HOURS = 6 as const;

/** All 24 allowlisted explanation keys supported by flight match scoring v1. */
export const ALL_EXPLANATION_KEYS: readonly ExplanationKey[] = [
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
] as const;

/**
 * Clamps a numeric value within inclusive [min, max] boundaries.
 */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Rounds a numeric value to exact 6 decimal places.
 * Handles floating-point quirks and avoids negative zero (-0).
 */
export function round6(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Rounds a numeric value symmetrically away from zero on half values.
 * e.g., 2.5 -> 3, -2.5 -> -3, 2.49 -> 2, -2.49 -> -2.
 */
export function roundHalfAwayFromZero(value: number): number {
  if (value < 0) {
    const rounded = -Math.round(-value);
    return rounded === 0 ? 0 : rounded;
  }
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

/**
 * Maps a dimension sub-score (0..1) to its canonical three-tier signal:
 * - POSITIVE: subScore >= 0.67
 * - NEUTRAL: 0.34 <= subScore < 0.67
 * - NEGATIVE: subScore < 0.34
 */
export function determineSignal(subScore: number): DimensionSignal {
  if (subScore >= 0.67) return 'POSITIVE';
  if (subScore >= 0.34) return 'NEUTRAL';
  return 'NEGATIVE';
}

/**
 * Calculates the deterministic median of an array of numbers without mutating the input.
 * - Empty array returns 0.
 * - Odd length returns exact middle element.
 * - Even length returns arithmetic mean of the two middle elements rounded to 6 decimal places.
 */
export function calculateMedian(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  const mean = (sorted[mid - 1] + sorted[mid]) / 2;
  return round6(mean);
}

/**
 * Calculates the shortest distance between two local-clock hours on a 24-hour circular dial.
 * Result is in the range [0, 12].
 */
export function circularHourDistance(h1: number, h2: number): number {
  const norm1 = ((h1 % 24) + 24) % 24;
  const norm2 = ((h2 % 24) + 24) % 24;
  const diff = Math.abs(norm1 - norm2);
  return Math.min(diff, 24 - diff);
}

/** Specification of a local-clock hour window. */
export type HourWindow = {
  readonly start: number;
  readonly end: number;
};

/**
 * Checks whether a local-clock hour falls within a specified hour window.
 * - Normal window (start <= end): hour >= start && hour <= end
 * - Overnight window (start > end): hour >= start || hour <= end
 */
export function isHourInWindow(hour: number, window: HourWindow): boolean {
  if (window.start <= window.end) {
    return hour >= window.start && hour <= window.end;
  }
  return hour >= window.start || hour <= window.end;
}

/**
 * Calculates the minimum circular hour distance from a given hour to a window.
 * - Returns 0 if the hour is inside the window.
 * - Otherwise returns min(circularHourDistance(hour, window.start), circularHourDistance(hour, window.end)).
 */
export function hourDistanceToWindow(hour: number, window: HourWindow): number {
  if (isHourInWindow(hour, window)) {
    return 0;
  }
  return Math.min(
    circularHourDistance(hour, window.start),
    circularHourDistance(hour, window.end),
  );
}

/**
 * Deterministic 5-tier objective comparison for flight offers:
 * 1. stops ascending (direct/nonstop first)
 * 2. price ascending (cheapest first)
 * 3. duration ascending (shortest first)
 * 4. departure red-eye penalty ascending (daytime 0 before red-eye 1)
 * 5. originalIndex ascending (stable supplier tie-breaker)
 */
export function compareObjectiveTiers(
  a: FlightMatchInput,
  b: FlightMatchInput,
): number {
  // Tier 1: stops ascending
  if (a.stops !== b.stops) {
    return a.stops - b.stops;
  }

  // Tier 2: price ascending
  if (a.price !== b.price) {
    return a.price - b.price;
  }

  // Tier 3: duration ascending
  if (a.duration !== b.duration) {
    return a.duration - b.duration;
  }

  // Tier 4: departure red-eye penalty ascending
  const aPenalty = getRedEyePenalty(a.outboundDepartureHour);
  const bPenalty = getRedEyePenalty(b.outboundDepartureHour);
  if (aPenalty !== bPenalty) {
    return aPenalty - bPenalty;
  }

  // Tier 5: originalIndex ascending (stable supplier tie-breaker)
  return a.originalIndex - b.originalIndex;
}


