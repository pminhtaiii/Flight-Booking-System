import { acceptDisruption } from '@/lib/server/booking-management';
import { mapOutcomeToResponse } from '@/lib/server/outcome-response';
import type { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { bookingId: string } },
): Promise<NextResponse> {
  let revisionId = '';
  try {
    const body = (await request.json()) as { revisionId?: unknown };
    if (typeof body?.revisionId === 'string') {
      revisionId = body.revisionId;
    }
  } catch {
    // Empty body
  }

  const outcome = await acceptDisruption(params.bookingId, revisionId);
  return mapOutcomeToResponse(outcome);
}
