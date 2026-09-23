import { Injectable } from '@nestjs/common';

import {
  BASE_WEIGHTS,
  calculateMedian,
  clamp,
  compareObjectiveTiers,
  determineSignal,
  formatHour,
  getCabinAdjacency,
  getMatchLevel,
  getPriceSensitivityMultiplier,
  type HourWindow,
  hourDistanceToWindow,
  isHourInWindow,
  round6,
  roundHalfAwayFromZero,
  SCHEDULE_SHOULDER_HOURS,
  SCORING_POLICY_VERSION,
} from './flight-match.policy';
import type {
  ActiveWeights,
  ConstraintViolation,
  DimensionScore,
  FlightMatchInput,
  MatchLevel,
  ScoredOffer,
  ScoringPreferences,
} from './flight-match.types';

const AIRLINE_CODE_PATTERN = /^[A-Z0-9]{2,3}$/;
const NORMALIZED_AIRLINE_CODES = new WeakMap<readonly unknown[], readonly string[]>();
const EMPTY_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_BREAKDOWN: readonly [] = [];
const EMPTY_OBJECT: Readonly<Record<string, unknown>> = Object.freeze({});
const ELIGIBLE_RESULT = Object.freeze({
  eligible: true as const,
  violations: [] as const,
});

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
  ):
    | { readonly eligible: true; readonly violations: readonly [] }
    | { readonly eligible: false; readonly violations: readonly ConstraintViolation[] } {
    const blacklistedAirlines =
      precomputedBlacklist ??
      (preferences.blacklistedAirlines && preferences.blacklistedAirlines.length > 0
        ? new Set(normalizeAirlineCodes(preferences.blacklistedAirlines))
        : EMPTY_SET);

    if (blacklistedAirlines.size === 0) {
      return ELIGIBLE_RESULT;
    }

    const carriers = normalizeAirlineCodes(offer.carrierCodes);
    let violations: Array<{
      constraint: 'BLACKLISTED_AIRLINE';
      explanation: {
        key: 'constraint.airline.blacklisted';
        params: { airline: string };
      };
    }> | undefined;

    for (let i = 0; i < carriers.length; i++) {
      const airline = carriers[i];
      if (blacklistedAirlines.has(airline)) {
        if (!violations) violations = [];
        violations.push({
          constraint: 'BLACKLISTED_AIRLINE' as const,
          explanation: {
            key: 'constraint.airline.blacklisted' as const,
            params: { airline },
          },
        });
      }
    }

    if (!violations || violations.length === 0) {
      return ELIGIBLE_RESULT;
    }

    return { eligible: false, violations };
  }

  resolveWeights(
    offers: readonly FlightMatchInput[],
    preferences: ScoringPreferences,
    preFilteredEligibleOffers?: readonly FlightMatchInput[],
    precomputedPreferredSet?: ReadonlySet<string>,
    precomputedMetrics?: {
      medianPrice: number;
      medianDuration: number;
      minStops: number;
    },
  ): ActiveWeights {
    let eligibleOffers: readonly FlightMatchInput[];
    if (preFilteredEligibleOffers) {
      eligibleOffers = preFilteredEligibleOffers;
    } else {
      const filtered: FlightMatchInput[] = [];
      const blSet =
        preferences.blacklistedAirlines && preferences.blacklistedAirlines.length > 0
          ? new Set(normalizeAirlineCodes(preferences.blacklistedAirlines))
          : EMPTY_SET;
      for (let i = 0; i < offers.length; i++) {
        if (this.checkEligibility(offers[i], preferences, blSet).eligible) {
          filtered.push(offers[i]);
        }
      }
      eligibleOffers = filtered;
    }

    const nEligible = eligibleOffers.length;
    if (nEligible === 0) {
      return { ...BASE_WEIGHTS };
    }

    const preferredSet =
      precomputedPreferredSet ??
      (preferences.preferredAirlines && preferences.preferredAirlines.length > 0
        ? new Set(normalizeAirlineCodes(preferences.preferredAirlines))
        : EMPTY_SET);

    const applyZeroVariance = nEligible >= 2;

    let priceActive = true;
    let stopsActive = true;
    let durationActive = true;

    if (applyZeroVariance) {
      let medianPrice = precomputedMetrics?.medianPrice;
      let medianDuration = precomputedMetrics?.medianDuration;
      let minStops = precomputedMetrics?.minStops;

      if (medianPrice === undefined || medianDuration === undefined || minStops === undefined) {
        const prices: number[] = new Array(nEligible);
        const durations: number[] = new Array(nEligible);
        let minS = Infinity;
        for (let i = 0; i < nEligible; i++) {
          const o = eligibleOffers[i];
          prices[i] = o.price;
          durations[i] = o.duration;
          if (o.stops < minS) minS = o.stops;
        }
        if (medianPrice === undefined) medianPrice = calculateMedian(prices);
        if (medianDuration === undefined) medianDuration = calculateMedian(durations);
        if (minStops === undefined) minStops = minS === Infinity ? 0 : minS;
      }

      const priceMultiplier = getPriceSensitivityMultiplier(preferences.priceSensitivity);
      const priceDenom = Math.max(medianPrice, 0.01);
      const priceFactor = 0.5 * priceMultiplier;

      const firstPriceScore = round6(
        clamp(0.5 + priceFactor * ((medianPrice - eligibleOffers[0].price) / priceDenom), 0, 1),
      );
      let priceZeroVariance = true;
      for (let i = 1; i < nEligible; i++) {
        const score = round6(
          clamp(0.5 + priceFactor * ((medianPrice - eligibleOffers[i].price) / priceDenom), 0, 1),
        );
        if (score !== firstPriceScore) {
          priceZeroVariance = false;
          break;
        }
      }

      const maxStopsPref = preferences.maxStops;
      const hasMaxStops = maxStopsPref !== null && maxStopsPref !== undefined;
      const firstStops = eligibleOffers[0].stops;
      const firstStopsScore = hasMaxStops
        ? round6(firstStops <= (maxStopsPref as number) ? 1.0 : clamp(1 - 0.5 * (firstStops - (maxStopsPref as number)), 0, 1))
        : round6(clamp(1 - 0.5 * (firstStops - minStops), 0, 1));
      let stopsZeroVariance = true;
      for (let i = 1; i < nEligible; i++) {
        const stops = eligibleOffers[i].stops;
        const score = hasMaxStops
          ? round6(stops <= (maxStopsPref as number) ? 1.0 : clamp(1 - 0.5 * (stops - (maxStopsPref as number)), 0, 1))
          : round6(clamp(1 - 0.5 * (stops - minStops), 0, 1));
        if (score !== firstStopsScore) {
          stopsZeroVariance = false;
          break;
        }
      }

      const durDenom = Math.max(medianDuration, 1);
      const firstDurScore = round6(
        clamp(0.5 + 0.5 * ((medianDuration - eligibleOffers[0].duration) / durDenom), 0, 1),
      );
      let durationZeroVariance = true;
      for (let i = 1; i < nEligible; i++) {
        const score = round6(
          clamp(0.5 + 0.5 * ((medianDuration - eligibleOffers[i].duration) / durDenom), 0, 1),
        );
        if (score !== firstDurScore) {
          durationZeroVariance = false;
          break;
        }
      }

      const allBaselineZeroVariance =
        priceZeroVariance && stopsZeroVariance && durationZeroVariance;

      priceActive = allBaselineZeroVariance || !priceZeroVariance;
      stopsActive = allBaselineZeroVariance || !stopsZeroVariance;
      durationActive = allBaselineZeroVariance || !durationZeroVariance;
    }

    // Personalized dimensions
    let airlineActive = false;
    let arrivalActive = false;
    let cabinActive = false;
    let departureActive = false;
    let baggageActive = false;

    // AIRLINE
    if (preferredSet.size > 0) {
      if (!applyZeroVariance) {
        airlineActive = true;
      } else {
        const firstScore = hasPreferredAirline(eligibleOffers[0].carrierCodes, preferredSet) ? 1.0 : 0.5;
        let zeroVar = true;
        for (let i = 1; i < nEligible; i++) {
          if ((hasPreferredAirline(eligibleOffers[i].carrierCodes, preferredSet) ? 1.0 : 0.5) !== firstScore) {
            zeroVar = false;
            break;
          }
        }
        airlineActive = !zeroVar;
      }
    }

    // ARRIVAL_SCHEDULE
    const arrWindow = preferences.preferredArrivalWindow;
    if (arrWindow != null) {
      if (!applyZeroVariance) {
        arrivalActive = true;
      } else {
        const firstScore = calcScheduleScore(eligibleOffers[0].outboundArrivalHour, arrWindow);
        let zeroVar = true;
        for (let i = 1; i < nEligible; i++) {
          if (calcScheduleScore(eligibleOffers[i].outboundArrivalHour, arrWindow) !== firstScore) {
            zeroVar = false;
            break;
          }
        }
        arrivalActive = !zeroVar;
      }
    }

    // CABIN
    const classPref = preferences.classPreference;
    if (classPref != null && classPref.trim() !== '') {
      if (!applyZeroVariance) {
        cabinActive = true;
      } else {
        const firstScore = CABIN_ADJACENCY_MAPPINGS[getCabinAdjacency(classPref, eligibleOffers[0].cabinClass)].subScore;
        let zeroVar = true;
        for (let i = 1; i < nEligible; i++) {
          if (CABIN_ADJACENCY_MAPPINGS[getCabinAdjacency(classPref, eligibleOffers[i].cabinClass)].subScore !== firstScore) {
            zeroVar = false;
            break;
          }
        }
        cabinActive = !zeroVar;
      }
    }

    // DEPARTURE_SCHEDULE
    const depWindow = preferences.preferredDepartureWindow;
    if (depWindow != null) {
      if (!applyZeroVariance) {
        departureActive = true;
      } else {
        const firstScore = calcScheduleScore(eligibleOffers[0].outboundDepartureHour, depWindow);
        let zeroVar = true;
        for (let i = 1; i < nEligible; i++) {
          if (calcScheduleScore(eligibleOffers[i].outboundDepartureHour, depWindow) !== firstScore) {
            zeroVar = false;
            break;
          }
        }
        departureActive = !zeroVar;
      }
    }

    // BAGGAGE
    const bagReq = preferences.requiresCheckedBaggage;
    if (bagReq != null) {
      if (!applyZeroVariance) {
        baggageActive = true;
      } else {
        const firstScore = calcBaggageScore(eligibleOffers[0].hasCheckedBaggage, bagReq);
        let zeroVar = true;
        for (let i = 1; i < nEligible; i++) {
          if (calcBaggageScore(eligibleOffers[i].hasCheckedBaggage, bagReq) !== firstScore) {
            zeroVar = false;
            break;
          }
        }
        baggageActive = !zeroVar;
      }
    }

    const airlineWeight = airlineActive ? BASE_WEIGHTS.AIRLINE : 0;
    const arrivalWeight = arrivalActive ? BASE_WEIGHTS.ARRIVAL_SCHEDULE : 0;
    const cabinWeight = cabinActive ? BASE_WEIGHTS.CABIN : 0;
    const departureWeight = departureActive ? BASE_WEIGHTS.DEPARTURE_SCHEDULE : 0;
    const baggageWeight = baggageActive ? BASE_WEIGHTS.BAGGAGE : 0;

    const sumPersonalizedWeights =
      airlineWeight + arrivalWeight + cabinWeight + departureWeight + baggageWeight;

    const baselineTargetPool = round6(1.0 - sumPersonalizedWeights);

    let sumActiveBaselineBaseWeights = 0;
    if (priceActive) sumActiveBaselineBaseWeights += BASE_WEIGHTS.PRICE;
    if (stopsActive) sumActiveBaselineBaseWeights += BASE_WEIGHTS.STOPS;
    if (durationActive) sumActiveBaselineBaseWeights += BASE_WEIGHTS.DURATION;

    let priceWeight = priceActive
      ? round6((BASE_WEIGHTS.PRICE / sumActiveBaselineBaseWeights) * baselineTargetPool)
      : 0;
    let stopsWeight = stopsActive
      ? round6((BASE_WEIGHTS.STOPS / sumActiveBaselineBaseWeights) * baselineTargetPool)
      : 0;
    let durationWeight = durationActive
      ? round6((BASE_WEIGHTS.DURATION / sumActiveBaselineBaseWeights) * baselineTargetPool)
      : 0;

    const currentSum = round6(
      priceWeight +
      airlineWeight +
      arrivalWeight +
      stopsWeight +
      cabinWeight +
      departureWeight +
      baggageWeight +
      durationWeight,
    );
    const remainder = round6(1.0 - currentSum);

    if (remainder !== 0) {
      if (priceActive) {
        priceWeight = round6(priceWeight + remainder);
      } else if (stopsActive) {
        stopsWeight = round6(stopsWeight + remainder);
      } else if (durationActive) {
        durationWeight = round6(durationWeight + remainder);
      }
    }

    return {
      PRICE: priceWeight,
      AIRLINE: airlineWeight,
      ARRIVAL_SCHEDULE: arrivalWeight,
      STOPS: stopsWeight,
      CABIN: cabinWeight,
      DEPARTURE_SCHEDULE: departureWeight,
      BAGGAGE: baggageWeight,
      DURATION: durationWeight,
    };
  }

  scoreOffers(
    offers: readonly FlightMatchInput[],
    preferences: ScoringPreferences,
  ): readonly ScoredOffer[] {
    const numOffers = offers.length;
    type EvaluatedEligibility = ReturnType<FlightMatchScorerService['checkEligibility']>;
    const eligibilities: EvaluatedEligibility[] = new Array(numOffers);
    const eligiblePrices: number[] = [];
    const eligibleDurations: number[] = [];

    for (let i = 0; i < numOffers; i++) {
      const offer = offers[i];
      const eligibility = this.checkEligibility(offer, preferences);
      eligibilities[i] = eligibility;
      if (eligibility.eligible) {
        eligiblePrices.push(offer.price);
        eligibleDurations.push(offer.duration);
      }
    }

    const medianPrice = calculateMedian(eligiblePrices);
    const medianDuration = calculateMedian(eligibleDurations);
    const metadata = {
      scoringVersion: SCORING_POLICY_VERSION,
      activeWeights: BASE_WEIGHTS,
    };

    const scoredOffers: ScoredOffer[] = new Array(numOffers);
    for (let i = 0; i < numOffers; i++) {
      const offer = offers[i];
      const eligibility = eligibilities[i];
      if (!eligibility.eligible) {
        scoredOffers[i] = {
          offer,
          matchResult: {
            eligibility,
            score: null,
            matchLevel: null,
            breakdown: EMPTY_BREAKDOWN,
            metadata,
          },
        };
        continue;
      }

      const breakdown = [
        this.scorePrice(offer, medianPrice, preferences),
        this.scoreDuration(offer, medianDuration),
      ];
      const { score, matchLevel } = this.computeScoreResult(breakdown);

      scoredOffers[i] = {
        offer,
        matchResult: {
          eligibility: ELIGIBLE_RESULT,
          score,
          matchLevel,
          breakdown,
          metadata,
        },
      };
    }

    return scoredOffers;
  }

  scoreAll(
    offers: readonly FlightMatchInput[],
    preferences: ScoringPreferences,
  ): readonly ScoredOffer[] {
    const numOffers = offers.length;
    const blacklistedSet =
      preferences.blacklistedAirlines && preferences.blacklistedAirlines.length > 0
        ? new Set(normalizeAirlineCodes(preferences.blacklistedAirlines))
        : EMPTY_SET;

    type EvaluatedEligibility = ReturnType<FlightMatchScorerService['checkEligibility']>;
    const eligibilities: EvaluatedEligibility[] = new Array(numOffers);
    const eligibleOffers: FlightMatchInput[] = [];
    const prices: number[] = [];
    const durations: number[] = [];
    let minStops = Infinity;

    for (let i = 0; i < numOffers; i++) {
      const offer = offers[i];
      const eligibility = this.checkEligibility(offer, preferences, blacklistedSet);
      eligibilities[i] = eligibility;
      if (eligibility.eligible) {
        eligibleOffers.push(offer);
        prices.push(offer.price);
        durations.push(offer.duration);
        if (offer.stops < minStops) {
          minStops = offer.stops;
        }
      }
    }
    if (minStops === Infinity) {
      minStops = 0;
    }

    const preferredSet =
      preferences.preferredAirlines && preferences.preferredAirlines.length > 0
        ? new Set(normalizeAirlineCodes(preferences.preferredAirlines))
        : EMPTY_SET;

    const medianPrice = calculateMedian(prices);
    const medianDuration = calculateMedian(durations);
    const metrics = { medianPrice, medianDuration, minStops };

    const activeWeights = this.resolveWeights(
      offers,
      preferences,
      eligibleOffers,
      preferredSet,
      metrics,
    );

    const metadata = {
      scoringVersion: SCORING_POLICY_VERSION,
      activeWeights,
    };

    const priceMultiplier = getPriceSensitivityMultiplier(preferences.priceSensitivity);
    const scoredOffers: ScoredOffer[] = new Array(numOffers);

    for (let i = 0; i < numOffers; i++) {
      const offer = offers[i];
      const eligibility = eligibilities[i];
      if (!eligibility.eligible) {
        scoredOffers[i] = {
          offer,
          matchResult: {
            eligibility,
            score: null,
            matchLevel: null,
            breakdown: EMPTY_BREAKDOWN,
            metadata,
          },
        };
        continue;
      }

      const scorePrice = this.scorePrice(offer, medianPrice, preferences, activeWeights.PRICE, priceMultiplier);
      const scoreAirline = this.scoreAirline(offer, preferences, activeWeights.AIRLINE, preferredSet);
      const scoreArrivalSchedule = this.scoreArrivalSchedule(offer, preferences, activeWeights.ARRIVAL_SCHEDULE);
      const scoreStops = this.scoreStops(offer, preferences, minStops, activeWeights.STOPS);
      const scoreCabin = this.scoreCabin(offer, preferences, activeWeights.CABIN);
      const scoreDepartureSchedule = this.scoreDepartureSchedule(offer, preferences, activeWeights.DEPARTURE_SCHEDULE);
      const scoreBaggage = this.scoreBaggage(offer, preferences, activeWeights.BAGGAGE);
      const scoreDuration = this.scoreDuration(offer, medianDuration, activeWeights.DURATION);

      const breakdown: readonly DimensionScore[] = [
        scorePrice,
        scoreAirline,
        scoreArrivalSchedule,
        scoreStops,
        scoreCabin,
        scoreDepartureSchedule,
        scoreBaggage,
        scoreDuration,
      ];

      const sum =
        scorePrice.contribution +
        scoreAirline.contribution +
        scoreArrivalSchedule.contribution +
        scoreStops.contribution +
        scoreCabin.contribution +
        scoreDepartureSchedule.contribution +
        scoreBaggage.contribution +
        scoreDuration.contribution;
      const score = clamp(roundHalfAwayFromZero(round6(sum * 100)), 0, 100);
      const matchLevel = getMatchLevel(score);

      scoredOffers[i] = {
        offer,
        matchResult: {
          eligibility: ELIGIBLE_RESULT,
          score,
          matchLevel,
          breakdown,
          metadata,
        },
      };
    }

    scoredOffers.sort((a, b) => {
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

    return scoredOffers;
  }

  computeContribution(subScore: number, effectiveWeight: number): number {
    return round6(subScore * effectiveWeight);
  }

  computeFinalScore(breakdown: readonly DimensionScore[]): number {
    let sum = 0;
    for (let i = 0; i < breakdown.length; i++) {
      sum += breakdown[i].contribution;
    }
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
    precomputedMultiplier?: number,
  ): DimensionScore {
    const mult = precomputedMultiplier ?? getPriceSensitivityMultiplier(preferences.priceSensitivity);
    const denom = Math.max(medianPrice, 0.01);
    const diffRatio = (medianPrice - offer.price) / denom;
    const score = round6(
      clamp(
        0.5 + 0.5 * mult * diffRatio,
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
          percentDiff: round6(diffRatio * 100) || 0,
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
      (preferences.preferredAirlines && preferences.preferredAirlines.length > 0
        ? new Set(normalizeAirlineCodes(preferences.preferredAirlines))
        : EMPTY_SET);
    if (preferredSet.size > 0) {
      const offerCarriers = normalizeAirlineCodes(offer.carrierCodes ?? []);
      for (let i = 0; i < offerCarriers.length; i++) {
        const carrier = offerCarriers[i];
        if (preferredSet.has(carrier)) {
          const score = 1.0;
          return {
            dimension: 'AIRLINE',
            score,
            weight: effectiveWeight,
            contribution: this.computeContribution(score, effectiveWeight),
            signal: 'POSITIVE',
            explanation: {
              key: 'match.airline.preferred',
              params: { airline: carrier },
            },
          };
        }
      }
    }

    const score = 0.5;
    return {
      dimension: 'AIRLINE',
      score,
      weight: effectiveWeight,
      contribution: this.computeContribution(score, effectiveWeight),
      signal: 'NEUTRAL',
      explanation: {
        key: 'match.airline.neutral',
        params: EMPTY_OBJECT,
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
    const score = subScore;

    return {
      dimension: 'CABIN',
      score,
      weight: effectiveWeight,
      contribution: this.computeContribution(score, effectiveWeight),
      signal: score === 1.0 ? 'POSITIVE' : score === 0.5 ? 'NEUTRAL' : 'NEGATIVE',
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

    const score = subScore;
    return {
      dimension: 'BAGGAGE',
      score,
      weight: effectiveWeight,
      contribution: this.computeContribution(score, effectiveWeight),
      signal: score === 1.0 ? 'POSITIVE' : score === 0.5 ? 'NEUTRAL' : 'NEGATIVE',
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
    const formattedTime = formatHour(hour);

    if (!window) {
      const score = 0.5;
      return {
        dimension,
        score,
        weight: effectiveWeight,
        contribution: this.computeContribution(score, effectiveWeight),
        signal: 'NEUTRAL',
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
        params: EMPTY_OBJECT,
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

  const len = codes.length;
  if (len === 1 && typeof codes[0] === 'string') {
    const normalizedCode = codes[0].trim().toUpperCase();
    const normalizedCodes = AIRLINE_CODE_PATTERN.test(normalizedCode) ? [normalizedCode] : [];
    NORMALIZED_AIRLINE_CODES.set(codes, normalizedCodes);
    return normalizedCodes;
  }

  const result: string[] = [];
  for (let i = 0; i < len; i++) {
    const code = codes[i];
    if (typeof code !== 'string') {
      continue;
    }

    const normalizedCode = code.trim().toUpperCase();
    if (AIRLINE_CODE_PATTERN.test(normalizedCode)) {
      if (!result.includes(normalizedCode)) {
        result.push(normalizedCode);
      }
    }
  }

  NORMALIZED_AIRLINE_CODES.set(codes, result);
  return result;
}

function hasPreferredAirline(
  carrierCodes: readonly unknown[] | undefined,
  preferredSet: ReadonlySet<string>,
): boolean {
  if (!carrierCodes || carrierCodes.length === 0 || preferredSet.size === 0) return false;
  const normalized = normalizeAirlineCodes(carrierCodes);
  for (let i = 0; i < normalized.length; i++) {
    if (preferredSet.has(normalized[i])) return true;
  }
  return false;
}

function calcScheduleScore(hour: number, window: HourWindow): number {
  if (isHourInWindow(hour, window)) return 1.0;
  const dist = hourDistanceToWindow(hour, window);
  return round6(clamp(1 - dist / SCHEDULE_SHOULDER_HOURS, 0, 1));
}

function calcBaggageScore(
  hasCheckedBaggage: boolean | null | undefined,
  req: boolean | null | undefined,
): number {
  if (req === true) return hasCheckedBaggage === true ? 1.0 : 0.0;
  if (req === false) return 1.0;
  return 0.5;
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
