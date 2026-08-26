import { NextResponse } from 'next/server';
import { getItineraryRevisions } from '@/lib/server/booking-management';
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
  request: Request,
  { params }: { params: { bookingId: string } },
): Promise<NextResponse> {
  const url = new URL(request.url);
  const pageParam = url.searchParams.get('page');
  const limitParam = url.searchParams.get('limit');

  const page = pageParam ? parseInt(pageParam, 10) : 1;
  const limit = limitParam ? parseInt(limitParam, 10) : 5;

  const outcome = await getItineraryRevisions(
    params.bookingId,
    Number.isNaN(page) ? 1 : page,
    Number.isNaN(limit) ? 5 : limit,
  );
  return mapOutcomeToResponse(outcome);
}
