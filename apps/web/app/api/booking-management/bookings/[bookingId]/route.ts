import { getBookingDetail } from '@/lib/server/booking-management';
import { mapOutcomeToResponse } from '@/lib/server/outcome-response';
import type { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: { bookingId: string } },
): Promise<NextResponse> {
  const outcome = await getBookingDetail(params.bookingId);
  return mapOutcomeToResponse(outcome);
}
