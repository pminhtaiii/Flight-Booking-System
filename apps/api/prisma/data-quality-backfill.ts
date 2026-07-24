/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Segment {
  departureAt?: string;
  arrivalAt?: string;
}

interface Snapshot {
  segments?: Segment[];
}

async function run() {
  console.log('--- Starting Data Quality Check & Backfill ---');

  const bookings = await prisma.booking.findMany();

  const missingOrderId: string[] = [];
  const duplicateMap = new Map<string, string[]>();
  const missingSnapshot: string[] = [];
  const lackingTimes: string[] = [];

  for (const booking of bookings) {
    if (!booking.duffelOrderId) {
      missingOrderId.push(booking.id);
    } else {
      const existing = duplicateMap.get(booking.duffelOrderId) || [];
      existing.push(booking.id);
      duplicateMap.set(booking.duffelOrderId, existing);
    }

    if (!booking.flightSnapshot) {
      missingSnapshot.push(booking.id);
    } else {
      const snapshot = booking.flightSnapshot as unknown as Snapshot;
      if (!snapshot.segments || !Array.isArray(snapshot.segments) || snapshot.segments.length === 0) {
        lackingTimes.push(booking.id);
      }
    }
  }

  const duplicateOrderIdItems = Array.from(duplicateMap.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([duffelOrderId, ids]) => ({ duffelOrderId, bookingIds: ids }));

  console.log(`Total Bookings: ${bookings.length}`);
  console.log(`Missing Duffel Order ID: ${missingOrderId.length}`);
  console.log(`Duplicate Duffel Order ID Groups: ${duplicateOrderIdItems.length}`);
  console.log(`Missing Flight Snapshot: ${missingSnapshot.length}`);
  console.log(`Bookings lacking segments in snapshot: ${lackingTimes.length}`);

  // Perform backfill
  let backfilledCount = 0;
  const now = new Date();

  for (const booking of bookings) {
    // Only backfill bookings that have a valid snapshot
    if (!booking.flightSnapshot) {
      continue;
    }

    const snapshot = booking.flightSnapshot as unknown as Snapshot;
    if (!snapshot.segments || !Array.isArray(snapshot.segments) || snapshot.segments.length === 0) {
      continue;
    }

    const segments = snapshot.segments;
    const firstSegment = segments[0];
    const lastSegment = segments[segments.length - 1];

    if (!firstSegment.departureAt || !lastSegment.arrivalAt) {
      continue;
    }

    const currentDepartureAt = new Date(firstSegment.departureAt);
    const currentFinalArrivalAt = new Date(lastSegment.arrivalAt);

    // Find next unflown departure
    let nextUnflownDepartureAt: Date | null = null;
    for (const seg of segments) {
      if (seg.departureAt) {
        const depTime = new Date(seg.departureAt);
        if (depTime > now) {
          nextUnflownDepartureAt = depTime;
          break;
        }
      }
    }

    // Check if backfill updates are needed
    const needsUpdate =
      !booking.currentDepartureAt ||
      !booking.currentFinalArrivalAt ||
      (nextUnflownDepartureAt && !booking.nextUnflownDepartureAt) ||
      booking.currentDepartureAt.getTime() !== currentDepartureAt.getTime() ||
      booking.currentFinalArrivalAt.getTime() !== currentFinalArrivalAt.getTime() ||
      (nextUnflownDepartureAt &&
        booking.nextUnflownDepartureAt &&
        booking.nextUnflownDepartureAt.getTime() !== nextUnflownDepartureAt.getTime());

    if (needsUpdate) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          currentDepartureAt,
          currentFinalArrivalAt,
          nextUnflownDepartureAt,
        },
      });
      backfilledCount++;
    }
  }

  console.log(`Successfully backfilled timing fields for ${backfilledCount} bookings.`);
  console.log('--- Data Quality Check & Backfill Completed ---');
}

run()
  .catch((err) => {
    console.error('Error during data quality check and backfill:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
