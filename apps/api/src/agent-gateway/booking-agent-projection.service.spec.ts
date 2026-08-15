import { BookingAgentProjectionService } from './booking-agent-projection.service';
import { PrismaService } from '@/prisma/prisma.service';

describe('BookingAgentProjectionService', () => {
  let service: BookingAgentProjectionService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      booking: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      bookingAgentProjection: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    service = new BookingAgentProjectionService(prisma as unknown as PrismaService);
  });

  describe('generateAgentReference', () => {
    it('generates a reference prefixed with bkref_ and a valid uuid', () => {
      const ref1 = service.generateAgentReference();
      const ref2 = service.generateAgentReference();

      expect(ref1).toMatch(/^bkref_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(ref2).toMatch(/^bkref_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(ref1).not.toBe(ref2);
    });
  });

  describe('extractProjectionData', () => {
    it('extracts flight data from active itineraryRevisions with priority', () => {
      const booking = {
        itineraryRevisions: [
          {
            version: 1,
            segments: [
              {
                departureAirportIata: 'SGN',
                arrivalAirportIata: 'HAN',
                departureAt: new Date('2026-09-01T10:00:00Z'),
                arrivalAt: new Date('2026-09-01T12:00:00Z'),
                airlineName: 'Vietnam Airlines',
                marketingCarrierIata: 'VN',
                flightNumber: '123',
              },
            ],
          },
        ],
        flightSnapshot: null,
      };

      const result = service.extractProjectionData(booking);
      expect(result).toEqual({
        airline: 'Vietnam Airlines',
        origin: 'SGN',
        destination: 'HAN',
        departureAt: new Date('2026-09-01T10:00:00Z'),
        arrivalAt: new Date('2026-09-01T12:00:00Z'),
        durationMinutes: 120,
        stopCount: 0,
        flightNumber: 'VN 123',
        baggageSummary: null,
        refundable: null,
        changeable: null,
      });
    });

    it('extracts fallback flight data from legacy flightSnapshot JSON', () => {
      const booking = {
        itineraryRevisions: [],
        flightSnapshot: {
          stops: 1,
          baggageAllowance: '1 checked bag',
          segments: [
            {
              departureAirport: { iataCode: 'LHR' },
              arrivalAirport: { iataCode: 'DOH' },
              departureAt: '2026-10-01T08:00:00Z',
              arrivalAt: '2026-10-01T14:00:00Z',
              airline: { name: 'Qatar Airways', iataCode: 'QR' },
              flightNumber: '10',
            },
            {
              departureAirport: { iataCode: 'DOH' },
              arrivalAirport: { iataCode: 'BKK' },
              departureAt: '2026-10-01T16:00:00Z',
              arrivalAt: '2026-10-01T23:00:00Z',
              airline: { name: 'Qatar Airways', iataCode: 'QR' },
              flightNumber: '830',
            },
          ],
        },
      };

      const result = service.extractProjectionData(booking);
      expect(result).toEqual({
        airline: 'Qatar Airways',
        origin: 'LHR',
        destination: 'BKK',
        departureAt: new Date('2026-10-01T08:00:00Z'),
        arrivalAt: new Date('2026-10-01T23:00:00Z'),
        durationMinutes: 900,
        stopCount: 1,
        flightNumber: 'QR 10',
        baggageSummary: '1 checked bag',
        refundable: null,
        changeable: null,
      });
    });

    it('never contains forbidden fields in the projection data', () => {
      const booking = {
        id: 'book-secret-uuid',
        pnrReference: 'PNR999',
        totalAmount: '500.00',
        currency: 'USD',
        passengerCount: 2,
        contactEmail: 'user@test.com',
        contactPhone: '+1234567890',
        passengers: [{ firstName: 'John', lastName: 'Doe' }],
        payment: { stripePaymentIntentId: 'pi_secret' },
        itineraryRevisions: [
          {
            segments: [
              {
                departureAirportIata: 'JFK',
                arrivalAirportIata: 'LAX',
                departureAt: new Date('2026-09-01T10:00:00Z'),
                arrivalAt: new Date('2026-09-01T16:00:00Z'),
                airlineName: 'Delta',
                marketingCarrierIata: 'DL',
                flightNumber: '100',
              },
            ],
          },
        ],
      };

      const result: any = service.extractProjectionData(booking);

      expect(result.pnrReference).toBeUndefined();
      expect(result.totalAmount).toBeUndefined();
      expect(result.currency).toBeUndefined();
      expect(result.passengerCount).toBeUndefined();
      expect(result.contactEmail).toBeUndefined();
      expect(result.contactPhone).toBeUndefined();
      expect(result.passengers).toBeUndefined();
      expect(result.payment).toBeUndefined();
      expect(result.id).toBeUndefined();
    });
  });

  describe('createOrUpdateProjection', () => {
    it('creates a new projection with generated reference if none exists', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        id: 'booking-1',
        status: 'CONFIRMED',
        itineraryRevisions: [
          {
            segments: [
              {
                departureAirportIata: 'SGN',
                arrivalAirportIata: 'HAN',
                departureAt: new Date('2026-09-01T10:00:00Z'),
                arrivalAt: new Date('2026-09-01T12:00:00Z'),
                airlineName: 'Vietnam Airlines',
                marketingCarrierIata: 'VN',
                flightNumber: '123',
              },
            ],
          },
        ],
      });
      prisma.bookingAgentProjection.findUnique.mockResolvedValue(null);
      prisma.bookingAgentProjection.upsert.mockImplementation(({ create }: any) => ({
        ...create,
      }));

      const res = await service.createOrUpdateProjection('booking-1');

      expect(res).toBeDefined();
      expect(res?.agentReference).toMatch(/^bkref_/);
      expect(res?.status).toBe('CONFIRMED');
      expect(res?.airline).toBe('Vietnam Airlines');
      expect(prisma.bookingAgentProjection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { bookingId: 'booking-1' },
          create: expect.objectContaining({
            bookingId: 'booking-1',
            status: 'CONFIRMED',
            airline: 'Vietnam Airlines',
          }),
        }),
      );
    });

    it('preserves existing agentReference when updating an existing projection', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        id: 'booking-1',
        status: 'CONFIRMED',
        itineraryRevisions: [
          {
            segments: [
              {
                departureAirportIata: 'SGN',
                arrivalAirportIata: 'HAN',
                departureAt: new Date('2026-09-01T10:00:00Z'),
                arrivalAt: new Date('2026-09-01T12:00:00Z'),
                airlineName: 'Vietnam Airlines',
                marketingCarrierIata: 'VN',
                flightNumber: '123',
              },
            ],
          },
        ],
      });
      prisma.bookingAgentProjection.findUnique.mockResolvedValue({
        bookingId: 'booking-1',
        agentReference: 'bkref_existing_123',
      });
      prisma.bookingAgentProjection.upsert.mockImplementation(({ create }: any) => ({
        ...create,
      }));

      const res = await service.createOrUpdateProjection('booking-1');

      expect(res?.agentReference).toBe('bkref_existing_123');
    });

    it('supports custom transaction client', async () => {
      const txClient = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'booking-tx',
            status: 'CONFIRMED',
            itineraryRevisions: [
              {
                segments: [
                  {
                    departureAirportIata: 'SGN',
                    arrivalAirportIata: 'HAN',
                    departureAt: new Date('2026-09-01T10:00:00Z'),
                    arrivalAt: new Date('2026-09-01T12:00:00Z'),
                    airlineName: 'Vietnam Airlines',
                    marketingCarrierIata: 'VN',
                    flightNumber: '123',
                  },
                ],
              },
            ],
          }),
        },
        bookingAgentProjection: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({ bookingId: 'booking-tx', agentReference: 'bkref_tx' }),
        },
      };

      const res = await service.createOrUpdateProjection('booking-tx', txClient as any);

      expect(res?.bookingId).toBe('booking-tx');
      expect(txClient.booking.findUnique).toHaveBeenCalledWith({
        where: { id: 'booking-tx' },
        include: expect.any(Object),
      });
      expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('updateProjectionStatus', () => {
    it('updates status via updateMany and returns updated projection from findUnique', async () => {
      prisma.bookingAgentProjection.updateMany.mockResolvedValue({ count: 1 });
      prisma.bookingAgentProjection.findUnique.mockResolvedValue({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        agentReference: 'bkref_1',
      });

      const res = await service.updateProjectionStatus('booking-1', 'CANCELLED');

      expect(prisma.bookingAgentProjection.updateMany).toHaveBeenCalledWith({
        where: { bookingId: 'booking-1' },
        data: { status: 'CANCELLED' },
      });
      expect(prisma.bookingAgentProjection.findUnique).toHaveBeenCalledWith({
        where: { bookingId: 'booking-1' },
      });
      expect(res).toEqual({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        agentReference: 'bkref_1',
      });
    });

    it('falls back to createOrUpdateProjection when updateMany count is 0', async () => {
      prisma.bookingAgentProjection.updateMany.mockResolvedValue({ count: 0 });
      const fallbackSpy = jest.spyOn(service, 'createOrUpdateProjection').mockResolvedValue({
        bookingId: 'missing-booking',
        agentReference: 'bkref_fallback_123',
        status: 'CANCELLED',
      } as any);

      const res = await service.updateProjectionStatus('missing-booking', 'CANCELLED');

      expect(prisma.bookingAgentProjection.updateMany).toHaveBeenCalledWith({
        where: { bookingId: 'missing-booking' },
        data: { status: 'CANCELLED' },
      });
      expect(fallbackSpy).toHaveBeenCalledWith('missing-booking', prisma);
      expect(res?.bookingId).toBe('missing-booking');
      expect(res?.agentReference).toBe('bkref_fallback_123');
    });

    it('falls back to createOrUpdateProjection with txClient when provided and count is 0', async () => {
      const txClient = {
        bookingAgentProjection: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findUnique: jest.fn(),
        },
      };
      const fallbackSpy = jest.spyOn(service, 'createOrUpdateProjection').mockResolvedValue({
        bookingId: 'tx-booking',
        agentReference: 'bkref_tx_123',
        status: 'COMPLETED',
      } as any);

      const res = await service.updateProjectionStatus('tx-booking', 'COMPLETED', txClient as any);

      expect(txClient.bookingAgentProjection.updateMany).toHaveBeenCalledWith({
        where: { bookingId: 'tx-booking' },
        data: { status: 'COMPLETED' },
      });
      expect(fallbackSpy).toHaveBeenCalledWith('tx-booking', txClient);
      expect(res?.bookingId).toBe('tx-booking');
      expect(res?.status).toBe('COMPLETED');
    });

    it('returns null if updateMany count is 0 and fallback createOrUpdateProjection also returns null', async () => {
      prisma.bookingAgentProjection.updateMany.mockResolvedValue({ count: 0 });
      jest.spyOn(service, 'createOrUpdateProjection').mockResolvedValue(null);

      const res = await service.updateProjectionStatus('missing-booking', 'CANCELLED');
      expect(res).toBeNull();
    });
  });

  describe('getProjectionByReference', () => {
    it('returns projection if owned by userId', async () => {
      prisma.bookingAgentProjection.findUnique.mockResolvedValue({
        bookingId: 'booking-1',
        agentReference: 'bkref_valid',
        status: 'CONFIRMED',
        booking: { userId: 'user-123' },
      });

      const res = await service.getProjectionByReference('bkref_valid', 'user-123');
      expect(res).toBeDefined();
      expect(res?.agentReference).toBe('bkref_valid');
    });

    it('returns null if owned by a different user', async () => {
      prisma.bookingAgentProjection.findUnique.mockResolvedValue({
        bookingId: 'booking-1',
        agentReference: 'bkref_valid',
        status: 'CONFIRMED',
        booking: { userId: 'user-foreign' },
      });

      const res = await service.getProjectionByReference('bkref_valid', 'user-123');
      expect(res).toBeNull();
    });

    it('returns null if reference does not exist', async () => {
      prisma.bookingAgentProjection.findUnique.mockResolvedValue(null);

      const res = await service.getProjectionByReference('bkref_unknown', 'user-123');
      expect(res).toBeNull();
    });
  });
});
