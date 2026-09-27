import 'server-only';
import { NextResponse } from 'next/server';
import type { BookingManagementOutcome } from '@shared/types/booking-management.types';

export function mapOutcomeToResponse<T>(outcome: BookingManagementOutcome<T>): NextResponse {
  if (outcome.ok) {
    return NextResponse.json(outcome.data, {
      status: 200,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  const statusMap: Record<typeof outcome.reason, number> = {
    UNAUTHENTICATED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    STALE_REVISION: 409,
    INVALID_COMMAND: 400,
    UPSTREAM_UNAVAILABLE: 503,
  };

  return NextResponse.json(
    { error: outcome.reason, message: outcome.message },
    {
      status: statusMap[outcome.reason] || 500,
      headers: { 'Cache-Control': 'private, no-store' },
    },
  );
}
