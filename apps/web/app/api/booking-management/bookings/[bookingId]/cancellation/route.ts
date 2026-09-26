import { getCancellationStatus, cancelBooking } from '@/lib/server/booking-management';
import { mapOutcomeToResponse } from '@/lib/server/outcome-response';
import type { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

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
