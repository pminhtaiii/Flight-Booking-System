import 'server-only';
import { z } from 'zod';
import {
  FlightMatchResultSchema,
  FlightSearchMatchLevelCountsSchema,
  FlightSearchOfferViewSchema,
  FlightSearchQuerySchema,
  type DimensionScore,
  type FlightSearchMeta,
  type FlightSearchOutcome,
  type FlightSearchOfferView,
  type FlightSearchQuery,
  type FlightSearchSegmentView,
  type FlightSearchSliceView,
  type FlightSelectionOutcome,
} from '@shared/types/flight-search.types';
import { backendClient } from './backend-client';

const CabinClassSchema = z.enum(['economy', 'premium_economy', 'business', 'first']);
const LocalOfferIdSchema = z
  .string()
  .min(1)
  .refine(
    (value: string): boolean => !value.toLowerCase().startsWith('off_'),
    'Provider offer identifiers are not allowed',
  );

const UpstreamSegmentSchema = z
  .object({
    carrierCode: z.string(),
    flightNumber: z.string(),
    operatingCarrier: z.string(),
    departureAirport: z.string(),
    departureTerminal: z.string().nullable(),
    departureTime: z.string(),
    arrivalAirport: z.string(),
    arrivalTerminal: z.string().nullable(),
    arrivalTime: z.string(),
    duration: z.number().int().min(0),
    aircraft: z.string().nullable(),
    cabinClass: CabinClassSchema,
  })
  .strict();

const CabinMismatchDetailSchema = z
  .object({
    segmentIndex: z.number().int().min(0),
    leg: z.enum(['outbound', 'return']),
    expected: z.string(),
    actual: z.string(),
    route: z.string(),
  })
  .strict();

const UpstreamOfferBaseSchema = z
  .object({
    id: LocalOfferIdSchema,
    duffelOfferId: z.string().min(1),
    airline: z.string(),
    flightNumber: z.string(),
    departureAirport: z.string(),
    arrivalAirport: z.string(),
    departureTime: z.string(),
    arrivalTime: z.string(),
    duration: z.number().int().min(0),
    stops: z.number().int().min(0),
    price: z.number().finite().min(0),
    currency: z.string().regex(/^[A-Z]{3}$/),
    fareClass: z.string().nullable(),
    baggageAllowance: z.string().nullable(),
    requestedCabinClass: CabinClassSchema,
    cabinClassMatch: z.enum(['full', 'mixed', 'downgraded']),
    cabinMismatchDetails: z.array(CabinMismatchDetailSchema).nullable(),
    segments: z.array(UpstreamSegmentSchema).min(1),
    returnSegments: z.array(UpstreamSegmentSchema).min(1).nullable(),
  })
  .strict();

const UpstreamMatchedOfferSchema = UpstreamOfferBaseSchema.extend({
  matchResult: FlightMatchResultSchema,
}).strict();

const UpstreamRankedOfferSchema = UpstreamOfferBaseSchema.extend({
  matchResult: z.null(),
}).strict();

const UpstreamSearchMetaBaseSchema = z
  .object({
    totalResults: z.number().int().min(0),
    searchHash: z.string(),
    cached: z.boolean(),
    requestedCabinClass: z.string(),
  })
  .strict();

const UpstreamMatchedSearchSchema = z
  .object({
    mode: z.literal('MATCHED'),
    results: z.array(UpstreamMatchedOfferSchema).max(20),
    meta: UpstreamSearchMetaBaseSchema.extend({
      scoringVersion: z.literal('flight-match-v1'),
      eligibleCount: z.number().int().min(0),
      matchLevelCounts: FlightSearchMatchLevelCountsSchema,
    }).strict(),
  })
  .strict();

const UpstreamRankedSearchSchema = z
  .object({
    mode: z.literal('RANKED'),
    results: z.array(UpstreamRankedOfferSchema).max(20),
    meta: UpstreamSearchMetaBaseSchema.extend({ scoringVersion: z.null() }).strict(),
  })
  .strict();

const UpstreamSearchBaseSchema = z.discriminatedUnion('mode', [
  UpstreamMatchedSearchSchema,
  UpstreamRankedSearchSchema,
]);
const UpstreamSearchSchema = UpstreamSearchBaseSchema.superRefine(
  validateMatchedSearchCardinality,
);
const UpstreamSelectionSchema = z.object({ id: LocalOfferIdSchema }).passthrough();

type UpstreamOffer =
  | z.infer<typeof UpstreamMatchedOfferSchema>
  | z.infer<typeof UpstreamRankedOfferSchema>;
type UpstreamSegment = z.infer<typeof UpstreamSegmentSchema>;

function validateMatchedSearchCardinality(
  response: z.infer<typeof UpstreamSearchBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (response.mode !== 'MATCHED') return;

  let eligibleCount = 0;
  const matchLevelCounts = { STRONG: 0, GOOD: 0, FAIR: 0, WEAK: 0 };
  for (let index = 0; index < response.results.length; index += 1) {
    const offer = response.results[index];
    if (offer.matchResult.eligibility.eligible) {
      eligibleCount += 1;
      if (offer.matchResult.matchLevel !== null) {
        matchLevelCounts[offer.matchResult.matchLevel] += 1;
      }

      if (offer.matchResult.breakdown.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['results', index, 'matchResult', 'breakdown'],
          message: 'breakdown must not be empty for eligible match result',
        });
      } else {
        const sum = offer.matchResult.breakdown.reduce(
          (total: number, item: DimensionScore): number => total + item.weight,
          0,
        );
        const roundedSum = Math.round(sum * 1_000_000) / 1_000_000;
        if (roundedSum !== 1) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['results', index, 'matchResult', 'breakdown'],
            message: `Active breakdown weights must sum to 1.000000, received ${roundedSum}`,
          });
        }
      }
    }
  }

  if (response.meta.eligibleCount !== eligibleCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['meta', 'eligibleCount'],
      message: `eligibleCount must equal ${eligibleCount}`,
    });
  }

  const matchLevels: Array<keyof typeof matchLevelCounts> = ['STRONG', 'GOOD', 'FAIR', 'WEAK'];
  for (const matchLevel of matchLevels) {
    if (response.meta.matchLevelCounts[matchLevel] !== matchLevelCounts[matchLevel]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'matchLevelCounts', matchLevel],
        message: `${matchLevel} count must equal ${matchLevelCounts[matchLevel]}`,
      });
    }
  }
}

export async function searchFlights(query: FlightSearchQuery): Promise<FlightSearchOutcome> {
  const parsedQuery = FlightSearchQuerySchema.safeParse(query);
  if (!parsedQuery.success) {
    return searchFailure(
      'INVALID_SEARCH',
      'Please check your search details and try again.',
      false,
    );
  }

  const result = await backendClient.request('/api/flights/search', UpstreamSearchSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsedQuery.data),
  });

  if (result.ok) {
    const offers = result.data.results.map(
      (offer: UpstreamOffer): FlightSearchOfferView => mapOffer(offer),
    );
    const validatedOffers = z.array(FlightSearchOfferViewSchema).safeParse(offers);
    if (!validatedOffers.success) {
      return searchFailure(
        'UPSTREAM_UNAVAILABLE',
        'Flight search returned an invalid response. Please try again.',
        true,
      );
    }

    return {
      ok: true,
      mode: result.data.mode,
      offers: validatedOffers.data,
      meta: createSearchMeta(validatedOffers.data, result.data.meta),
    };
  }

  if (result.kind === 'http') {
    if (result.status === 401 || result.status === 403) {
      return searchFailure('UNAUTHENTICATED', 'Please sign in to search for flights.', false);
    }
    if (result.status === 429) {
      return searchFailure('RATE_LIMITED', 'Flight search is busy. Please try again shortly.', true);
    }
    if (result.status === 400 || result.status === 422) {
      return searchFailure(
        'INVALID_SEARCH',
        'Please check your search details and try again.',
        false,
      );
    }
    return unavailableSearchFailure();
  }

  if (result.kind === 'transport') {
    if (result.cause === 'missing_token') {
      return searchFailure('UNAUTHENTICATED', 'Please sign in to search for flights.', false);
    }
    if (result.cause === 'invalid_json' || result.cause === 'invalid_payload') {
      return searchFailure(
        'UPSTREAM_UNAVAILABLE',
        'Flight search returned an invalid response. Please try again.',
        true,
      );
    }
    return unavailableSearchFailure();
  }

  return unavailableSearchFailure();
}

export async function selectFlightOffer(offerId: string): Promise<FlightSelectionOutcome> {
  const parsedOfferId = LocalOfferIdSchema.safeParse(offerId);
  if (!parsedOfferId.success) {
    return selectionFailure(
      'OFFER_UNAVAILABLE',
      'This flight offer is unavailable. Please search again.',
      false,
    );
  }

  const result = await backendClient.request(
    `/api/flights/${encodeURIComponent(parsedOfferId.data)}`,
    UpstreamSelectionSchema,
    { method: 'GET' },
  );

  if (result.ok) {
    if (result.data.id !== parsedOfferId.data) {
      return unavailableSelectionFailure();
    }
    return {
      ok: true,
      checkoutPath: `/checkout?offerId=${encodeURIComponent(parsedOfferId.data)}`,
    };
  }

  if (result.kind === 'http') {
    if (result.status === 401 || result.status === 403) {
      return selectionFailure('UNAUTHENTICATED', 'Please sign in to continue.', false);
    }
    if (result.status === 404 || result.status === 410) {
      return selectionFailure(
        'OFFER_EXPIRED',
        'This flight offer has expired. Please search again.',
        false,
      );
    }
    return unavailableSelectionFailure();
  }

  if (result.kind === 'transport') {
    if (result.cause === 'missing_token') {
      return selectionFailure('UNAUTHENTICATED', 'Please sign in to continue.', false);
    }
    return unavailableSelectionFailure();
  }

  return unavailableSelectionFailure();
}

function mapOffer(offer: UpstreamOffer): FlightSearchOfferView {
  return {
    id: offer.id,
    price: offer.price,
    currency: offer.currency,
    airline: offer.airline,
    flightNumber: offer.flightNumber,
    origin: offer.departureAirport,
    destination: offer.arrivalAirport,
    departureAt: offer.departureTime,
    arrivalAt: offer.arrivalTime,
    duration: duration(offer.duration),
    stops: offer.stops,
    slices: [
      mapSlice(offer.segments, offer.duration, offer.stops),
      ...(offer.returnSegments ? [mapSlice(offer.returnSegments)] : []),
    ],
    matchResult: offer.matchResult ?? null,
  };
}

function mapSlice(
  segments: UpstreamSegment[],
  totalMinutes?: number,
  stops?: number,
): FlightSearchSliceView {
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  return {
    origin: firstSegment.departureAirport,
    destination: lastSegment.arrivalAirport,
    departureAt: firstSegment.departureTime,
    arrivalAt: lastSegment.arrivalTime,
    duration: duration(
      totalMinutes ??
        segments.reduce(
          (sum: number, segment: UpstreamSegment): number => sum + segment.duration,
          0,
        ),
    ),
    stops: stops ?? Math.max(segments.length - 1, 0),
    segments: segments.map(
      (segment: UpstreamSegment): FlightSearchSegmentView => mapSegment(segment),
    ),
  };
}

function mapSegment(segment: UpstreamSegment): FlightSearchSegmentView {
  return {
    airline: segment.operatingCarrier,
    flightNumber: `${segment.carrierCode}${segment.flightNumber}`,
    origin: segment.departureAirport,
    destination: segment.arrivalAirport,
    departureAt: segment.departureTime,
    arrivalAt: segment.arrivalTime,
    duration: duration(segment.duration),
    cabinClass: segment.cabinClass,
  };
}

function createSearchMeta(
  offers: FlightSearchOfferView[],
  upstreamMeta?: z.infer<typeof UpstreamSearchSchema>['meta'],
): FlightSearchMeta {
  const prices = offers.map((offer: FlightSearchOfferView): number => offer.price);
  const airlines: string[] = [];
  const seenAirlines = new Set<string>();
  offers.forEach((offer: FlightSearchOfferView): void => {
    if (!seenAirlines.has(offer.airline)) {
      seenAirlines.add(offer.airline);
      airlines.push(offer.airline);
    }
  });
  return {
    totalCount: offers.length,
    currency: offers[0]?.currency ?? 'USD',
    minPrice: prices.length === 0 ? null : Math.min(...prices),
    maxPrice: prices.length === 0 ? null : Math.max(...prices),
    airlines,
    ...(upstreamMeta?.scoringVersion !== undefined
      ? { scoringVersion: upstreamMeta.scoringVersion }
      : {}),
    ...(upstreamMeta &&
    'eligibleCount' in upstreamMeta &&
    upstreamMeta.eligibleCount !== undefined
      ? { eligibleCount: upstreamMeta.eligibleCount }
      : {}),
    ...(upstreamMeta &&
    'matchLevelCounts' in upstreamMeta &&
    upstreamMeta.matchLevelCounts !== undefined
      ? { matchLevelCounts: upstreamMeta.matchLevelCounts }
      : {}),
  };
}

function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `PT${hours > 0 ? `${hours}H` : ''}${remainingMinutes > 0 ? `${remainingMinutes}M` : '0M'}`;
}

function searchFailure(
  reason: Extract<FlightSearchOutcome, { ok: false }>['reason'],
  message: string,
  retryable: boolean,
): FlightSearchOutcome {
  return { ok: false, reason, message, retryable };
}

function unavailableSearchFailure(): FlightSearchOutcome {
  return searchFailure(
    'UPSTREAM_UNAVAILABLE',
    'Flight search is temporarily unavailable. Please try again.',
    true,
  );
}

function selectionFailure(
  reason: Extract<FlightSelectionOutcome, { ok: false }>['reason'],
  message: string,
  retryable: boolean,
): FlightSelectionOutcome {
  return { ok: false, reason, message, retryable };
}

function unavailableSelectionFailure(): FlightSelectionOutcome {
  return selectionFailure(
    'OFFER_UNAVAILABLE',
    'This flight offer is unavailable. Please search again.',
    true,
  );
}
