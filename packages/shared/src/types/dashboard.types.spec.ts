import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DashboardBookingStatusEnum,
  DashboardStatsSchema,
  DashboardRecentBookingSchema,
  DashboardSummarySchema,
  DashboardOutcomeSchema,
  type DashboardBookingStatus,
  type DashboardStats,
  type DashboardRecentBooking,
  type DashboardSummary,
  type DashboardOutcome,
} from './dashboard.types';

type Assert<T extends true> = T;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

type ExpectedDashboardBookingStatus =
  | 'PROCESSING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'COMPLETED'
  | 'CANCELLATION_PENDING'
  | 'CANCELLED_PENDING_REFUND'
  | 'CANCELLED_AND_REFUNDED'
  | 'CANCELLED_NO_REFUND'
  | 'REFUND_FAILED_NEEDS_ATTENTION';

type ExpectedDashboardStats = {
  totalBookings: number;
  upcomingBookings: number;
  completedBookings: number;
  cancelledBookings: number;
};

type ExpectedDashboardRecentBooking = {
  id: string;
  status: ExpectedDashboardBookingStatus;
  createdAt: string;
  departureAt: string | null;
  originCode: string | null;
  destinationCode: string | null;
  airlineCode: string | null;
  flightNumber: string | null;
};

type ExpectedDashboardSummary = {
  stats: ExpectedDashboardStats;
  recentBookings: ExpectedDashboardRecentBooking[];
  generatedAt: string;
};

type ExpectedDashboardOutcome =
  | {
      ok: true;
      data: ExpectedDashboardSummary;
    }
  | {
      ok: false;
      reason: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'UPSTREAM_UNAVAILABLE' | 'INVALID_RESPONSE';
      message: string;
      retryable: boolean;
    };

// Static type inference parity assertions
type _BookingStatusParity = Assert<Equal<DashboardBookingStatus, ExpectedDashboardBookingStatus>>;
type _StatsParity = Assert<Equal<DashboardStats, ExpectedDashboardStats>>;
type _RecentBookingParity = Assert<Equal<DashboardRecentBooking, ExpectedDashboardRecentBooking>>;
type _SummaryParity = Assert<Equal<DashboardSummary, ExpectedDashboardSummary>>;
type _OutcomeParity = Assert<Equal<DashboardOutcome, ExpectedDashboardOutcome>>;

void (0 as unknown as _BookingStatusParity);
void (0 as unknown as _StatsParity);
void (0 as unknown as _RecentBookingParity);
void (0 as unknown as _SummaryParity);
void (0 as unknown as _OutcomeParity);

const validStats: DashboardStats = {
  totalBookings: 12,
  upcomingBookings: 3,
  completedBookings: 8,
  cancelledBookings: 1,
};

const populatedBooking: DashboardRecentBooking = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  status: 'CONFIRMED',
  createdAt: '2026-08-29T10:00:00Z',
  departureAt: '2026-09-01T08:00:00Z',
  originCode: 'SGN',
  destinationCode: 'HAN',
  airlineCode: 'VN',
  flightNumber: 'VN123',
};

const nullProjectedBooking: DashboardRecentBooking = {
  id: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  status: 'PROCESSING',
  createdAt: '2026-08-29T10:00:00+07:00',
  departureAt: null,
  originCode: null,
  destinationCode: null,
  airlineCode: null,
  flightNumber: null,
};

const validSummary: DashboardSummary = {
  stats: validStats,
  recentBookings: [populatedBooking, nullProjectedBooking],
  generatedAt: '2026-08-29T10:00:00Z',
};

describe('Dashboard shared contract schemas', () => {
  describe('Valid summary parsing', () => {
    it('parses full valid payload with stats, recent bookings, and generatedAt', () => {
      const parsed = DashboardSummarySchema.parse(validSummary);
      assert.deepEqual(parsed, validSummary);
      assert.equal(parsed.stats.totalBookings, 12);
      assert.equal(parsed.recentBookings.length, 2);
    });

    it('parses empty recent bookings list and zero-value stats', () => {
      const emptySummary: DashboardSummary = {
        stats: {
          totalBookings: 0,
          upcomingBookings: 0,
          completedBookings: 0,
          cancelledBookings: 0,
        },
        recentBookings: [],
        generatedAt: '2026-08-29T12:30:00+07:00',
      };
      const parsed = DashboardSummarySchema.parse(emptySummary);
      assert.deepEqual(parsed, emptySummary);
      assert.equal(parsed.recentBookings.length, 0);
    });
  });

  describe('Strict key enforcement', () => {
    it('rejects extraneous keys on DashboardStatsSchema', () => {
      const extraStats = {
        ...validStats,
        disruptionShield: true,
      };
      assert.throws(() => DashboardStatsSchema.parse(extraStats), /unrecognized_keys/i);

      const extraFieldStats = {
        ...validStats,
        extra: 'not-allowed',
      };
      assert.throws(() => DashboardStatsSchema.parse(extraFieldStats), /unrecognized_keys/i);
    });

    it('rejects extraneous keys on DashboardRecentBookingSchema', () => {
      const extraBooking = {
        ...populatedBooking,
        userId: 'usr-12345',
      };
      assert.throws(() => DashboardRecentBookingSchema.parse(extraBooking), /unrecognized_keys/i);

      const leakBooking = {
        ...populatedBooking,
        rawSnapshot: { test: true },
      };
      assert.throws(() => DashboardRecentBookingSchema.parse(leakBooking), /unrecognized_keys/i);
    });

    it('rejects extraneous keys on DashboardSummarySchema', () => {
      const extraSummary = {
        ...validSummary,
        extra: 'prohibited',
      };
      assert.throws(() => DashboardSummarySchema.parse(extraSummary), /unrecognized_keys/i);
    });
  });

  describe('Non-negative integer validation', () => {
    const metricFields = [
      'totalBookings',
      'upcomingBookings',
      'completedBookings',
      'cancelledBookings',
    ] as const;

    for (const field of metricFields) {
      it(`rejects negative values for ${field}`, () => {
        const payload = { ...validStats, [field]: -1 };
        assert.throws(() => DashboardStatsSchema.parse(payload));
      });

      it(`rejects non-integer float values for ${field}`, () => {
        const payload = { ...validStats, [field]: 1.5 };
        assert.throws(() => DashboardStatsSchema.parse(payload));
      });

      it(`rejects string values for ${field}`, () => {
        const payload = { ...validStats, [field]: '1' };
        assert.throws(() => DashboardStatsSchema.parse(payload));
      });

      it(`rejects NaN / null / undefined for ${field}`, () => {
        assert.throws(() => DashboardStatsSchema.parse({ ...validStats, [field]: Number.NaN }));
        assert.throws(() => DashboardStatsSchema.parse({ ...validStats, [field]: null }));
        const missing = { ...validStats };
        delete (missing as Record<string, unknown>)[field];
        assert.throws(() => DashboardStatsSchema.parse(missing));
      });
    }
  });

  describe('Canonical 9-status enum', () => {
    const canonicalStatuses: DashboardBookingStatus[] = [
      'PROCESSING',
      'CONFIRMED',
      'FAILED',
      'COMPLETED',
      'CANCELLATION_PENDING',
      'CANCELLED_PENDING_REFUND',
      'CANCELLED_AND_REFUNDED',
      'CANCELLED_NO_REFUND',
      'REFUND_FAILED_NEEDS_ATTENTION',
    ];

    for (const status of canonicalStatuses) {
      it(`accepts canonical status '${status}'`, () => {
        const parsedEnum = DashboardBookingStatusEnum.parse(status);
        assert.equal(parsedEnum, status);

        const booking = { ...populatedBooking, status };
        const parsedBooking = DashboardRecentBookingSchema.parse(booking);
        assert.equal(parsedBooking.status, status);
      });
    }

    const invalidStatuses = [
      'CANCELLED',
      'PENDING',
      'REFUNDED',
      'cancelled',
      'confirmed',
      'processing',
      'UNKNOWN',
      'ACTIVE',
      '',
    ];

    for (const invalid of invalidStatuses) {
      it(`rejects non-canonical status '${invalid}'`, () => {
        assert.throws(() => DashboardBookingStatusEnum.parse(invalid));
        assert.throws(() =>
          DashboardRecentBookingSchema.parse({ ...populatedBooking, status: invalid }),
        );
      });
    }
  });

  describe('Nullable projections', () => {
    it('accepts null for all projection fields', () => {
      const parsed = DashboardRecentBookingSchema.parse(nullProjectedBooking);
      assert.equal(parsed.departureAt, null);
      assert.equal(parsed.originCode, null);
      assert.equal(parsed.destinationCode, null);
      assert.equal(parsed.airlineCode, null);
      assert.equal(parsed.flightNumber, null);
    });

    it('accepts populated string and ISO date-time values', () => {
      const parsed = DashboardRecentBookingSchema.parse(populatedBooking);
      assert.equal(parsed.departureAt, '2026-09-01T08:00:00Z');
      assert.equal(parsed.originCode, 'SGN');
      assert.equal(parsed.destinationCode, 'HAN');
      assert.equal(parsed.airlineCode, 'VN');
      assert.equal(parsed.flightNumber, 'VN123');
    });

    const projectionFields = [
      'departureAt',
      'originCode',
      'destinationCode',
      'airlineCode',
      'flightNumber',
    ] as const;

    for (const field of projectionFields) {
      it(`rejects missing/undefined ${field} (must be explicitly null or value)`, () => {
        const missing = { ...populatedBooking };
        delete (missing as Record<string, unknown>)[field];
        assert.throws(() => DashboardRecentBookingSchema.parse(missing));

        const explicitUndefined = { ...populatedBooking, [field]: undefined };
        assert.throws(() => DashboardRecentBookingSchema.parse(explicitUndefined));
      });
    }
  });

  describe('Recent booking array cap', () => {
    it('accepts 0, 1, and 5 recent bookings', () => {
      assert.doesNotThrow(() =>
        DashboardSummarySchema.parse({
          ...validSummary,
          recentBookings: [],
        }),
      );

      assert.doesNotThrow(() =>
        DashboardSummarySchema.parse({
          ...validSummary,
          recentBookings: [populatedBooking],
        }),
      );

      const fiveBookings = Array.from({ length: 5 }, (_, i) => ({
        ...populatedBooking,
        id: `a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1${i}`,
      }));
      assert.doesNotThrow(() =>
        DashboardSummarySchema.parse({
          ...validSummary,
          recentBookings: fiveBookings,
        }),
      );
    });

    it('rejects 6 items in recentBookings', () => {
      const sixBookings = Array.from({ length: 6 }, (_, i) => ({
        ...populatedBooking,
        id: `a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1${i}`,
      }));
      assert.throws(() =>
        DashboardSummarySchema.parse({
          ...validSummary,
          recentBookings: sixBookings,
        }),
      );
    });
  });

  describe('ISO 8601 datetime validation', () => {
    it('accepts valid UTC and offset date-times', () => {
      const utcBooking = {
        ...populatedBooking,
        createdAt: '2026-08-29T10:00:00Z',
        departureAt: '2026-09-01T15:30:00.000Z',
      };
      assert.doesNotThrow(() => DashboardRecentBookingSchema.parse(utcBooking));

      const offsetBooking = {
        ...populatedBooking,
        createdAt: '2026-08-29T17:00:00+07:00',
        departureAt: '2026-09-01T08:00:00-05:00',
      };
      assert.doesNotThrow(() => DashboardRecentBookingSchema.parse(offsetBooking));

      const summaryWithOffset = {
        ...validSummary,
        generatedAt: '2026-08-29T17:00:00+07:00',
      };
      assert.doesNotThrow(() => DashboardSummarySchema.parse(summaryWithOffset));
    });

    it('rejects invalid datetime strings', () => {
      assert.throws(() =>
        DashboardRecentBookingSchema.parse({
          ...populatedBooking,
          createdAt: 'not-a-date',
        }),
      );

      assert.throws(() =>
        DashboardRecentBookingSchema.parse({
          ...populatedBooking,
          departureAt: '2026-13-45T99:99:99Z',
        }),
      );

      assert.throws(() =>
        DashboardSummarySchema.parse({
          ...validSummary,
          generatedAt: 'invalid-iso',
        }),
      );
    });
  });

  describe('UUID validation', () => {
    it('accepts valid UUID v4', () => {
      assert.doesNotThrow(() =>
        DashboardRecentBookingSchema.parse({
          ...populatedBooking,
          id: 'c72d961b-a25d-49f5-ae4d-1777378fc436',
        }),
      );
    });

    it('rejects malformed UUID strings', () => {
      const invalidIds = ['booking-123', 'not-a-uuid', '', '12345', 'c72d961b-a25d-49f5'];
      for (const id of invalidIds) {
        assert.throws(() =>
          DashboardRecentBookingSchema.parse({
            ...populatedBooking,
            id,
          }),
        );
      }
    });
  });

  describe('DashboardOutcome discriminated union', () => {
    it('parses success outcome with valid summary', () => {
      const successOutcome: DashboardOutcome = {
        ok: true,
        data: validSummary,
      };
      const parsed = DashboardOutcomeSchema.parse(successOutcome);
      assert.equal(parsed.ok, true);
      if (parsed.ok) {
        assert.deepEqual(parsed.data, validSummary);
      }
    });

    it('rejects success outcome with invalid data', () => {
      assert.throws(() =>
        DashboardOutcomeSchema.parse({
          ok: true,
          data: { invalid: 'data' },
        }),
      );
    });

    const failureReasons: Array<
      'UNAUTHENTICATED' | 'FORBIDDEN' | 'UPSTREAM_UNAVAILABLE' | 'INVALID_RESPONSE'
    > = ['UNAUTHENTICATED', 'FORBIDDEN', 'UPSTREAM_UNAVAILABLE', 'INVALID_RESPONSE'];

    for (const reason of failureReasons) {
      it(`parses failure outcome with reason '${reason}'`, () => {
        const failureOutcome: DashboardOutcome = {
          ok: false,
          reason,
          message: `Failed due to ${reason}`,
          retryable: reason === 'UPSTREAM_UNAVAILABLE',
        };
        const parsed = DashboardOutcomeSchema.parse(failureOutcome);
        assert.equal(parsed.ok, false);
        if (!parsed.ok) {
          assert.equal(parsed.reason, reason);
          assert.equal(parsed.message, `Failed due to ${reason}`);
          assert.equal(parsed.retryable, reason === 'UPSTREAM_UNAVAILABLE');
        }
      });
    }

    it('rejects unknown failure reasons', () => {
      assert.throws(() =>
        DashboardOutcomeSchema.parse({
          ok: false,
          reason: 'UNKNOWN_REASON',
          message: 'Unknown failure',
          retryable: false,
        }),
      );
    });

    it('rejects failure outcome missing required fields', () => {
      assert.throws(() =>
        DashboardOutcomeSchema.parse({
          ok: false,
          reason: 'UNAUTHENTICATED',
        }),
      );

      assert.throws(() =>
        DashboardOutcomeSchema.parse({
          ok: false,
          message: 'Missing reason',
          retryable: false,
        }),
      );

      assert.throws(() =>
        DashboardOutcomeSchema.parse({
          ok: false,
          reason: 'UNAUTHENTICATED',
          message: 'Missing retryable',
        }),
      );
    });
  });
});
