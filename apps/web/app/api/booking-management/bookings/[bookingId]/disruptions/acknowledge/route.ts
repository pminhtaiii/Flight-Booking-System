import { acknowledgeDisruption } from '@/lib/server/booking-management';
import { mapOutcomeToResponse } from '@/lib/server/outcome-response';
import type { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { bookingId: string } },
): Promise<NextResponse> {
  let revisionId: string | undefined;
  try {
    const body = (await request.json()) as { revisionId?: unknown };
    if (typeof body?.revisionId === 'string') {
      revisionId = body.revisionId;
    }
  } catch {
    // Empty body
  }

  const outcome = await acknowledgeDisruption(params.bookingId, revisionId);
  return mapOutcomeToResponse(outcome);
}
