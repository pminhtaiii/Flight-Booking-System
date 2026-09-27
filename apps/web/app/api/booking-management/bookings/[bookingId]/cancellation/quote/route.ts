import { getCancellationQuote } from '@/lib/server/booking-management';
import { mapOutcomeToResponse } from '@/lib/server/outcome-response';
import type { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: { bookingId: string } },
): Promise<NextResponse> {
  const outcome = await getCancellationQuote(params.bookingId);
  return mapOutcomeToResponse(outcome);
}
