import type {
  FlightMatchDimension,
  DimensionSignal,
  MatchLevel,
  Explanation,
  ConstraintType,
  PriceSensitivity,
} from '@shared/types';

export type {
  FlightMatchDimension,
  DimensionSignal,
  MatchLevel,
  Explanation,
  ConstraintType,
  PriceSensitivity,
};

/**
 * Normalized immutable offer inputs passed to the scoring engine.
 * Pure and supplier-independent: contains zero Duffel offer IDs or raw supplier shapes.
 */
export type FlightMatchInput = {
  readonly id: string;
  readonly price: number;
  readonly currency: string;
  readonly stops: number;
  readonly duration: number;
  readonly outboundDepartureHour: number;
  readonly inboundArrivalHour: number;
  readonly carrierCodes: readonly string[];
  readonly carrierNamesByCode?: Readonly<Record<string, string>>;
  readonly cabinClass: string;
  readonly hasCheckedBaggage: boolean | null;
  readonly originalIndex: number;
};

/**
 * PII-free immutable scoring preference snapshot.
 */
export type ScoringPreferences = {
  readonly preferredAirlines: readonly string[];
  readonly blacklistedAirlines: readonly string[];
  readonly classPreference: string | null;
  readonly preferredDepartureWindow: Readonly<{ start: number; end: number }> | null;
  readonly preferredArrivalWindow: Readonly<{ start: number; end: number }> | null;
  readonly maxStops: number | null;
  readonly priceSensitivity: 'BUDGET' | 'MODERATE' | 'FLEXIBLE' | null;
  readonly requiresCheckedBaggage: boolean | null;
};

/**
 * Specific constraint violation blocking match eligibility.
 */
export type ConstraintViolation = {
  readonly constraint: 'BLACKLISTED_AIRLINE';
  readonly explanation: Explanation;
};

/**
 * Result of hard constraint evaluation for a flight offer.
 */
export type EligibilityResult = {
  readonly eligible: boolean;
  readonly violations: readonly ConstraintViolation[];
};

/**
 * Individual dimension sub-score breakdown with weight contribution, signal, and safe explanation.
 */
export type DimensionScore = {
  readonly dimension: FlightMatchDimension;
  readonly score: number;
  readonly weight: number;
  readonly contribution: number;
  readonly signal: DimensionSignal;
  readonly explanation: Explanation;
};

/**
 * Active weights across all 8 match dimensions normalized to sum to 1.000000.
 */
export type ActiveWeights = {
  readonly PRICE: number;
  readonly AIRLINE: number;
  readonly ARRIVAL_SCHEDULE: number;
  readonly STOPS: number;
  readonly CABIN: number;
  readonly DEPARTURE_SCHEDULE: number;
  readonly BAGGAGE: number;
  readonly DURATION: number;
};

/**
 * Metadata recording scoring policy version and active effective weights.
 */
export type FlightMatchMetadata = {
  readonly scoringVersion: 'flight-match-v1';
  readonly activeWeights: ActiveWeights;
};

/**
 * Result payload for an eligible offer meeting all hard constraints.
 */
export type EligibleFlightMatchResult = {
  readonly eligibility: {
    readonly eligible: true;
    readonly violations: readonly [];
  };
  readonly score: number;
  readonly matchLevel: MatchLevel;
  readonly breakdown: readonly DimensionScore[];
  readonly metadata: FlightMatchMetadata;
};

/**
 * Result payload for an offer violating at least one hard constraint.
 */
export type IneligibleFlightMatchResult = {
  readonly eligibility: {
    readonly eligible: false;
    readonly violations: readonly ConstraintViolation[];
  };
  readonly score: null;
  readonly matchLevel: null;
  readonly breakdown: readonly [];
  readonly metadata: FlightMatchMetadata;
};

/**
 * Union of eligible and ineligible match result shapes.
 */
export type FlightMatchResult = EligibleFlightMatchResult | IneligibleFlightMatchResult;

/**
 * Internal orchestration structure pairing an offer with its computed match result.
 */
export type ScoredOffer = {
  readonly offer: FlightMatchInput;
  readonly matchResult: FlightMatchResult;
};

/**
 * Internal orchestration structure pairing an offer with null match result (unpersonalized/RANKED).
 */
export type RankedOffer = {
  readonly offer: FlightMatchInput;
  readonly matchResult: null;
};
