import { PrismaClient, Prisma } from '@prisma/client';
import {
  BookingProjectionService,
  MalformedRevisionError,
  SafeBookingProjectionData,
} from '../../src/booking-projection/booking-projection.service';
import { BookingProjectionRepository } from '../../src/booking-projection/booking-projection.repository';
import { PrismaService } from '../../src/prisma/prisma.service';

export type BackfillSummary = {
  processed: number;
  success: number;
  staleIgnored: number;
  skipped: number;
  failed: number;
};

export type BookingWithRevisions = Prisma.BookingGetPayload<{
  include: {
    itineraryRevisions: {
      include: {
        segments: true;
      };
    };
  };
}>;

export async function backfillBookingAgentProjections(
  prismaClient?: PrismaClient,
): Promise<BackfillSummary> {
  const isInternalPrisma = !prismaClient;
  const prisma = prismaClient ?? new PrismaClient();

  const projectionService = new BookingProjectionService();
  // Pass standalone PrismaClient instance cast to PrismaService for CLI execution
  const projectionRepository = new BookingProjectionRepository(prisma as unknown as PrismaService);

  const CHUNK_SIZE = 50;
  let processed = 0;
  let success = 0;
  let staleIgnored = 0;
  let skipped = 0;
  let failed = 0;
  let lastId: string | undefined = undefined;

  console.log('Starting restart-safe backfill of BookingAgentProjections...');

  try {
    while (true) {
      const bookings: BookingWithRevisions[] = await prisma.booking.findMany({
        take: CHUNK_SIZE,
        skip: lastId ? 1 : 0,
        cursor: lastId ? { id: lastId } : undefined,
        orderBy: { id: 'asc' },
        include: {
          itineraryRevisions: {
            orderBy: { version: 'desc' },
            take: 1,
            include: {
              segments: {
                orderBy: { globalOrder: 'asc' },
              },
            },
          },
        },
      });

      if (bookings.length === 0) {
        break;
      }

      for (const booking of bookings) {
        lastId = booking.id;
        processed++;
        try {
          let projectionData: SafeBookingProjectionData | null = null;
          try {
            projectionData = projectionService.extractProjectionData(booking);
          } catch (extractErr) {
            if (extractErr instanceof MalformedRevisionError) {
              console.warn(
                `Skipping booking ${booking.id}: malformed revision - ${extractErr.message}`,
              );
              failed++;
              continue;
            }
            throw extractErr;
          }

          if (!projectionData) {
            console.log(`Skipping booking ${booking.id}: missing flight data`);
            skipped++;
            continue;
          }

          // upsertGuarded preserves existing agentReference automatically via SQL ON CONFLICT DO UPDATE
          const result = await projectionRepository.upsertGuarded(
            {
              bookingId: booking.id,
              status: booking.status,
              sourceVersion: booking.version ?? 1,
              data: projectionData,
            },
            prisma as unknown as PrismaService,
          );

          if (result.outcome === 'SUCCESS') {
            success++;
          } else {
            staleIgnored++;
          }
        } catch (error: unknown) {
          failed++;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Failed to backfill booking ${booking.id}: ${message}`);
        }
      }

      console.log(
        `Progress: ${processed} processed (${success} successful, ${staleIgnored} stale ignored, ${skipped} skipped, ${failed} failed)`,
      );
    }
  } finally {
    if (isInternalPrisma) {
      await prisma.$disconnect();
    }
  }

  console.log(`\nBackfill complete!`);
  console.log(`Total Processed: ${processed}`);
  console.log(`Success: ${success}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);

  return {
    processed,
    success,
    staleIgnored,
    skipped,
    failed,
  };
}

if (require.main === module) {
  backfillBookingAgentProjections()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('Fatal error during backfill:', e);
      process.exit(1);
    });
}

