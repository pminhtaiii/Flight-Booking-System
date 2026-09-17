import {
  BookingProjectionRepository,
  UpsertGuardedParams,
} from './booking-projection.repository';
import { PrismaService } from '@/prisma/prisma.service';

describe('BookingProjectionRepository', () => {
  let repository: BookingProjectionRepository;
  let prisma: {
    $executeRaw: jest.Mock;
    bookingAgentProjection: {
      findUnique: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      $executeRaw: jest.fn(),
      bookingAgentProjection: {
        findUnique: jest.fn(),
      },
    };
    repository = new BookingProjectionRepository(prisma as unknown as PrismaService);
  });

  describe('a) Fresh insert stores source_version, status, projection fields, and generates agentReference (prefixed bkref_)', () => {
    it('executes atomic insert with generated bkref_ agentReference and returns SUCCESS when 1 row affected', async () => {
      prisma.$executeRaw.mockResolvedValueOnce(1);

      const params: UpsertGuardedParams = {
        bookingId: 'booking-uuid-001',
        status: 'PROCESSING',
        sourceVersion: 1,
        airline: 'Vietnam Airlines',
        origin: 'SGN',
        destination: 'HAN',
        departureAt: new Date('2026-10-01T10:00:00.000Z'),
        arrivalAt: new Date('2026-10-01T12:00:00.000Z'),
        durationMinutes: 120,
        stopCount: 0,
        flightNumber: 'VN 123',
        baggageSummary: '20kg checked',
        refundable: false,
        changeable: true,
      };

      const result = await repository.upsertGuarded(params);

      expect(result).toEqual({ outcome: 'SUCCESS' });
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

      // Inspect tagged template arguments passed to $executeRaw
      const [strings, ...values] = prisma.$executeRaw.mock.calls[0];
      const rawSql = strings.join('?');

      expect(rawSql).toContain('INSERT INTO "booking_agent_projections"');
      expect(rawSql).toContain('ON CONFLICT ("bookingId") DO UPDATE');

      // Check values
      expect(values).toContain('booking-uuid-001');
      expect(values).toContain('PROCESSING');
      expect(values).toContain(1); // sourceVersion
      expect(values).toContain('Vietnam Airlines');
      expect(values).toContain('SGN');
      expect(values).toContain('HAN');

      // Check generated agentReference
      const agentRef = values.find(
        (v: unknown) => typeof v === 'string' && v.startsWith('bkref_'),
      );
      expect(agentRef).toBeDefined();
      expect(agentRef).toMatch(/^bkref_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('accepts nested data property conforming to SafeBookingProjectionData', async () => {
      prisma.$executeRaw.mockResolvedValueOnce(1);

      const result = await repository.upsertGuarded({
        bookingId: 'booking-uuid-002',
        status: 'CONFIRMED',
        sourceVersion: 2,
        data: {
          airline: 'British Airways',
          origin: 'LHR',
          destination: 'JFK',
          departureAt: new Date('2026-10-01T10:00:00.000Z'),
          arrivalAt: new Date('2026-10-01T16:00:00.000Z'),
          durationMinutes: 360,
          stopCount: 0,
          flightNumber: 'BA 117',
          baggageSummary: null,
          refundable: null,
          changeable: null,
        },
      });

      expect(result).toEqual({ outcome: 'SUCCESS' });
      const values = prisma.$executeRaw.mock.calls[0].slice(1);
      expect(values).toContain('British Airways');
      expect(values).toContain('LHR');
      expect(values).toContain('JFK');
    });
  });

  describe('b) Guarded update succeeds when newSourceVersion > storedSourceVersion', () => {
    it('returns outcome: SUCCESS when database executes update (rows affected = 1)', async () => {
      prisma.$executeRaw.mockResolvedValueOnce(1);

      const result = await repository.upsertGuarded({
        bookingId: 'booking-uuid-001',
        status: 'CONFIRMED',
        sourceVersion: 3,
        airline: 'Vietnam Airlines',
        origin: 'SGN',
        destination: 'HAN',
        departureAt: new Date('2026-10-01T10:00:00.000Z'),
        arrivalAt: new Date('2026-10-01T12:00:00.000Z'),
        durationMinutes: 120,
        stopCount: 0,
      });

      expect(result).toEqual({ outcome: 'SUCCESS' });
    });
  });

  describe('c) Guarded update returns outcome: STALE_IGNORED when newSourceVersion <= storedSourceVersion', () => {
    it('returns outcome: STALE_IGNORED when database skips update due to WHERE version guard (rows affected = 0)', async () => {
      // PostgreSQL WHERE "booking_agent_projections"."source_version" < EXCLUDED."source_version" evaluates to false
      prisma.$executeRaw.mockResolvedValueOnce(0);

      const result = await repository.upsertGuarded({
        bookingId: 'booking-uuid-001',
        status: 'PROCESSING',
        sourceVersion: 2, // stale or equal version
        airline: 'Vietnam Airlines',
        origin: 'SGN',
        destination: 'HAN',
        departureAt: new Date('2026-10-01T10:00:00.000Z'),
        arrivalAt: new Date('2026-10-01T12:00:00.000Z'),
        durationMinutes: 120,
        stopCount: 0,
      });

      expect(result).toEqual({ outcome: 'STALE_IGNORED' });
    });
  });

  describe('d) agentReference is stable and immutable: update never modifies existing agentReference', () => {
    it('does NOT include agentReference in DO UPDATE SET clause of SQL upsert', async () => {
      prisma.$executeRaw.mockResolvedValueOnce(1);

      await repository.upsertGuarded({
        bookingId: 'booking-uuid-001',
        status: 'CONFIRMED',
        sourceVersion: 2,
        airline: 'Vietnam Airlines',
        origin: 'SGN',
        destination: 'HAN',
        departureAt: new Date('2026-10-01T10:00:00.000Z'),
        arrivalAt: new Date('2026-10-01T12:00:00.000Z'),
        durationMinutes: 120,
        stopCount: 0,
      });

      const [strings] = prisma.$executeRaw.mock.calls[0];
      const sql = strings.join(' ');

      // Find the DO UPDATE SET section
      const doUpdateIndex = sql.indexOf('DO UPDATE');
      expect(doUpdateIndex).toBeGreaterThan(0);

      const updatePart = sql.substring(doUpdateIndex);
      // agentReference must NEVER be updated on conflict
      expect(updatePart).not.toContain('"agentReference" =');
      expect(updatePart).not.toContain('EXCLUDED."agentReference"');
    });

    it('preserves existing agentReference if explicitly passed', async () => {
      prisma.$executeRaw.mockResolvedValueOnce(1);

      const customRef = 'bkref_existing_custom_ref_123';
      await repository.upsertGuarded({
        bookingId: 'booking-uuid-001',
        agentReference: customRef,
        status: 'CONFIRMED',
        sourceVersion: 2,
        airline: 'Vietnam Airlines',
        origin: 'SGN',
        destination: 'HAN',
        departureAt: new Date('2026-10-01T10:00:00.000Z'),
        arrivalAt: new Date('2026-10-01T12:00:00.000Z'),
        durationMinutes: 120,
        stopCount: 0,
      });

      const values = prisma.$executeRaw.mock.calls[0].slice(1);
      expect(values).toContain(customRef);
    });
  });

  describe('e) findByBookingId and findByReferenceAndUserId methods', () => {
    it('findByBookingId queries by bookingId and returns projection', async () => {
      const mockProj = {
        bookingId: 'b_123',
        agentReference: 'bkref_test1',
        status: 'CONFIRMED',
        sourceVersion: 2,
      };
      prisma.bookingAgentProjection.findUnique.mockResolvedValueOnce(mockProj);

      const result = await repository.findByBookingId('b_123');

      expect(prisma.bookingAgentProjection.findUnique).toHaveBeenCalledWith({
        where: { bookingId: 'b_123' },
      });
      expect(result).toEqual(mockProj);
    });

    it('findByReferenceAndUserId returns projection when userId matches booking owner', async () => {
      const mockProjWithUser = {
        bookingId: 'b_123',
        agentReference: 'bkref_test1',
        status: 'CONFIRMED',
        sourceVersion: 2,
        booking: {
          userId: 'user_correct_owner',
        },
      };
      prisma.bookingAgentProjection.findUnique.mockResolvedValueOnce(mockProjWithUser);

      const result = await repository.findByReferenceAndUserId('bkref_test1', 'user_correct_owner');

      expect(prisma.bookingAgentProjection.findUnique).toHaveBeenCalledWith({
        where: { agentReference: 'bkref_test1' },
        include: {
          booking: {
            select: { userId: true },
          },
        },
      });
      expect(result).toEqual(mockProjWithUser);
    });

    it('findByReferenceAndUserId returns null when userId does not match booking owner', async () => {
      const mockProjWithUser = {
        bookingId: 'b_123',
        agentReference: 'bkref_test1',
        status: 'CONFIRMED',
        sourceVersion: 2,
        booking: {
          userId: 'user_different_owner',
        },
      };
      prisma.bookingAgentProjection.findUnique.mockResolvedValueOnce(mockProjWithUser);

      const result = await repository.findByReferenceAndUserId('bkref_test1', 'user_attacker');

      expect(result).toBeNull();
    });

    it('findByReferenceAndUserId returns null when projection is not found', async () => {
      prisma.bookingAgentProjection.findUnique.mockResolvedValueOnce(null);

      const result = await repository.findByReferenceAndUserId('bkref_non_existent', 'user_123');

      expect(result).toBeNull();
    });
  });
});
