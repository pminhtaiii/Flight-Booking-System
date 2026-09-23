import { NextResponse } from 'next/server';
import { getCancellationStatus, cancelBooking } from '@/lib/server/booking-management';
import type { BookingManagementOutcome } from '@shared/types/booking-management.types';

export const dynamic = 'force-dynamic';

function mapOutcomeToResponse<T>(outcome: BookingManagementOutcome<T>): NextResponse {
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

export async function GET(
  _request: Request,
  { params }: { params: { bookingId: string } },
): Promise<NextResponse> {
  const outcome = await getCancellationStatus(params.bookingId);
  return mapOutcomeToResponse(outcome);
}

export async function POST(
  request: Request,
  { params }: { params: { bookingId: string } },
): Promise<NextResponse> {
  let quoteId = '';
  try {
    // Safely cast untrusted JSON request payload before runtime shape verification
    const body = (await request.json()) as { quoteId?: unknown };
    if (typeof body?.quoteId === 'string') {
      quoteId = body.quoteId;
    }
  } catch {
    // Empty / invalid body
  }

  const outcome = await cancelBooking(params.bookingId, quoteId);
  return mapOutcomeToResponse(outcome);
}
