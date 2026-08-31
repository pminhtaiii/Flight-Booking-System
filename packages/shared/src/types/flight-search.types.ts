import { z } from 'zod';

const IataCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Expected a three-letter uppercase IATA code');
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)');

const isCurrentOrFutureCalendarDate = (value: string): boolean => {
  const parsedDate = new Date(`${value}T00:00:00Z`);
  const [year, month, day] = value.split('-').map(Number);
  const isCalendarDate =
    parsedDate.getUTCFullYear() === year &&
    parsedDate.getUTCMonth() === month - 1 &&
    parsedDate.getUTCDate() === day;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  return isCalendarDate && parsedDate >= today;
};

/** Validated criteria accepted by the flight-search server seam. */
export const FlightSearchQuerySchema = z
  .object({
    origin: IataCodeSchema,
    destination: IataCodeSchema,
    departureDate: IsoDateSchema,
    returnDate: IsoDateSchema.nullable(),
    adults: z.number().int().min(1).max(9),
    children: z.number().int().min(0).max(8),
    infants: z.number().int().min(0).max(8),
    cabinClass: z.enum(['economy', 'premium_economy', 'business', 'first']),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.origin === query.destination) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: 'Origin and destination must be different',
      });
    }
    if (!isCurrentOrFutureCalendarDate(query.departureDate)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['departureDate'],
        message: 'Departure date must be today or later',
      });
    }
    if (query.returnDate && !isCurrentOrFutureCalendarDate(query.returnDate)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['returnDate'],
        message: 'Return date must be today or later',
      });
    }
    if (query.returnDate && query.returnDate < query.departureDate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['returnDate'],
        message: 'Return date must be on or after departure date',
      });
    }
    if (query.adults + query.children + query.infants > 9) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adults'],
        message: 'Maximum 9 passengers per search',
      });
    }
    if (query.infants > query.adults) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['infants'],
        message: 'Number of infants cannot exceed number of adults',
      });
    }
  });

export type FlightSearchQuery = z.infer<typeof FlightSearchQuerySchema>;

/** Eight fixed dimensions evaluated during deterministic flight matching. */
export const FlightMatchDimensionSchema = z.enum([
  'PRICE',
  'AIRLINE',
  'ARRIVAL_SCHEDULE',
  'STOPS',
  'CABIN',
  'DEPARTURE_SCHEDULE',
  'BAGGAGE',
  'DURATION',
]);

export type FlightMatchDimension = z.infer<typeof FlightMatchDimensionSchema>;

/** Three-tier signal derived from rounded sub-score thresholds. */
export const DimensionSignalSchema = z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']);

export type DimensionSignal = z.infer<typeof DimensionSignalSchema>;

/** Four discrete match levels based on final score brackets. */
export const MatchLevelSchema = z.enum(['STRONG', 'GOOD', 'FAIR', 'WEAK']);

export type MatchLevel = z.infer<typeof MatchLevelSchema>;

/** Helper correlating a rounded 0..100 score to its canonical match level bracket. */
export const getExpectedMatchLevel = (score: number): MatchLevel => {
  if (score >= 75) return 'STRONG';
  if (score >= 50) return 'GOOD';
  if (score >= 25) return 'FAIR';
  return 'WEAK';
};

/** All 24 allowlisted explanation keys across scoring policy dimensions and constraints. */
export const ExplanationKeySchema = z.enum([
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

export type ExplanationKey = z.infer<typeof ExplanationKeySchema>;

const PriceExplanationParamsSchema = z
  .object({
    difference: z.union([z.string(), z.number()]).optional(),
    percentDiff: z.number().optional(),
    percentBelow: z.number().optional(),
    currency: z.string().optional(),
    isBest: z.boolean().optional(),
  })
  .strict();

const AirlineExplanationParamsSchema = z
  .object({
    airline: z.string().optional(),
  })
  .strict();

const ScheduleExplanationParamsSchema = z
  .object({
    time: z.string().optional(),
    windowStart: z.union([z.string(), z.number()]).optional(),
    windowEnd: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const StopsExplanationParamsSchema = z
  .object({
    actual: z.number().optional(),
    preferred: z.number().optional(),
    stops: z.number().optional(),
    maxStops: z.number().optional(),
    minStops: z.number().optional(),
  })
  .strict();

const CabinExplanationParamsSchema = z
  .object({
    expected: z.string().optional(),
    actual: z.string().optional(),
    cabin: z.string().optional(),
  })
  .strict();

const BaggageExplanationParamsSchema = z
  .object({
    checkedBags: z.number().optional(),
    required: z.boolean().optional(),
  })
  .strict();

const DurationExplanationParamsSchema = z
  .object({
    difference: z.union([z.string(), z.number()]).optional(),
    percentDiff: z.number().optional(),
    percentBelow: z.number().optional(),
    minutes: z.number().optional(),
  })
  .strict();

const BlacklistedAirlineExplanationParamsSchema = z
  .object({
    airline: z.string().optional(),
  })
  .strict();

/** Safe, key-specific explanation with primitive display parameters. */
export const ExplanationSchema = z.discriminatedUnion('key', [
  z
    .object({
      key: z.literal('match.price.below_median'),
      params: PriceExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.price.at_median'),
      params: PriceExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.price.above_median'),
      params: PriceExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.airline.preferred'),
      params: AirlineExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.airline.neutral'),
      params: AirlineExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.arrival.in_window'),
      params: ScheduleExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.arrival.near_window'),
      params: ScheduleExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.arrival.outside_window'),
      params: ScheduleExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.stops.within_preference'),
      params: StopsExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.stops.exceeds_preference'),
      params: StopsExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.stops.relative'),
      params: StopsExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.cabin.exact'),
      params: CabinExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.cabin.adjacent'),
      params: CabinExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.cabin.mismatch'),
      params: CabinExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.departure.in_window'),
      params: ScheduleExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.departure.near_window'),
      params: ScheduleExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.departure.outside_window'),
      params: ScheduleExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.baggage.checked_included'),
      params: BaggageExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.baggage.checked_missing'),
      params: BaggageExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.baggage.not_required'),
      params: BaggageExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.duration.below_median'),
      params: DurationExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.duration.at_median'),
      params: DurationExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('match.duration.above_median'),
      params: DurationExplanationParamsSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('constraint.airline.blacklisted'),
      params: BlacklistedAirlineExplanationParamsSchema,
    })
    .strict(),
]);

export type Explanation = z.infer<typeof ExplanationSchema>;

/** Granular breakdown score and explanation for an individual dimension. */
export const DimensionScoreSchema = z
  .object({
    dimension: FlightMatchDimensionSchema,
    score: z.number().min(0).max(1),
    weight: z.number().min(0).max(1),
    contribution: z.number().min(0).max(1),
    signal: DimensionSignalSchema,
    explanation: ExplanationSchema,
  })
  .strict();

export type DimensionScore = z.infer<typeof DimensionScoreSchema>;

/** Allowlisted constraint violation types. */
export const ConstraintTypeSchema = z.enum(['BLACKLISTED_AIRLINE']);

export type ConstraintType = z.infer<typeof ConstraintTypeSchema>;

/** Specific constraint violation blocking match eligibility. */
export const ConstraintViolationSchema = z
  .object({
    constraint: ConstraintTypeSchema,
    explanation: ExplanationSchema,
  })
  .strict();

export type ConstraintViolation = z.infer<typeof ConstraintViolationSchema>;

/** Active weights across all 8 match dimensions normalized to sum to 1.000000. */
export const ActiveWeightsSchema = z
  .object({
    PRICE: z.number().min(0).max(1),
    AIRLINE: z.number().min(0).max(1),
    ARRIVAL_SCHEDULE: z.number().min(0).max(1),
    STOPS: z.number().min(0).max(1),
    CABIN: z.number().min(0).max(1),
    DEPARTURE_SCHEDULE: z.number().min(0).max(1),
    BAGGAGE: z.number().min(0).max(1),
    DURATION: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((weights, context) => {
    const sum =
      weights.PRICE +
      weights.AIRLINE +
      weights.ARRIVAL_SCHEDULE +
      weights.STOPS +
      weights.CABIN +
      weights.DEPARTURE_SCHEDULE +
      weights.BAGGAGE +
      weights.DURATION;
    const roundedSum = Math.round(sum * 1_000_000) / 1_000_000;
    if (roundedSum !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `Active weights must sum to 1.000000, received ${roundedSum}`,
      });
    }
  });

export type ActiveWeights = z.infer<typeof ActiveWeightsSchema>;

/** Metadata recording scoring policy version and active effective weights. */
export const FlightMatchMetadataSchema = z
  .object({
    scoringVersion: z.literal('flight-match-v1'),
    activeWeights: ActiveWeightsSchema,
  })
  .strict();

export type FlightMatchMetadata = z.infer<typeof FlightMatchMetadataSchema>;

/** Result payload for an eligible offer meeting all hard constraints. */
export const EligibleFlightMatchResultSchema = z
  .object({
    eligibility: z
      .object({
        eligible: z.literal(true),
        violations: z.array(ConstraintViolationSchema).max(0),
      })
      .strict(),
    score: z.number().int().min(0).max(100),
    matchLevel: MatchLevelSchema,
    breakdown: z.array(DimensionScoreSchema),
    metadata: FlightMatchMetadataSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const expected = getExpectedMatchLevel(result.score);
    if (result.matchLevel !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['matchLevel'],
        message: `matchLevel "${result.matchLevel}" does not match expected level "${expected}" for score ${result.score}`,
      });
    }
  });

export type EligibleFlightMatchResult = z.infer<typeof EligibleFlightMatchResultSchema>;

/** Result payload for an offer violating at least one hard constraint. */
export const IneligibleFlightMatchResultSchema = z
  .object({
    eligibility: z
      .object({
        eligible: z.literal(false),
        violations: z.array(ConstraintViolationSchema).min(1),
      })
      .strict(),
    score: z.null(),
    matchLevel: z.null(),
    breakdown: z.array(DimensionScoreSchema).max(0),
    metadata: FlightMatchMetadataSchema,
  })
  .strict();

export type IneligibleFlightMatchResult = z.infer<typeof IneligibleFlightMatchResultSchema>;

/** Union of eligible and ineligible match result shapes. */
export const FlightMatchResultSchema = z.union([
  EligibleFlightMatchResultSchema,
  IneligibleFlightMatchResultSchema,
]);

export type FlightMatchResult = z.infer<typeof FlightMatchResultSchema>;

/** A sanitized segment; deliberately contains no provider identifier. */
export const FlightSearchSegmentViewSchema = z
  .object({
    airline: z.string(),
    flightNumber: z.string(),
    origin: z.string(),
    destination: z.string(),
    departureAt: z.string(),
    arrivalAt: z.string(),
    duration: z.string().min(1),
    cabinClass: z.enum(['economy', 'premium_economy', 'business', 'first']),
  })
  .strict();

export type FlightSearchSegmentView = z.infer<typeof FlightSearchSegmentViewSchema>;

/** A one-way slice of a rendered offer. */
export const FlightSearchSliceViewSchema = z
  .object({
    origin: z.string(),
    destination: z.string(),
    departureAt: z.string(),
    arrivalAt: z.string(),
    duration: z.string().min(1),
    stops: z.number().int().min(0),
    segments: z.array(FlightSearchSegmentViewSchema).min(1),
  })
  .strict();

export type FlightSearchSliceView = z.infer<typeof FlightSearchSliceViewSchema>;

/** Browser-safe offer data. `id` is a local opaque identifier, never a provider offer ID. */
export const FlightSearchOfferViewSchema = z
  .object({
    id: z.string().min(1),
    price: z.number().finite().min(0),
    currency: z.string().regex(/^[A-Z]{3}$/, 'Expected a three-letter uppercase currency code'),
    airline: z.string(),
    flightNumber: z.string(),
    origin: z.string(),
    destination: z.string(),
    departureAt: z.string(),
    arrivalAt: z.string(),
    duration: z.string().min(1),
    stops: z.number().int().min(0),
    slices: z.array(FlightSearchSliceViewSchema).min(1),
    matchResult: FlightMatchResultSchema.nullable().optional(),
  })
  .strict();

export type FlightSearchOfferView = z.infer<typeof FlightSearchOfferViewSchema>;

export const FlightSearchMatchLevelCountsSchema = z
  .object({
    STRONG: z.number().int().min(0),
    GOOD: z.number().int().min(0),
    FAIR: z.number().int().min(0),
    WEAK: z.number().int().min(0),
  })
  .strict();

export type FlightSearchMatchLevelCounts = z.infer<typeof FlightSearchMatchLevelCountsSchema>;

export const FlightSearchMetaSchema = z
  .object({
    totalCount: z.number().int().min(0),
    currency: z.string().regex(/^[A-Z]{3}$/, 'Expected a three-letter uppercase currency code'),
    minPrice: z.number().finite().min(0).nullable(),
    maxPrice: z.number().finite().min(0).nullable(),
    airlines: z.array(z.string().min(1)),
    scoringVersion: z.string().min(1).nullable().optional(),
    eligibleCount: z.number().int().min(0).optional(),
    matchLevelCounts: FlightSearchMatchLevelCountsSchema.optional(),
  })
  .strict();

export type FlightSearchMeta = z.infer<typeof FlightSearchMetaSchema>;

const FlightSearchFailureSchema = z
  .object({
    ok: z.literal(false),
    reason: z.enum(['UNAUTHENTICATED', 'INVALID_SEARCH', 'RATE_LIMITED', 'UPSTREAM_UNAVAILABLE']),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export const FlightSearchSuccessOutcomeSchema = z
  .object({
    ok: z.literal(true),
    mode: z.enum(['MATCHED', 'RANKED']).optional(),
    offers: z.array(FlightSearchOfferViewSchema),
    meta: FlightSearchMetaSchema,
  })
  .strict();

export type FlightSearchSuccessOutcome = z.infer<typeof FlightSearchSuccessOutcomeSchema>;

export const FlightSearchOutcomeSchema = z.discriminatedUnion('ok', [
  FlightSearchSuccessOutcomeSchema,
  FlightSearchFailureSchema,
]);

export type FlightSearchOutcome = z.infer<typeof FlightSearchOutcomeSchema>;

const FlightSelectionFailureSchema = z
  .object({
    ok: z.literal(false),
    reason: z.enum(['OFFER_EXPIRED', 'OFFER_UNAVAILABLE', 'UNAUTHENTICATED']),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export const FlightSelectionOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), checkoutPath: z.string().min(1) }).strict(),
  FlightSelectionFailureSchema,
]);

export type FlightSelectionOutcome = z.infer<typeof FlightSelectionOutcomeSchema>;
