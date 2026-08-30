import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

export async function backfillBookingAgentProjections() {
  const CHUNK_SIZE = 50;
  let processed = 0;
  let success = 0;
  let failed = 0;
  let lastId: string | undefined = undefined;

  console.log('Starting restart-safe backfill of BookingAgentProjections...');

  while (true) {
    const bookings: any[] = await prisma.booking.findMany({
      take: CHUNK_SIZE,
      skip: lastId ? 1 : 0,
      ...(lastId && { cursor: { id: lastId } }),
      orderBy: { id: 'asc' },
      include: {
        itineraryRevisions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: { segments: { orderBy: { globalOrder: 'asc' } } },
        },
      },
    });

    if (bookings.length === 0) {
      break;
    }

    for (const booking of bookings) {
      processed++;
      try {
        let agentReference: string;
        const existing = await prisma.bookingAgentProjection.findUnique({
          where: { bookingId: booking.id },
        });

        if (existing) {
          agentReference = existing.agentReference;
        } else {
          agentReference = `bkref_${crypto.randomBytes(16).toString('hex')}`;
        }

        let origin = '';
        let destination = '';
        let departureAt = new Date(0);
        let arrivalAt = new Date(0);
        let durationMinutes = 0;
        let stopCount = 0;
        let airline = '';
        let flightNumber: string | null = null;
        let hasFlightData = false;

        if (booking.itineraryRevisions && booking.itineraryRevisions.length > 0) {
          const activeRevision = booking.itineraryRevisions[0];
          const segments = activeRevision.segments || [];
          if (segments.length > 0) {
            origin = segments[0].departureAirportIata;
            destination = segments[segments.length - 1].arrivalAirportIata;
            departureAt = new Date(segments[0].departureAt);
            arrivalAt = new Date(segments[segments.length - 1].arrivalAt);
            durationMinutes = (arrivalAt.getTime() - departureAt.getTime()) / 60000;
            stopCount = Math.max(0, segments.length - 1);
            airline = segments[0].airlineName;
            flightNumber = `${segments[0].marketingCarrierIata} ${segments[0].flightNumber}`;
            hasFlightData = true;
          }
        }

        if (!hasFlightData) {
          const flightSnapshot: any = booking.flightSnapshot;
          if (
            flightSnapshot &&
            flightSnapshot.segments &&
            Array.isArray(flightSnapshot.segments) &&
            flightSnapshot.segments.length > 0
          ) {
            const segments = flightSnapshot.segments;
            const depStr = segments[0].departureAt;
            const arrStr = segments[segments.length - 1].arrivalAt;

            if (depStr && arrStr) {
              const parsedDep = new Date(depStr);
              const parsedArr = new Date(arrStr);

              if (!isNaN(parsedDep.getTime()) && !isNaN(parsedArr.getTime())) {
                origin = segments[0].departureAirport?.iataCode || '';
                destination = segments[segments.length - 1].arrivalAirport?.iataCode || '';
                departureAt = parsedDep;
                arrivalAt = parsedArr;
                durationMinutes = (arrivalAt.getTime() - departureAt.getTime()) / 60000;
                stopCount = flightSnapshot.stops ?? Math.max(0, segments.length - 1);
                airline = segments[0].airline?.name || '';
                flightNumber = segments[0].airline?.iataCode
                  ? `${segments[0].airline.iataCode} ${segments[0].flightNumber}`
                  : null;
                hasFlightData = true;
              }
            }
          }
        }

        if (!hasFlightData) {
          console.log(`Skipping booking ${booking.id}: missing flight data`);
        } else {
          let attempt = 0;
          let successUpsert = false;
          while (attempt < 3 && !successUpsert) {
            try {
              await prisma.bookingAgentProjection.upsert({
                where: { bookingId: booking.id },
                create: {
                  bookingId: booking.id,
                  agentReference,
                  status: booking.status,
                  airline,
                  origin,
                  destination,
                  departureAt,
                  arrivalAt,
                  durationMinutes,
                  stopCount,
                  flightNumber,
                },
                update: {
                  status: booking.status,
                  airline,
                  origin,
                  destination,
                  departureAt,
                  arrivalAt,
                  durationMinutes,
                  stopCount,
                  flightNumber,
                },
              });
              successUpsert = true;
            } catch (error: any) {
              if (error.code === 'P2002' && attempt < 2) {
                attempt++;
                agentReference = `bkref_${crypto.randomBytes(16).toString('hex')}`;
              } else {
                throw error;
              }
            }
          }
          success++;
        }
      } catch (error: any) {
        failed++;
        console.error(`Failed to backfill booking ${booking.id}: ${error.message}`);
      }

      lastId = booking.id;
    }

    console.log(`Progress: ${processed} processed (${success} successful, ${failed} failed)`);
  }

  console.log(`\nBackfill complete!`);
  console.log(`Total Processed: ${processed}`);
  console.log(`Success: ${success}`);
  console.log(`Failed: ${failed}`);

  await prisma.$disconnect();
}

if (require.main === module) {
  backfillBookingAgentProjections()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('Fatal error during backfill:', e);
      prisma.$disconnect();
      process.exit(1);
    });
}
