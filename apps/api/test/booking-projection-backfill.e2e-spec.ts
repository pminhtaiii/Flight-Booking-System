import { PrismaClient } from '@prisma/client';
import { backfillBookingAgentProjections } from '../prisma/scripts/backfill-booking-agent-projections';

describe('BookingAgentProjection Backfill (E2E)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('runs backfill script and creates projections for existing bookings', async () => {
    // 1. Run backfill
    await backfillBookingAgentProjections();

    // 2. Query projections
    const projections = await prisma.bookingAgentProjection.findMany();
    expect(Array.isArray(projections)).toBe(true);

    for (const proj of projections) {
      expect(proj.agentReference).toMatch(/^bkref_/);
      expect(proj.status).toBeDefined();
      expect(proj.airline).toBeDefined();
      expect(proj.origin).toBeDefined();
      expect(proj.destination).toBeDefined();
    }
  });

  it('is idempotent when re-run (does not duplicate or overwrite existing references)', async () => {
    const beforeProjections = await prisma.bookingAgentProjection.findMany();
    const referenceMapBefore = new Map(beforeProjections.map(p => [p.bookingId, p.agentReference]));

    // Run backfill second time
    await backfillBookingAgentProjections();

    const afterProjections = await prisma.bookingAgentProjection.findMany();
    expect(afterProjections.length).toBe(beforeProjections.length);

    for (const proj of afterProjections) {
      expect(proj.agentReference).toBe(referenceMapBefore.get(proj.bookingId));
    }
  });
});
