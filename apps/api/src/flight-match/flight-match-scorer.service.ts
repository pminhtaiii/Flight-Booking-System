import { Injectable } from '@nestjs/common';

import {
  BASE_WEIGHTS,
  calculateMedian,
  clamp,
  determineSignal,
  getMatchLevel,
  getPriceSensitivityMultiplier,
  round6,
  roundHalfAwayFromZero,
  SCORING_POLICY_VERSION,
} from './flight-match.policy';
import type {
  DimensionScore,
  EligibilityResult,
  FlightMatchInput,
  ScoredOffer,
  ScoringPreferences,
} from './flight-match.types';

const AIRLINE_CODE_PATTERN = /^[A-Z0-9]{2,3}$/;

type MedianComparison = 'below' | 'at' | 'above';
type PriceMedianExplanationKey =
  | 'match.price.below_median'
  | 'match.price.at_median'
  | 'match.price.above_median';
type DurationMedianExplanationKey =
  | 'match.duration.below_median'
  | 'match.duration.at_median'
  | 'match.duration.above_median';

const MEDIAN_EXPLANATION_KEYS: Readonly<{
  PRICE: Readonly<Record<MedianComparison, PriceMedianExplanationKey>>;
  DURATION: Readonly<Record<MedianComparison, DurationMedianExplanationKey>>;
}> = {
  PRICE: {
    below: 'match.price.below_median',
    at: 'match.price.at_median',
    above: 'match.price.above_median',
  },
  DURATION: {
    below: 'match.duration.below_median',
    at: 'match.duration.at_median',
    above: 'match.duration.above_median',
  },
};

@Injectable()
export class FlightMatchScorerService {
  checkEligibility(
    offer: FlightMatchInput,
    preferences: ScoringPreferences,
  ): EligibilityResult {
    const blacklistedAirlines = new Set(normalizeAirlineCodes(preferences.blacklistedAirlines));
    const violations = normalizeAirlineCodes(offer.carrierCodes)
      .filter((airline) => blacklistedAirlines.has(airline))
      .map((airline) => ({
        constraint: 'BLACKLISTED_AIRLINE' as const,
        explanation: {
          key: 'constraint.airline.blacklisted' as const,
          params: { airline },
        },
      }));

    if (violations.length === 0) {
      return { eligible: true, violations: [] };
    }

    return { eligible: false, violations };
  }

  scoreOffers(
    offers: readonly FlightMatchInput[],
    preferences: ScoringPreferences,
  ): readonly ScoredOffer[] {
    const evaluatedOffers = offers.map((offer) => ({
      offer,
      eligibility: this.checkEligibility(offer, preferences),
    }));
    const eligibleOffers = evaluatedOffers
      .filter(({ eligibility }) => eligibility.eligible)
      .map(({ offer }) => offer);
    const medianPrice = calculateMedian(eligibleOffers.map(({ price }) => price));
    const medianDuration = calculateMedian(eligibleOffers.map(({ duration }) => duration));

    return evaluatedOffers.map(({ offer, eligibility }): ScoredOffer => {
      if (!eligibility.eligible) {
        return {
          offer,
          matchResult: {
            eligibility: { eligible: false, violations: eligibility.violations },
            score: null,
            matchLevel: null,
            breakdown: [],
            metadata: {
              scoringVersion: SCORING_POLICY_VERSION,
              activeWeights: BASE_WEIGHTS,
            },
          },
        };
      }

      const breakdown = [
        this.scorePrice(offer, medianPrice, preferences),
        this.scoreDuration(offer, medianDuration),
      ];
      const score = clamp(
        roundHalfAwayFromZero(
          breakdown.reduce((sum, dimension) => sum + dimension.contribution, 0) * 100,
        ),
        0,
        100,
      );

      return {
        offer,
        matchResult: {
          eligibility: { eligible: true, violations: [] },
          score,
          matchLevel: getMatchLevel(score),
          breakdown,
          metadata: {
            scoringVersion: SCORING_POLICY_VERSION,
            activeWeights: BASE_WEIGHTS,
          },
        },
      };
    });
  }

  private scorePrice(
    offer: FlightMatchInput,
    medianPrice: number,
    preferences: ScoringPreferences,
  ): DimensionScore {
    const score = round6(
      clamp(
        0.5 +
          0.5 *
            getPriceSensitivityMultiplier(preferences.priceSensitivity) *
            ((medianPrice - offer.price) / Math.max(medianPrice, 0.01)),
        0,
        1,
      ),
    );

    return {
      dimension: 'PRICE',
      score,
      weight: BASE_WEIGHTS.PRICE,
      contribution: round6(score * BASE_WEIGHTS.PRICE),
      signal: determineSignal(score),
      explanation: {
        key: getComparisonExplanationKey('PRICE', offer.price, medianPrice),
        params: {},
      },
    };
  }

  private scoreDuration(
    offer: FlightMatchInput,
    medianDuration: number,
  ): DimensionScore {
    const score = round6(
      clamp(
        0.5 +
          0.5 * ((medianDuration - offer.duration) / Math.max(medianDuration, 1)),
        0,
        1,
      ),
    );

    return {
      dimension: 'DURATION',
      score,
      weight: BASE_WEIGHTS.DURATION,
      contribution: round6(score * BASE_WEIGHTS.DURATION),
      signal: determineSignal(score),
      explanation: {
        key: getComparisonExplanationKey('DURATION', offer.duration, medianDuration),
        params: {},
      },
    };
  }
}

function normalizeAirlineCodes(codes: readonly unknown[]): readonly string[] {
  const normalizedCodes = new Set<string>();

  for (const code of codes) {
    if (typeof code !== 'string') {
      continue;
    }

    const normalizedCode = code.trim().toUpperCase();
    if (AIRLINE_CODE_PATTERN.test(normalizedCode)) {
      normalizedCodes.add(normalizedCode);
    }
  }

  return [...normalizedCodes];
}

function getComparisonExplanationKey(
  dimension: 'PRICE' | 'DURATION',
  value: number,
  median: number,
):
  | PriceMedianExplanationKey
  | DurationMedianExplanationKey {
  const comparison: MedianComparison = value < median ? 'below' : value > median ? 'above' : 'at';
  return MEDIAN_EXPLANATION_KEYS[dimension][comparison];
}
