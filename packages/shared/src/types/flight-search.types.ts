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

/** Safe, key-specific explanation with primitive display parameters. */
export const ExplanationSchema = z
  .object({
    key: z.string().min(1),
    params: z.record(z.union([z.string(), z.number(), z.boolean()])),
  })
  .strict();

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

/** Metadata recording scoring policy version and active effective weights. */
export const FlightMatchMetadataSchema = z
  .object({
    scoringVersion: z.literal('flight-match-v1'),
    activeWeights: z.record(FlightMatchDimensionSchema, z.number().min(0).max(1)),
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
  .strict();

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
