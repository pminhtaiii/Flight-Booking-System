import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

export async function backfillBookingAgentProjections() {
  const bookings = await prisma.booking.findMany({
    where: { agentProjection: null },
    include: {
      itineraryRevisions: {
        orderBy: { version: 'desc' },
        take: 1,
        include: { segments: { orderBy: { globalOrder: 'asc' } } }
      }
    }
  });

  for (const booking of bookings) {
    const revision = booking.itineraryRevisions[0];
    if (!revision || !revision.segments.length) continue;
    
    const agentReference = 'bkref_' + crypto.randomUUID().replace(/-/g, '').substring(0, 16);
    const firstSegment = revision.segments[0];
    const lastSegment = revision.segments[revision.segments.length - 1];
    
    const durationMinutes = revision.segments.reduce((acc, seg) => acc + seg.durationMinutes, 0);
    const stopCount = revision.segments.length - 1;
    
    await prisma.bookingAgentProjection.create({
      data: {
        bookingId: booking.id,
        agentReference,
        status: booking.status,
        airline: firstSegment.airlineName,
        origin: firstSegment.departureAirportIata,
        destination: lastSegment.arrivalAirportIata,
        departureAt: firstSegment.departureAt,
        arrivalAt: lastSegment.arrivalAt,
        durationMinutes,
        stopCount,
        flightNumber: firstSegment.operatingCarrierIata ? `${firstSegment.operatingCarrierIata}${firstSegment.flightNumber}` : `${firstSegment.marketingCarrierIata}${firstSegment.flightNumber}`,
        baggageSummary: 'Standard allowance',
        refundable: booking.cancellationRefundable,
        changeable: false,
      }
    });
  }
}

if (require.main === module) {
  backfillBookingAgentProjections()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
