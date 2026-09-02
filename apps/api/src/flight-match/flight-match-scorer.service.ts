import { Injectable } from '@nestjs/common';

import {
  BASE_WEIGHTS,
  calculateMedian,
  clamp,
  compareObjectiveTiers,
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
  ActiveWeights,
  DimensionScore,
  EligibilityResult,
  FlightMatchDimension,
  FlightMatchInput,
  MatchLevel,
  ScoredOffer,
  ScoringPreferences,
} from './flight-match.types';

const AIRLINE_CODE_PATTERN = /^[A-Z0-9]{2,3}$/;
const NORMALIZED_AIRLINE_CODES = new WeakMap<readonly unknown[], readonly string[]>();

type PersonalizedDimension =
  | 'AIRLINE'
  | 'ARRIVAL_SCHEDULE'
  | 'CABIN'
  | 'DEPARTURE_SCHEDULE'
  | 'BAGGAGE';

type BaselineDimension = 'PRICE' | 'STOPS' | 'DURATION';

const PERSONALIZED_DIMENSION_KEYS: readonly PersonalizedDimension[] = [
  'AIRLINE',
  'ARRIVAL_SCHEDULE',
  'CABIN',
  'DEPARTURE_SCHEDULE',
  'BAGGAGE',
];

const BASELINE_DIMENSION_KEYS: readonly BaselineDimension[] = [
  'PRICE',
  'STOPS',
  'DURATION',
];

const BASELINE_REMAINDER_KEYS: readonly BaselineDimension[] = [
  'PRICE',
  'STOPS',
  'DURATION',
];

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
    precomputedBlacklist?: ReadonlySet<string>,
  ): EligibilityResult {
    const blacklistedAirlines =
      precomputedBlacklist ?? new Set(normalizeAirlineCodes(preferences.blacklistedAirlines));
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

  resolveWeights(
    offers: readonly FlightMatchInput[],
    preferences: ScoringPreferences,
    preFilteredEligibleOffers?: readonly FlightMatchInput[],
    precomputedPreferredSet?: ReadonlySet<string>,
  ): ActiveWeights {
    const eligibleOffers =
      preFilteredEligibleOffers ??
      offers.filter((offer) => this.checkEligibility(offer, preferences).eligible);

    if (eligibleOffers.length === 0) {
      return { ...BASE_WEIGHTS };
    }

    const preferredSet =
      precomputedPreferredSet ??
      new Set(normalizeAirlineCodes(preferences.preferredAirlines ?? []));

    const isMissingPersonalized: Record<PersonalizedDimension, boolean> = {
      AIRLINE: preferredSet.size === 0,
      ARRIVAL_SCHEDULE: preferences.preferredArrivalWindow == null,
      CABIN: preferences.classPreference == null || preferences.classPreference.trim() === '',
      DEPARTURE_SCHEDULE: preferences.preferredDepartureWindow == null,
      BAGGAGE: preferences.requiresCheckedBaggage == null,
    };

    const applyZeroVariance = eligibleOffers.length >= 2;

    let isBaselineActive: Record<BaselineDimension, boolean>;

    if (applyZeroVariance) {
      const medianPrice = calculateMedian(eligibleOffers.map((o) => o.price));
      const medianDuration = calculateMedian(eligibleOffers.map((o) => o.duration));
      const minStops = Math.min(...eligibleOffers.map((o) => o.stops));

      const priceMultiplier = getPriceSensitivityMultiplier(preferences.priceSensitivity);
      const getPriceScore = (o: FlightMatchInput) =>
        round6(
          clamp(
            0.5 +
              0.5 *
                priceMultiplier *
                ((medianPrice - o.price) / Math.max(medianPrice, 0.01)),
            0,
            1,
          ),
        );

      const firstPrice = getPriceScore(eligibleOffers[0]);
      let priceZeroVariance = true;
      for (let i = 1; i < eligibleOffers.length; i++) {
        if (getPriceScore(eligibleOffers[i]) !== firstPrice) {
          priceZeroVariance = false;
          break;
        }
      }

      const maxStopsPref = preferences.maxStops;
      const getStopsScore = (o: FlightMatchInput) =>
        maxStopsPref !== null && maxStopsPref !== undefined
          ? round6(o.stops <= maxStopsPref ? 1.0 : clamp(1 - 0.5 * (o.stops - maxStopsPref), 0, 1))
          : round6(clamp(1 - 0.5 * (o.stops - minStops), 0, 1));

      const firstStops = getStopsScore(eligibleOffers[0]);
      let stopsZeroVariance = true;
      for (let i = 1; i < eligibleOffers.length; i++) {
        if (getStopsScore(eligibleOffers[i]) !== firstStops) {
          stopsZeroVariance = false;
          break;
        }
      }

      const getDurationScore = (o: FlightMatchInput) =>
        round6(
          clamp(
            0.5 + 0.5 * ((medianDuration - o.duration) / Math.max(medianDuration, 1)),
            0,
            1,
          ),
        );

      const firstDuration = getDurationScore(eligibleOffers[0]);
      let durationZeroVariance = true;
      for (let i = 1; i < eligibleOffers.length; i++) {
        if (getDurationScore(eligibleOffers[i]) !== firstDuration) {
          durationZeroVariance = false;
          break;
        }
      }

      const allBaselineZeroVariance =
        priceZeroVariance && stopsZeroVariance && durationZeroVariance;

      isBaselineActive = {
        PRICE: allBaselineZeroVariance || !priceZeroVariance,
        STOPS: allBaselineZeroVariance || !stopsZeroVariance,
        DURATION: allBaselineZeroVariance || !durationZeroVariance,
      };
    } else {
      isBaselineActive = {
        PRICE: true,
        STOPS: true,
        DURATION: true,
      };
    }

    const isPersonalizedActive: Record<PersonalizedDimension, boolean> = {
      AIRLINE: false,
      ARRIVAL_SCHEDULE: false,
      CABIN: false,
      DEPARTURE_SCHEDULE: false,
      BAGGAGE: false,
    };

    for (const dim of PERSONALIZED_DIMENSION_KEYS) {
      if (isMissingPersonalized[dim]) {
        isPersonalizedActive[dim] = false;
        continue;
      }

      if (!applyZeroVariance) {
        isPersonalizedActive[dim] = true;
        continue;
      }

      let isZeroVariance = true;
      switch (dim) {
        case 'AIRLINE': {
          const getScore = (o: FlightMatchInput) =>
            preferredSet.size > 0 &&
            normalizeAirlineCodes(o.carrierCodes ?? []).some((c) => preferredSet.has(c))
              ? 1.0
              : 0.5;
          const first = getScore(eligibleOffers[0]);
          for (let i = 1; i < eligibleOffers.length; i++) {
            if (getScore(eligibleOffers[i]) !== first) {
              isZeroVariance = false;
              break;
            }
          }
          break;
        }
        case 'ARRIVAL_SCHEDULE': {
          const window = preferences.preferredArrivalWindow;
          if (!window) {
            isZeroVariance = true;
            break;
          }
          const getScore = (o: FlightMatchInput) => {
            const h = o.outboundArrivalHour;
            if (isHourInWindow(h, window)) return 1.0;
            const dist = hourDistanceToWindow(h, window);
            return round6(clamp(1 - dist / SCHEDULE_SHOULDER_HOURS, 0, 1));
          };
          const first = getScore(eligibleOffers[0]);
          for (let i = 1; i < eligibleOffers.length; i++) {
            if (getScore(eligibleOffers[i]) !== first) {
              isZeroVariance = false;
              break;
            }
          }
          break;
        }
        case 'CABIN': {
          const reqClass = preferences.classPreference ?? '';
          const getScore = (o: FlightMatchInput) =>
            CABIN_ADJACENCY_MAPPINGS[getCabinAdjacency(reqClass, o.cabinClass)].subScore;
          const first = getScore(eligibleOffers[0]);
          for (let i = 1; i < eligibleOffers.length; i++) {
            if (getScore(eligibleOffers[i]) !== first) {
              isZeroVariance = false;
              break;
            }
          }
          break;
        }
        case 'DEPARTURE_SCHEDULE': {
          const window = preferences.preferredDepartureWindow;
          if (!window) {
            isZeroVariance = true;
            break;
          }
          const getScore = (o: FlightMatchInput) => {
            const h = o.outboundDepartureHour;
            if (isHourInWindow(h, window)) return 1.0;
            const dist = hourDistanceToWindow(h, window);
            return round6(clamp(1 - dist / SCHEDULE_SHOULDER_HOURS, 0, 1));
          };
          const first = getScore(eligibleOffers[0]);
          for (let i = 1; i < eligibleOffers.length; i++) {
            if (getScore(eligibleOffers[i]) !== first) {
              isZeroVariance = false;
              break;
            }
          }
          break;
        }
        case 'BAGGAGE': {
          const req = preferences.requiresCheckedBaggage;
          const getScore = (o: FlightMatchInput) => {
            if (req === true) return o.hasCheckedBaggage === true ? 1.0 : 0.0;
            if (req === false) return 1.0;
            return 0.5;
          };
          const first = getScore(eligibleOffers[0]);
          for (let i = 1; i < eligibleOffers.length; i++) {
            if (getScore(eligibleOffers[i]) !== first) {
              isZeroVariance = false;
              break;
            }
          }
          break;
        }
      }

      isPersonalizedActive[dim] = !isZeroVariance;
    }

    const mutableWeights: Record<FlightMatchDimension, number> = {
      PRICE: 0,
      AIRLINE: 0,
      ARRIVAL_SCHEDULE: 0,
      STOPS: 0,
      CABIN: 0,
      DEPARTURE_SCHEDULE: 0,
      BAGGAGE: 0,
      DURATION: 0,
    };

    let sumPersonalizedWeights = 0;
    for (const dim of PERSONALIZED_DIMENSION_KEYS) {
      if (isPersonalizedActive[dim]) {
        mutableWeights[dim] = BASE_WEIGHTS[dim];
        sumPersonalizedWeights += BASE_WEIGHTS[dim];
      } else {
        mutableWeights[dim] = 0;
      }
    }

    const baselineTargetPool = round6(1.0 - sumPersonalizedWeights);

    const activeBaselineDimensions = BASELINE_DIMENSION_KEYS.filter(
      (dim) => isBaselineActive[dim],
    );
    const sumActiveBaselineBaseWeights = activeBaselineDimensions.reduce(
      (sum, dim) => sum + BASE_WEIGHTS[dim],
      0,
    );

    for (const dim of BASELINE_DIMENSION_KEYS) {
      if (isBaselineActive[dim]) {
        mutableWeights[dim] = round6(
          (BASE_WEIGHTS[dim] / sumActiveBaselineBaseWeights) * baselineTargetPool,
        );
      } else {
        mutableWeights[dim] = 0;
      }
    }

    const currentSum = round6(
      Object.values(mutableWeights).reduce((sum, w) => sum + w, 0),
    );
    const remainder = round6(1.0 - currentSum);

    if (remainder !== 0) {
      const highestPriorityBaseline = BASELINE_REMAINDER_KEYS.find(
        (dim) => isBaselineActive[dim],
      );
      if (highestPriorityBaseline) {
        mutableWeights[highestPriorityBaseline] = round6(
          mutableWeights[highestPriorityBaseline] + remainder,
        );
      }
    }

    return {
      PRICE: mutableWeights.PRICE,
      AIRLINE: mutableWeights.AIRLINE,
      ARRIVAL_SCHEDULE: mutableWeights.ARRIVAL_SCHEDULE,
      STOPS: mutableWeights.STOPS,
      CABIN: mutableWeights.CABIN,
      DEPARTURE_SCHEDULE: mutableWeights.DEPARTURE_SCHEDULE,
      BAGGAGE: mutableWeights.BAGGAGE,
      DURATION: mutableWeights.DURATION,
    };
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
      const { score, matchLevel } = this.computeScoreResult(breakdown);

      return {
        offer,
        matchResult: {
          eligibility: { eligible: true, violations: [] },
          score,
          matchLevel,
          breakdown,
          metadata: {
            scoringVersion: SCORING_POLICY_VERSION,
            activeWeights: BASE_WEIGHTS,
          },
        },
      };
    });
  }

  scoreAll(
    offers: readonly FlightMatchInput[],
    preferences: ScoringPreferences,
  ): readonly ScoredOffer[] {
    const blacklistedSet = new Set(normalizeAirlineCodes(preferences.blacklistedAirlines));
    const evaluatedOffers = offers.map((offer) => ({
      offer,
      eligibility: this.checkEligibility(offer, preferences, blacklistedSet),
    }));

    const eligibleOffers = evaluatedOffers
      .filter(({ eligibility }) => eligibility.eligible)
      .map(({ offer }) => offer);

    const preferredSet = new Set(normalizeAirlineCodes(preferences.preferredAirlines ?? []));
    const activeWeights = this.resolveWeights(offers, preferences, eligibleOffers, preferredSet);

    const medianPrice = calculateMedian(eligibleOffers.map(({ price }) => price));
    const medianDuration = calculateMedian(eligibleOffers.map(({ duration }) => duration));
    const minStops =
      eligibleOffers.length > 0
        ? Math.min(...eligibleOffers.map(({ stops }) => stops))
        : 0;

    const scoredOffers: ScoredOffer[] = evaluatedOffers.map(({ offer, eligibility }) => {
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
              activeWeights,
            },
          },
        };
      }

      const breakdown: readonly DimensionScore[] = [
        this.scorePrice(offer, medianPrice, preferences, activeWeights.PRICE),
        this.scoreAirline(offer, preferences, activeWeights.AIRLINE, preferredSet),
        this.scoreArrivalSchedule(offer, preferences, activeWeights.ARRIVAL_SCHEDULE),
        this.scoreStops(offer, preferences, minStops, activeWeights.STOPS),
        this.scoreCabin(offer, preferences, activeWeights.CABIN),
        this.scoreDepartureSchedule(offer, preferences, activeWeights.DEPARTURE_SCHEDULE),
        this.scoreBaggage(offer, preferences, activeWeights.BAGGAGE),
        this.scoreDuration(offer, medianDuration, activeWeights.DURATION),
      ];

      const { score, matchLevel } = this.computeScoreResult(breakdown);

      return {
        offer,
        matchResult: {
          eligibility: { eligible: true, violations: [] },
          score,
          matchLevel,
          breakdown,
          metadata: {
            scoringVersion: SCORING_POLICY_VERSION,
            activeWeights,
          },
        },
      };
    });

    return [...scoredOffers].sort((a, b) => {
      const aEligible = a.matchResult.eligibility.eligible;
      const bEligible = b.matchResult.eligibility.eligible;

      if (aEligible !== bEligible) {
        return aEligible ? -1 : 1;
      }

      if (!aEligible && !bEligible) {
        return a.offer.originalIndex - b.offer.originalIndex;
      }

      const aScore = a.matchResult.score ?? 0;
      const bScore = b.matchResult.score ?? 0;
      if (aScore !== bScore) {
        return bScore - aScore;
      }

      return compareObjectiveTiers(a.offer, b.offer);
    });
  }

  computeContribution(subScore: number, effectiveWeight: number): number {
    return round6(subScore * effectiveWeight);
  }

  computeFinalScore(breakdown: readonly DimensionScore[]): number {
    const sum = breakdown.reduce((acc, item) => acc + item.contribution, 0);
    return clamp(roundHalfAwayFromZero(round6(sum * 100)), 0, 100);
  }

  getMatchLevel(score: number): MatchLevel {
    return getMatchLevel(score);
  }

  computeScoreResult(breakdown: readonly DimensionScore[]): {
    score: number;
    matchLevel: MatchLevel;
  } {
    const score = this.computeFinalScore(breakdown);
    return {
      score,
      matchLevel: this.getMatchLevel(score),
    };
  }

  scorePrice(
    offer: FlightMatchInput,
    medianPrice: number,
    preferences: ScoringPreferences,
    effectiveWeight: number = BASE_WEIGHTS.PRICE,
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
      weight: effectiveWeight,
      contribution: this.computeContribution(score, effectiveWeight),
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
    effectiveWeight: number = BASE_WEIGHTS.STOPS,
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
        weight: effectiveWeight,
        contribution: this.computeContribution(score, effectiveWeight),
        signal: determineSignal(score),
        explanation,
      };
    }

    const subScore = clamp(1 - 0.5 * (offer.stops - minStops), 0, 1);
    const score = round6(subScore);

    return {
      dimension: 'STOPS',
      score,
      weight: effectiveWeight,
      contribution: this.computeContribution(score, effectiveWeight),
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
    effectiveWeight: number = BASE_WEIGHTS.AIRLINE,
    precomputedPreferredSet?: ReadonlySet<string>,
  ): DimensionScore {
    const preferredSet =
      precomputedPreferredSet ??
      new Set(normalizeAirlineCodes(preferences.preferredAirlines ?? []));
    if (preferredSet.size > 0) {
      const offerCarriers = normalizeAirlineCodes(offer.carrierCodes ?? []);
      const matchedCarrier = offerCarriers.find((carrier) => preferredSet.has(carrier));

      if (matchedCarrier) {
        const score = round6(1.0);
        return {
          dimension: 'AIRLINE',
          score,
          weight: effectiveWeight,
          contribution: this.computeContribution(score, effectiveWeight),
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
      weight: effectiveWeight,
      contribution: this.computeContribution(score, effectiveWeight),
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
    effectiveWeight: number = BASE_WEIGHTS.CABIN,
  ): DimensionScore {
    const adjacency = getCabinAdjacency(preferences.classPreference ?? '', offer.cabinClass);
    const { subScore, key: explanationKey } = CABIN_ADJACENCY_MAPPINGS[adjacency];
    const score = round6(subScore);

    return {
      dimension: 'CABIN',
      score,
      weight: effectiveWeight,
      contribution: this.computeContribution(score, effectiveWeight),
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
    effectiveWeight: number = BASE_WEIGHTS.DEPARTURE_SCHEDULE,
  ): DimensionScore {
    return this.scoreScheduleWindow(
      'DEPARTURE_SCHEDULE',
      offer.outboundDepartureHour,
      preferences.preferredDepartureWindow,
      effectiveWeight,
    );
  }

  scoreArrivalSchedule(
    offer: FlightMatchInput,
    preferences: ScoringPreferences,
    effectiveWeight: number = BASE_WEIGHTS.ARRIVAL_SCHEDULE,
  ): DimensionScore {
    return this.scoreScheduleWindow(
      'ARRIVAL_SCHEDULE',
      offer.outboundArrivalHour,
      preferences.preferredArrivalWindow,
      effectiveWeight,
    );
  }

  scoreBaggage(
    offer: FlightMatchInput,
    preferences: ScoringPreferences,
    effectiveWeight: number = BASE_WEIGHTS.BAGGAGE,
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
      weight: effectiveWeight,
      contribution: this.computeContribution(score, effectiveWeight),
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
    effectiveWeight: number = SCHEDULE_CONFIG[dimension].weight,
  ): DimensionScore {
    const config = SCHEDULE_CONFIG[dimension];
    const formattedTime = `${String(hour).padStart(2, '0')}:00`;

    if (!window) {
      const score = round6(0.5);
      return {
        dimension,
        score,
        weight: effectiveWeight,
        contribution: this.computeContribution(score, effectiveWeight),
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
      weight: effectiveWeight,
      contribution: this.computeContribution(score, effectiveWeight),
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

  scoreDuration(
    offer: FlightMatchInput,
    medianDuration: number,
    effectiveWeight: number = BASE_WEIGHTS.DURATION,
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
      weight: effectiveWeight,
      contribution: this.computeContribution(score, effectiveWeight),
      signal: determineSignal(score),
      explanation: {
        key: getComparisonExplanationKey('DURATION', offer.duration, medianDuration),
        params: {},
      },
    };
  }
}

function normalizeAirlineCodes(codes: readonly unknown[]): readonly string[] {
  if (!codes || codes.length === 0) {
    return [];
  }

  const cached = NORMALIZED_AIRLINE_CODES.get(codes);
  if (cached) {
    return cached;
  }

  if (codes.length === 1 && typeof codes[0] === 'string') {
    const normalizedCode = codes[0].trim().toUpperCase();
    const normalizedCodes = AIRLINE_CODE_PATTERN.test(normalizedCode) ? [normalizedCode] : [];
    NORMALIZED_AIRLINE_CODES.set(codes, normalizedCodes);
    return normalizedCodes;
  }

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

  const result = [...normalizedCodes];
  NORMALIZED_AIRLINE_CODES.set(codes, result);
  return result;
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
