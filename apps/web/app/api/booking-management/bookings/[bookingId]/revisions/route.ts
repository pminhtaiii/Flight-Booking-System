import { getItineraryRevisions } from '@/lib/server/booking-management';
import { mapOutcomeToResponse } from '@/lib/server/outcome-response';
import type { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

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
