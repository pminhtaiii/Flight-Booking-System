import { z } from 'zod';

/**
 * Browser-safe booking-management views.  These deliberately model only
 * owner-facing facts; provider order IDs, payment IDs, and provider payloads
 * must remain behind the server boundary.
 */
const CurrencySchema = z.string().length(3);
// Keep monetary values as decimal strings so the server never introduces
// floating-point rounding while preparing a browser-facing view.
const MoneyAmountSchema = z.string().regex(/^\d+(\.\d{1,2})?$/);
const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const BookingAirlineViewSchema = z
  .object({
    name: z.string().min(1),
    iataCode: z.string().min(1),
    logoUrl: z.string().url().optional(),
  })
  .strict();

export const BookingAirportViewSchema = z
  .object({
    iataCode: z.string().min(1),
    name: z.string().min(1),
    city: z.string().min(1),
    terminal: z.string().min(1).optional(),
    gate: z.string().min(1).optional(),
  })
  .strict();

export const BookingSegmentViewSchema = z
  .object({
    airline: BookingAirlineViewSchema,
    flightNumber: z.string().min(1),
    departureAirport: BookingAirportViewSchema,
    arrivalAirport: BookingAirportViewSchema,
    departureAt: IsoDateTimeSchema,
    arrivalAt: IsoDateTimeSchema,
    duration: z.string().min(1),
    aircraftType: z.string().min(1).optional(),
    sliceOrder: z.number().int().nonnegative().optional(),
    segmentOrder: z.number().int().nonnegative().optional(),
    globalOrder: z.number().int().nonnegative().optional(),
  })
  .strict();

export const BookingItineraryViewSchema = z
  .object({
    source: z.enum(['ORIGINAL', 'REVISION']),
    revisionId: z.string().min(1).nullable().optional(),
    version: z.number().int().min(1),
    segments: z.array(BookingSegmentViewSchema),
    nextUnflownDepartureAt: IsoDateTimeSchema.nullable().optional(),
    finalArrivalAt: IsoDateTimeSchema.nullable().optional(),
    totalDuration: z.string().min(1).optional(),
    stops: z.number().int().nonnegative().optional(),
    cabinClass: z.string().min(1).optional(),
    fareClass: z.string().min(1).nullable().optional(),
    baggageAllowance: z.string().min(1).nullable().optional(),
  })
  .strict();

export const DisruptionAlertViewSchema = z
  .object({
    status: z.string().min(1),
    activeRevisionId: z.string().min(1).nullable().optional(),
    isMaterial: z.boolean(),
    materialReasons: z.array(z.string().min(1)),
    incrementalSummary: z.record(z.unknown()).nullable().optional(),
    cumulativeSummary: z.record(z.unknown()).nullable().optional(),
    stabilizationWarning: z.boolean(),
    resolvedReason: z.string().min(1).nullable().optional(),
    resolvedAt: IsoDateTimeSchema.nullable().optional(),
  })
  .strict();

const BookingListAirportViewSchema = z
  .object({
    iataCode: z.string().min(1),
    city: z.string().min(1),
  })
  .strict();

export const BookingListItemViewSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    failureReason: z.string().min(1).nullable().optional(),
    paymentStatus: z.string().min(1).nullable().optional(),
    pnrReference: z.string().min(1).nullable().optional(),
    totalAmount: MoneyAmountSchema,
    currency: CurrencySchema,
    departureAt: IsoDateTimeSchema.nullable().optional(),
    arrivalAt: IsoDateTimeSchema.nullable().optional(),
    airline: BookingAirlineViewSchema.optional(),
    origin: BookingListAirportViewSchema.optional(),
    destination: BookingListAirportViewSchema.optional(),
    disruption: DisruptionAlertViewSchema.optional(),
  })
  .strict();

export const BookingListViewSchema = z
  .object({
    bookings: z.array(BookingListItemViewSchema),
    tab: z.enum(['upcoming', 'past']),
    pagination: z
      .object({
        page: z.number().int().min(1),
        limit: z.number().int().min(1),
        total: z.number().int().nonnegative(),
        totalPages: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const PassengerViewSchema = z
  .object({
    type: z.string().min(1),
    title: z.string().min(1).optional(),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
  })
  .strict();

const AncillarySummaryViewSchema = z
  .object({
    seats: z.array(
      z
        .object({
          passengerName: z.string().min(1),
          seatDesignator: z.string().min(1),
          amount: MoneyAmountSchema,
          currency: CurrencySchema,
        })
        .strict(),
    ),
    baggage: z.array(
      z
        .object({
          passengerName: z.string().min(1),
          type: z.string().min(1),
          quantity: z.number().int().min(1),
          amount: MoneyAmountSchema,
          currency: CurrencySchema,
        })
        .strict(),
    ),
  })
  .strict();

const BookingCancellationSummaryViewSchema = z
  .object({
    deadline: IsoDateTimeSchema.nullable().optional(),
    refundable: z.boolean().nullable().optional(),
    airlineRefundAmount: z.string().min(1).nullable().optional(),
    customerRefundAmount: z.string().min(1).nullable().optional(),
  })
  .strict();

export const BookingDetailViewSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    failureReason: z.string().min(1).nullable().optional(),
    paymentStatus: z.string().min(1).nullable().optional(),
    offerId: z.string().min(1).nullable().optional(),
    pnrReference: z.string().min(1).nullable().optional(),
    totalAmount: MoneyAmountSchema,
    currency: CurrencySchema,
    departureAt: IsoDateTimeSchema.nullable().optional(),
    arrivalAt: IsoDateTimeSchema.nullable().optional(),
    airline: BookingAirlineViewSchema.optional(),
    origin: BookingListAirportViewSchema.optional(),
    destination: BookingListAirportViewSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    itinerary: BookingItineraryViewSchema,
    passengers: z.array(PassengerViewSchema),
    ancillarySummary: AncillarySummaryViewSchema.optional(),
    cancellation: BookingCancellationSummaryViewSchema.optional(),
    disruption: DisruptionAlertViewSchema.optional(),
  })
  .strict();

export const CancellationStatusViewSchema = z
  .object({
    bookingId: z.string().min(1),
    bookingStatus: z.string().min(1),
    cancellationDeadline: IsoDateTimeSchema.nullable(),
    airlineRefundAmount: z.string().min(1).nullable(),
    customerRefundAmount: z.string().min(1).nullable(),
    refundStatus: z.string().min(1).nullable(),
    nextRetryAt: IsoDateTimeSchema.nullable(),
    escalationMessage: z.string().min(1).nullable(),
  })
  .strict();

export const CancellationQuoteViewSchema = z
  .object({
    bookingId: z.string().min(1),
    quoteId: z.string().min(1),
    refundAmount: MoneyAmountSchema,
    currency: CurrencySchema,
    expiresAt: IsoDateTimeSchema,
    refundable: z.boolean(),
    cancellationDeadline: IsoDateTimeSchema.nullable().optional(),
    refundTo: z.string().min(1).nullable().optional(),
    nonRefundableAncillaryAmount: z.string().min(1).nullable().optional(),
    nonRefundableAncillaryCurrency: CurrencySchema.nullable().optional(),
  })
  .strict();

export const CancellationResultViewSchema = z
  .object({
    bookingId: z.string().min(1),
    bookingStatus: z.string().min(1),
    cancellationStatus: z.string().min(1),
    refundStatus: z.string().min(1),
    refundAmount: MoneyAmountSchema,
    nextRetryAt: IsoDateTimeSchema.nullable().optional(),
  })
  .strict();

export const ItineraryRevisionViewSchema = z
  .object({
    revisionId: z.string().min(1),
    version: z.number().int().min(1),
    observedAt: IsoDateTimeSchema,
    isMaterial: z.boolean(),
    materialReasons: z.array(z.string().min(1)),
    segments: z.array(BookingSegmentViewSchema),
  })
  .strict();

const BookingManagementFailureSchema = z
  .object({
    ok: z.literal(false),
    reason: z.enum([
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'STALE_REVISION',
      'INVALID_COMMAND',
      'UPSTREAM_UNAVAILABLE',
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

/** Creates a strict, discriminated outcome schema for a prepared view. */
export const BookingManagementOutcomeSchema = <TSchema extends z.ZodTypeAny>(
  dataSchema: TSchema,
) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    BookingManagementFailureSchema,
  ]);

export type BookingAirlineView = z.infer<typeof BookingAirlineViewSchema>;
export type BookingAirportView = z.infer<typeof BookingAirportViewSchema>;
export type BookingSegmentView = z.infer<typeof BookingSegmentViewSchema>;
export type BookingItineraryView = z.infer<typeof BookingItineraryViewSchema>;
export type DisruptionAlertView = z.infer<typeof DisruptionAlertViewSchema>;
export type BookingListItemView = z.infer<typeof BookingListItemViewSchema>;
export type BookingListView = z.infer<typeof BookingListViewSchema>;
export type BookingDetailView = z.infer<typeof BookingDetailViewSchema>;
export type CancellationStatusView = z.infer<typeof CancellationStatusViewSchema>;
export type CancellationQuoteView = z.infer<typeof CancellationQuoteViewSchema>;
export type CancellationResultView = z.infer<typeof CancellationResultViewSchema>;
export type ItineraryRevisionView = z.infer<typeof ItineraryRevisionViewSchema>;
export type BookingManagementOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason:
        | 'UNAUTHENTICATED'
        | 'FORBIDDEN'
        | 'NOT_FOUND'
        | 'STALE_REVISION'
        | 'INVALID_COMMAND'
        | 'UPSTREAM_UNAVAILABLE';
      message: string;
      retryable: boolean;
    };
