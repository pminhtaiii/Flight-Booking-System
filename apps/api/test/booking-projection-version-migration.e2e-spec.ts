import { PrismaClient, Prisma, BookingIntentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';

describe('Booking & BookingAgentProjection Version Migration (E2E)', () => {
  let prisma: PrismaClient;
  let testUserId: string;
  let testIntentId: string;
  let testBookingId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();

    // Create test user
    const user = await prisma.user.create({
      data: {
        email: `migration-e2e-${Date.now()}-${Math.random().toString(36).substring(2, 7)}@example.com`,
        password: 'hash_password_test',
      },
    });
    testUserId = user.id;

    // Create test booking intent
    const intent = await prisma.bookingIntent.create({
      data: {
        userId: testUserId,
        duffelOfferId: `off_test_${randomUUID()}`,
        status: BookingIntentStatus.COMPLETED,
        originalPrice: new Prisma.Decimal('199.99'),
        confirmedPrice: new Prisma.Decimal('199.99'),
        pricedAt: new Date(),
        intentExpiresAt: new Date(Date.now() + 3600000),
        origin: 'LHR',
        destination: 'JFK',
        departureDate: new Date(),
        adults: 1,
        rawOfferSnapshot: {},
      },
    });
    testIntentId = intent.id;
  });

  afterAll(async () => {
    try {
      if (testBookingId) {
        await prisma.bookingAgentProjection.deleteMany({
          where: { bookingId: testBookingId },
        });
        await prisma.booking.deleteMany({
          where: { id: testBookingId },
        });
      }
      if (testIntentId) {
        await prisma.bookingIntent.deleteMany({
          where: { id: testIntentId },
        });
      }
      if (testUserId) {
        await prisma.user.deleteMany({
          where: { id: testUserId },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  describe('Default Values Verification', () => {
    it('verifies new Booking row has default version = 1', async () => {
      const booking = await prisma.booking.create({
        data: {
          userId: testUserId,
          bookingIntentId: testIntentId,
          totalAmount: new Prisma.Decimal('199.99'),
          currency: 'GBP',
          status: 'PROCESSING',
        },
      });
      testBookingId = booking.id;

      // Assert Prisma client reads version as 1
      expect(booking.version).toBe(1);

      // Raw SQL verification directly against PostgreSQL
      const rawRows = await prisma.$queryRaw<Array<{ version: number }>>`
        SELECT "version" FROM "bookings" WHERE "id" = ${booking.id}
      `;
      expect(rawRows).toHaveLength(1);
      expect(rawRows[0].version).toBe(1);
    });

    it('verifies new BookingAgentProjection row has default sourceVersion = 0', async () => {
      const agentRef = `bkref_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const departure = new Date();
      const arrival = new Date(departure.getTime() + 7200000);

      const projection = await prisma.bookingAgentProjection.create({
        data: {
          bookingId: testBookingId,
          agentReference: agentRef,
          status: 'PROCESSING',
          airline: 'British Airways',
          origin: 'LHR',
          destination: 'JFK',
          departureAt: departure,
          arrivalAt: arrival,
          durationMinutes: 480,
          stopCount: 0,
        },
      });

      // Assert Prisma client reads sourceVersion as 0
      expect(projection.sourceVersion).toBe(0);

      // Raw SQL verification directly against PostgreSQL
      const rawRows = await prisma.$queryRaw<Array<{ source_version: number }>>`
        SELECT "source_version" FROM "booking_agent_projections" WHERE "bookingId" = ${testBookingId}
      `;
      expect(rawRows).toHaveLength(1);
      expect(rawRows[0].source_version).toBe(0);
    });

    it('verifies PostgreSQL column defaults apply when inserted via raw SQL without specifying version columns', async () => {
      // Create another booking intent for raw SQL insertion
      const secondIntent = await prisma.bookingIntent.create({
        data: {
          userId: testUserId,
          duffelOfferId: `off_raw_${randomUUID()}`,
          status: BookingIntentStatus.COMPLETED,
          originalPrice: new Prisma.Decimal('299.99'),
          confirmedPrice: new Prisma.Decimal('299.99'),
          pricedAt: new Date(),
          intentExpiresAt: new Date(Date.now() + 3600000),
          origin: 'CDG',
          destination: 'JFK',
          departureDate: new Date(),
          adults: 1,
          rawOfferSnapshot: {},
        },
      });

      const rawBookingId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "bookings" ("id", "userId", "bookingIntentId", "totalAmount", "currency", "status", "updatedAt")
        VALUES (${rawBookingId}, ${testUserId}, ${secondIntent.id}, 299.99, 'GBP', 'PROCESSING', NOW())
      `;

      const rawBookingRows = await prisma.$queryRaw<Array<{ version: number }>>`
        SELECT "version" FROM "bookings" WHERE "id" = ${rawBookingId}
      `;
      expect(rawBookingRows[0].version).toBe(1);

      const rawAgentRef = `bkref_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await prisma.$executeRaw`
        INSERT INTO "booking_agent_projections" (
          "bookingId", "agentReference", "status", "airline", "origin", "destination",
          "departureAt", "arrivalAt", "durationMinutes", "stopCount", "updatedAt"
        )
        VALUES (
          ${rawBookingId}, ${rawAgentRef}, 'CONFIRMED', 'Air France', 'CDG', 'JFK',
          NOW(), NOW() + INTERVAL '8 hours', 480, 0, NOW()
        )
      `;

      const rawProjRows = await prisma.$queryRaw<Array<{ source_version: number }>>`
        SELECT "source_version" FROM "booking_agent_projections" WHERE "bookingId" = ${rawBookingId}
      `;
      expect(rawProjRows[0].source_version).toBe(0);

      // Cleanup raw test records
      await prisma.bookingAgentProjection.delete({ where: { bookingId: rawBookingId } });
      await prisma.booking.delete({ where: { id: rawBookingId } });
      await prisma.bookingIntent.delete({ where: { id: secondIntent.id } });
    });
  });

  describe('Foreign Key & Relation Preservation', () => {
    it('verifies existing foreign keys and one-to-one references are preserved with new columns present', async () => {
      // Query booking with relations
      const bookingWithRelations = await prisma.booking.findUnique({
        where: { id: testBookingId },
        include: {
          user: true,
          bookingIntent: true,
          agentProjection: true,
        },
      });

      expect(bookingWithRelations).not.toBeNull();
      expect(bookingWithRelations!.userId).toBe(testUserId);
      expect(bookingWithRelations!.user.id).toBe(testUserId);
      expect(bookingWithRelations!.bookingIntentId).toBe(testIntentId);
      expect(bookingWithRelations!.bookingIntent.id).toBe(testIntentId);
      expect(bookingWithRelations!.agentProjection).not.toBeNull();
      expect(bookingWithRelations!.agentProjection!.bookingId).toBe(testBookingId);
      expect(bookingWithRelations!.version).toBe(1);
      expect(bookingWithRelations!.agentProjection!.sourceVersion).toBe(0);

      // Query reverse relation from projection to booking
      const projectionWithBooking = await prisma.bookingAgentProjection.findUnique({
        where: { bookingId: testBookingId },
        include: {
          booking: {
            include: {
              user: true,
            },
          },
        },
      });

      expect(projectionWithBooking).not.toBeNull();
      expect(projectionWithBooking!.booking.id).toBe(testBookingId);
      expect(projectionWithBooking!.booking.user.id).toBe(testUserId);
      expect(projectionWithBooking!.sourceVersion).toBe(0);
      expect(projectionWithBooking!.booking.version).toBe(1);
    });
  });

  describe('Legacy-Writer Compatibility Fixture', () => {
    it('verifies that updates omitting version leave Booking.version intact, unchanged (1), and valid', async () => {
      // 1. Prisma update without version field (simulating legacy service updating booking)
      const updatedViaPrisma = await prisma.booking.update({
        where: { id: testBookingId },
        data: {
          status: 'CONFIRMED',
          pnrReference: 'LEGACY-PNR-001',
          duffelOrderId: 'ord_legacy_test',
        },
      });

      expect(updatedViaPrisma.status).toBe('CONFIRMED');
      expect(updatedViaPrisma.pnrReference).toBe('LEGACY-PNR-001');
      // version must remain intact and unchanged at 1
      expect(updatedViaPrisma.version).toBe(1);

      // 2. Raw SQL update without touching "version" column (simulating pure legacy SQL writer)
      await prisma.$executeRaw`
        UPDATE "bookings"
        SET "cancellationRefundable" = true, "updatedAt" = NOW()
        WHERE "id" = ${testBookingId}
      `;

      const queriedAfterRawUpdate = await prisma.booking.findUniqueOrThrow({
        where: { id: testBookingId },
      });

      expect(queriedAfterRawUpdate.cancellationRefundable).toBe(true);
      expect(queriedAfterRawUpdate.version).toBe(1);

      // 3. Raw SQL projection update without touching "source_version" column
      await prisma.$executeRaw`
        UPDATE "booking_agent_projections"
        SET "status" = 'CONFIRMED', "flightNumber" = 'BA178', "updatedAt" = NOW()
        WHERE "bookingId" = ${testBookingId}
      `;

      const queriedProjAfterRaw = await prisma.bookingAgentProjection.findUniqueOrThrow({
        where: { bookingId: testBookingId },
      });

      expect(queriedProjAfterRaw.status).toBe('CONFIRMED');
      expect(queriedProjAfterRaw.flightNumber).toBe('BA178');
      expect(queriedProjAfterRaw.sourceVersion).toBe(0);
    });
  });
});
