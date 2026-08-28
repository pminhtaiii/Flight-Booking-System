import { z } from 'zod';

const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const DashboardBookingStatusEnum = z.enum([
  'PROCESSING',
  'CONFIRMED',
  'FAILED',
  'COMPLETED',
  'CANCELLATION_PENDING',
  'CANCELLED_PENDING_REFUND',
  'CANCELLED_AND_REFUNDED',
  'CANCELLED_NO_REFUND',
  'REFUND_FAILED_NEEDS_ATTENTION',
]);
export type DashboardBookingStatus = z.infer<typeof DashboardBookingStatusEnum>;

export const DashboardStatsSchema = z
  .object({
    totalBookings: z.number().int().nonnegative(),
    upcomingBookings: z.number().int().nonnegative(),
    completedBookings: z.number().int().nonnegative(),
    cancelledBookings: z.number().int().nonnegative(),
  })
  .strict();
export type DashboardStats = z.infer<typeof DashboardStatsSchema>;

export const DashboardRecentBookingSchema = z
  .object({
    id: z.string().uuid(),
    status: DashboardBookingStatusEnum,
    createdAt: IsoDateTimeSchema,
    departureAt: IsoDateTimeSchema.nullable(),
    originCode: z.string().nullable(),
    destinationCode: z.string().nullable(),
    airlineCode: z.string().nullable(),
    flightNumber: z.string().nullable(),
  })
  .strict();
export type DashboardRecentBooking = z.infer<typeof DashboardRecentBookingSchema>;

export const DashboardSummarySchema = z
  .object({
    stats: DashboardStatsSchema,
    recentBookings: z.array(DashboardRecentBookingSchema).max(5),
    generatedAt: IsoDateTimeSchema,
  })
  .strict();
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

export const DashboardFailureReasonEnum = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'UPSTREAM_UNAVAILABLE',
  'INVALID_RESPONSE',
]);
export type DashboardFailureReason = z.infer<typeof DashboardFailureReasonEnum>;

export const DashboardOutcomeSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      data: DashboardSummarySchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: DashboardFailureReasonEnum,
      message: z.string().min(1),
      retryable: z.boolean(),
    })
    .strict(),
]);
export type DashboardOutcome = z.infer<typeof DashboardOutcomeSchema>;
