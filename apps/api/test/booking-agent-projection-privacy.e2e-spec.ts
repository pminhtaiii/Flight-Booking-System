import { PrismaClient } from '@prisma/client';

describe('BookingAgentProjection Privacy Invariants (E2E)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('verifies exact allowlisted columns exist in information_schema for booking_agent_projections', async () => {
    const columns: Array<{ column_name: string }> = await prisma.$queryRaw`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'booking_agent_projections'
    `;

    const columnNames = columns.map((c) => c.column_name);

    // Allowed columns
    expect(columnNames).toContain('bookingId');
    expect(columnNames).toContain('agentReference');
    expect(columnNames).toContain('status');
    expect(columnNames).toContain('airline');
    expect(columnNames).toContain('origin');
    expect(columnNames).toContain('destination');
    expect(columnNames).toContain('departureAt');
    expect(columnNames).toContain('arrivalAt');
    expect(columnNames).toContain('durationMinutes');
    expect(columnNames).toContain('stopCount');
    expect(columnNames).toContain('flightNumber');
    expect(columnNames).toContain('baggageSummary');
    expect(columnNames).toContain('refundable');
    expect(columnNames).toContain('changeable');
    expect(columnNames).toContain('createdAt');
    expect(columnNames).toContain('updatedAt');

    // Forbidden columns MUST NOT exist in projection table
    expect(columnNames).not.toContain('pnr');
    expect(columnNames).not.toContain('pnrReference');
    expect(columnNames).not.toContain('totalAmount');
    expect(columnNames).not.toContain('price');
    expect(columnNames).not.toContain('currency');
    expect(columnNames).not.toContain('fareClass');
    expect(columnNames).not.toContain('cabinClass');
    expect(columnNames).not.toContain('passengerCount');
    expect(columnNames).not.toContain('contactEmail');
    expect(columnNames).not.toContain('contactPhone');
    expect(columnNames).not.toContain('passportNumber');
    expect(columnNames).not.toContain('paymentId');
    expect(columnNames).not.toContain('stripePaymentIntentId');
    expect(columnNames).not.toContain('rawDuffelOrder');
    expect(columnNames).not.toContain('flightSnapshot');
    expect(columnNames).not.toContain('passengerSnapshot');
  });

  it('proves that stored agentReference is opaque, non-guessable, and not derived from internal DB id', async () => {
    const projections = await prisma.bookingAgentProjection.findMany({ take: 10 });
    for (const proj of projections) {
      expect(proj.agentReference).toMatch(/^bkref_[0-9a-fA-F-]+$/);
      expect(proj.agentReference).not.toBe(proj.bookingId);
      expect(proj.agentReference.includes(proj.bookingId)).toBe(false);
    }
  });
});
