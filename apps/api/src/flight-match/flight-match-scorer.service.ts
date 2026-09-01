import { Injectable } from '@nestjs/common';

import {
  BASE_WEIGHTS,
  calculateMedian,
  clamp,
  determineSignal,
  getCabinAdjacency,
  getMatchLevel,
  getPriceSensitivityMultiplier,
  hourDistanceToWindow,
  isHourInWindow,
  round6,
  roundHalfAwayFromZero,
  SCHEDULE_SHOULDER_HOURS,
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

const CABIN_ADJACENCY_MAPPINGS = {
  exact: { subScore: 1.0, key: 'match.cabin.exact' as const },
  adjacent: { subScore: 0.5, key: 'match.cabin.adjacent' as const },
  mismatch: { subScore: 0.0, key: 'match.cabin.mismatch' as const },
} as const;

const SCHEDULE_CONFIG = {
  DEPARTURE_SCHEDULE: {
    weight: BASE_WEIGHTS.DEPARTURE_SCHEDULE,
    inWindowKey: 'match.departure.in_window' as const,
    nearWindowKey: 'match.departure.near_window' as const,
    outsideWindowKey: 'match.departure.outside_window' as const,
  },
  ARRIVAL_SCHEDULE: {
    weight: BASE_WEIGHTS.ARRIVAL_SCHEDULE,
    inWindowKey: 'match.arrival.in_window' as const,
    nearWindowKey: 'match.arrival.near_window' as const,
    outsideWindowKey: 'match.arrival.outside_window' as const,
  },
} as const;

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
        params: {
          percentDiff:
            round6(((medianPrice - offer.price) / Math.max(medianPrice, 0.01)) * 100) || 0,
        },
      },
    };
  }

  scoreStops(
    offer: FlightMatchInput,
    preferences: ScoringPreferences,
    minStops: number,
  ): DimensionScore {
    if (preferences.maxStops !== null && preferences.maxStops !== undefined) {
      const maxStops = preferences.maxStops;
      const subScore =
        offer.stops <= maxStops
          ? 1.0
          : clamp(1 - 0.5 * (offer.stops - maxStops), 0, 1);
      const score = round6(subScore);
      const explanation =
        offer.stops <= maxStops
          ? {
              key: 'match.stops.within_preference' as const,
              params: { stops: offer.stops, maxStops },
            }
          : {
              key: 'match.stops.exceeds_preference' as const,
              params: { stops: offer.stops, maxStops },
            };

      return {
        dimension: 'STOPS',
        score,
        weight: BASE_WEIGHTS.STOPS,
        contribution: round6(score * BASE_WEIGHTS.STOPS),
        signal: determineSignal(score),
        explanation,
      };
    }

    const subScore = clamp(1 - 0.5 * (offer.stops - minStops), 0, 1);
    const score = round6(subScore);

    return {
      dimension: 'STOPS',
      score,
      weight: BASE_WEIGHTS.STOPS,
      contribution: round6(score * BASE_WEIGHTS.STOPS),
      signal: determineSignal(score),
      explanation: {
        key: 'match.stops.relative',
        params: { stops: offer.stops, minStops },
      },
    };
  }

  scoreAirline(
    offer: FlightMatchInput,
    preferences: ScoringPreferences,
  ): DimensionScore {
    const preferredCodes = normalizeAirlineCodes(preferences.preferredAirlines ?? []);
    if (preferredCodes.length > 0) {
      const preferredSet = new Set(preferredCodes);
      const offerCarriers = normalizeAirlineCodes(offer.carrierCodes ?? []);
      const matchedCarrier = offerCarriers.find((carrier) => preferredSet.has(carrier));

      if (matchedCarrier) {
        const score = round6(1.0);
        return {
          dimension: 'AIRLINE',
          score,
          weight: BASE_WEIGHTS.AIRLINE,
          contribution: round6(score * BASE_WEIGHTS.AIRLINE),
          signal: determineSignal(score),
          explanation: {
            key: 'match.airline.preferred',
            params: { airline: matchedCarrier },
          },
        };
      }
    }

    const score = round6(0.5);
    return {
      dimension: 'AIRLINE',
      score,
      weight: BASE_WEIGHTS.AIRLINE,
      contribution: round6(score * BASE_WEIGHTS.AIRLINE),
      signal: determineSignal(score),
      explanation: {
        key: 'match.airline.neutral',
        params: {},
      },
    };
  }

  scoreCabin(
    offer: FlightMatchInput,
    preferences: ScoringPreferences,
  ): DimensionScore {
    const adjacency = getCabinAdjacency(preferences.classPreference ?? '', offer.cabinClass);
    const { subScore, key: explanationKey } = CABIN_ADJACENCY_MAPPINGS[adjacency];
    const score = round6(subScore);

    return {
      dimension: 'CABIN',
      score,
      weight: BASE_WEIGHTS.CABIN,
      contribution: round6(score * BASE_WEIGHTS.CABIN),
      signal: determineSignal(score),
      explanation: {
        key: explanationKey,
        params: {
          expected: preferences.classPreference ?? undefined,
          actual: offer.cabinClass,
        },
      },
    };
  }

  scoreDepartureSchedule(
    offer: FlightMatchInput,
    preferences: ScoringPreferences,
  ): DimensionScore {
    return this.scoreScheduleWindow(
      'DEPARTURE_SCHEDULE',
      offer.outboundDepartureHour,
      preferences.preferredDepartureWindow,
    );
  }

  scoreArrivalSchedule(
    offer: FlightMatchInput,
    preferences: ScoringPreferences,
  ): DimensionScore {
    return this.scoreScheduleWindow(
      'ARRIVAL_SCHEDULE',
      offer.outboundArrivalHour,
      preferences.preferredArrivalWindow,
    );
  }

  scoreBaggage(
    offer: FlightMatchInput,
    preferences: ScoringPreferences,
  ): DimensionScore {
    let subScore: number;
    let explanationKey:
      | 'match.baggage.checked_included'
      | 'match.baggage.checked_missing'
      | 'match.baggage.not_required';
    let params: { checkedBags: number; required: boolean };

    if (preferences.requiresCheckedBaggage === true) {
      const hasBags = offer.hasCheckedBaggage === true;
      subScore = hasBags ? 1.0 : 0.0;
      explanationKey = hasBags
        ? 'match.baggage.checked_included'
        : 'match.baggage.checked_missing';
      params = { checkedBags: hasBags ? 1 : 0, required: true };
    } else {
      subScore = preferences.requiresCheckedBaggage === false ? 1.0 : 0.5;
      explanationKey = 'match.baggage.not_required';
      params = { checkedBags: offer.hasCheckedBaggage ? 1 : 0, required: false };
    }

    const score = round6(subScore);
    return {
      dimension: 'BAGGAGE',
      score,
      weight: BASE_WEIGHTS.BAGGAGE,
      contribution: round6(score * BASE_WEIGHTS.BAGGAGE),
      signal: determineSignal(score),
      explanation: {
        key: explanationKey,
        params,
      },
    };
  }

  private scoreScheduleWindow(
    dimension: 'DEPARTURE_SCHEDULE' | 'ARRIVAL_SCHEDULE',
    hour: number,
    window: Readonly<{ start: number; end: number }> | null | undefined,
  ): DimensionScore {
    const config = SCHEDULE_CONFIG[dimension];
    const formattedTime = `${String(hour).padStart(2, '0')}:00`;

    if (!window) {
      const score = round6(0.5);
      return {
        dimension,
        score,
        weight: config.weight,
        contribution: round6(score * config.weight),
        signal: determineSignal(score),
        explanation: {
          key: config.nearWindowKey,
          params: { time: formattedTime },
        },
      };
    }

    let subScore: number;
    let explanationKey:
      | typeof config.inWindowKey
      | typeof config.nearWindowKey
      | typeof config.outsideWindowKey;

    if (isHourInWindow(hour, window)) {
      subScore = 1.0;
      explanationKey = config.inWindowKey;
    } else {
      const hourDistance = hourDistanceToWindow(hour, window);
      subScore = clamp(1 - hourDistance / SCHEDULE_SHOULDER_HOURS, 0, 1);
      explanationKey = subScore >= 0.5 ? config.nearWindowKey : config.outsideWindowKey;
    }

    const score = round6(subScore);
    return {
      dimension,
      score,
      weight: config.weight,
      contribution: round6(score * config.weight),
      signal: determineSignal(score),
      explanation: {
        key: explanationKey,
        params: {
          time: formattedTime,
          windowStart: window.start,
          windowEnd: window.end,
        },
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
