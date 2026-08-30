import { Test, TestingModule } from '@nestjs/testing';
import { SafeBookingReadService } from './safe-booking-read.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AgentToolAuditService } from '../audit/agent-tool-audit.service';
import { NotFoundException } from '@nestjs/common';

describe('SafeBookingReadService', () => {
  let service: SafeBookingReadService;
  let prismaService: {
    bookingAgentProjection: { findMany: jest.Mock; findUnique: jest.Mock };
    booking: { findMany: jest.Mock; findUnique: jest.Mock };
    payment: { findMany: jest.Mock; findUnique: jest.Mock };
  };
  let agentToolAuditService: { recordToolExecution: jest.Mock };

  beforeEach(async () => {
    prismaService = {
      bookingAgentProjection: { findMany: jest.fn(), findUnique: jest.fn() },
      booking: { findMany: jest.fn(), findUnique: jest.fn() },
      payment: { findMany: jest.fn(), findUnique: jest.fn() },
    };
    agentToolAuditService = {
      recordToolExecution: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SafeBookingReadService,
        { provide: PrismaService, useValue: prismaService },
        { provide: AgentToolAuditService, useValue: agentToolAuditService },
      ],
    }).compile();

    service = module.get<SafeBookingReadService>(SafeBookingReadService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getBookingSummaries', () => {
    it('returns booking summaries from BookingAgentProjection and structurally excludes raw entities', async () => {
      const mockProjections = [
        {
          agentReference: 'bkref_11111111-1111-4111-8111-111111111111',
          airline: 'Vietnam Airlines',
          origin: 'SGN',
          destination: 'HAN',
          departureAt: new Date('2026-09-01T08:00:00.000Z'),
          arrivalAt: new Date('2026-09-01T10:00:00.000Z'),
          status: 'CONFIRMED',
          durationMinutes: 120,
          stopCount: 0,
        },
      ];

      prismaService.bookingAgentProjection.findMany.mockResolvedValueOnce(mockProjections);

      const result = await service.getBookingSummaries('user-1', 'trace-1', 'correlation-1');

      expect(prismaService.bookingAgentProjection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { booking: { userId: 'user-1' } },
        }),
      );

      // Verify raw booking/payment models are NOT queried
      expect(prismaService.booking.findMany).not.toHaveBeenCalled();
      expect(prismaService.booking.findUnique).not.toHaveBeenCalled();
      expect(prismaService.payment.findMany).not.toHaveBeenCalled();
      expect(prismaService.payment.findUnique).not.toHaveBeenCalled();

      // Verify exact structure
      expect(result).toEqual({
        bookings: [
          {
            bookingReference: 'bkref_11111111-1111-4111-8111-111111111111',
            airline: 'Vietnam Airlines',
            origin: 'SGN',
            destination: 'HAN',
            departureTime: '2026-09-01T08:00:00.000Z',
            arrivalTime: '2026-09-01T10:00:00.000Z',
            status: 'CONFIRMED',
            durationMinutes: 120,
            stops: 0,
          },
        ],
      });

      // Assert forbidden properties are undefined on each booking object
      const forbiddenProps = [
        'id',
        'bookingId',
        'flightSnapshot',
        'passengerSnapshot',
        'Payment',
        'payment',
        'pnrReference',
        'totalAmount',
        'currency',
        'passengers',
      ];
      for (const prop of forbiddenProps) {
        expect((result.bookings[0] as any)[prop]).toBeUndefined();
      }

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'users/bookings/summaries',
          actorId: 'user-1',
          outcome: 'SUCCESS',
          traceId: 'trace-1',
          correlationId: 'correlation-1',
        }),
      );
    });

    it('returns empty array when user has no bookings', async () => {
      prismaService.bookingAgentProjection.findMany.mockResolvedValueOnce([]);

      const result = await service.getBookingSummaries('user-no-bookings');
      expect(result).toEqual({ bookings: [] });
    });

    it('logs FAILURE audit when database query fails', async () => {
      prismaService.bookingAgentProjection.findMany.mockRejectedValueOnce(
        new Error('DB query error'),
      );

      await expect(service.getBookingSummaries('user-1', 'trace-err', 'corr-err')).rejects.toThrow(
        'DB query error',
      );

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'users/bookings/summaries',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'INTERNAL_ERROR',
          traceId: 'trace-err',
          correlationId: 'corr-err',
        }),
      );
    });
  });

  describe('getBookingDetailByReference', () => {
    it('returns detail projection with flightNumber, baggageAllowance, changeable, refundable for owned booking', async () => {
      const mockProjection = {
        agentReference: 'bkref_11111111-1111-4111-8111-111111111111',
        airline: 'Vietnam Airlines',
        origin: 'SGN',
        destination: 'HAN',
        departureAt: new Date('2026-09-01T08:00:00.000Z'),
        arrivalAt: new Date('2026-09-01T10:00:00.000Z'),
        status: 'CONFIRMED',
        durationMinutes: 120,
        stopCount: 0,
        flightNumber: 'VN 123',
        baggageSummary: '20kg checked',
        changeable: true,
        refundable: false,
        booking: { userId: 'user-1' },
      };

      prismaService.bookingAgentProjection.findUnique.mockResolvedValueOnce(mockProjection);

      const result = await service.getBookingDetailByReference(
        'user-1',
        'bkref_11111111-1111-4111-8111-111111111111',
        'trace-2',
        'corr-2',
      );

      // Verify raw booking/payment models are NOT queried
      expect(prismaService.booking.findMany).not.toHaveBeenCalled();
      expect(prismaService.booking.findUnique).not.toHaveBeenCalled();
      expect(prismaService.payment.findMany).not.toHaveBeenCalled();
      expect(prismaService.payment.findUnique).not.toHaveBeenCalled();

      // Verify exact structure with detail tier fields
      expect(result).toEqual({
        bookingReference: 'bkref_11111111-1111-4111-8111-111111111111',
        airline: 'Vietnam Airlines',
        origin: 'SGN',
        destination: 'HAN',
        departureTime: '2026-09-01T08:00:00.000Z',
        arrivalTime: '2026-09-01T10:00:00.000Z',
        status: 'CONFIRMED',
        durationMinutes: 120,
        stops: 0,
        flightNumber: 'VN 123',
        baggageAllowance: '20kg checked',
        changeable: true,
        refundable: false,
      });

      // Assert forbidden properties are undefined on detail object
      const forbiddenProps = [
        'id',
        'bookingId',
        'flightSnapshot',
        'passengerSnapshot',
        'Payment',
        'payment',
        'pnrReference',
        'totalAmount',
        'currency',
        'passengers',
      ];
      for (const prop of forbiddenProps) {
        expect((result as any)[prop]).toBeUndefined();
      }

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'users/bookings/detail',
          actorId: 'user-1',
          outcome: 'SUCCESS',
          traceId: 'trace-2',
          correlationId: 'corr-2',
        }),
      );
    });

    it('rejects with NotFoundException BOOKING_REFERENCE_NOT_FOUND on malformed reference format', async () => {
      await expect(service.getBookingDetailByReference('user-1', 'invalid-ref')).rejects.toThrow(
        NotFoundException,
      );

      try {
        await service.getBookingDetailByReference('user-1', 'bkref_short');
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({ code: 'BOOKING_REFERENCE_NOT_FOUND' });
      }

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'users/bookings/detail',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'BOOKING_REFERENCE_NOT_FOUND',
        }),
      );
    });

    it('rejects with NotFoundException BOOKING_REFERENCE_NOT_FOUND on non-existent reference', async () => {
      prismaService.bookingAgentProjection.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.getBookingDetailByReference('user-1', 'bkref_99999999-9999-4999-8999-999999999999'),
      ).rejects.toThrow(NotFoundException);

      try {
        prismaService.bookingAgentProjection.findUnique.mockResolvedValueOnce(null);
        await service.getBookingDetailByReference(
          'user-1',
          'bkref_99999999-9999-4999-8999-999999999999',
        );
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({ code: 'BOOKING_REFERENCE_NOT_FOUND' });
      }
    });

    it('rejects with NotFoundException BOOKING_REFERENCE_NOT_FOUND on foreign reference (cross-owner access)', async () => {
      prismaService.bookingAgentProjection.findUnique.mockResolvedValueOnce({
        agentReference: 'bkref_11111111-1111-4111-8111-111111111111',
        airline: 'Vietnam Airlines',
        booking: { userId: 'user-2' },
      });

      await expect(
        service.getBookingDetailByReference('user-1', 'bkref_11111111-1111-4111-8111-111111111111'),
      ).rejects.toThrow(NotFoundException);

      try {
        prismaService.bookingAgentProjection.findUnique.mockResolvedValueOnce({
          agentReference: 'bkref_11111111-1111-4111-8111-111111111111',
          airline: 'Vietnam Airlines',
          booking: { userId: 'user-2' },
        });
        await service.getBookingDetailByReference(
          'user-1',
          'bkref_11111111-1111-4111-8111-111111111111',
        );
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({ code: 'BOOKING_REFERENCE_NOT_FOUND' });
      }
    });
  });

  describe('getUserBookings', () => {
    it('returns mapped user bookings and handles status mapping correctly', async () => {
      const mockBookings = [
        {
          id: 'booking-1',
          status: 'CONFIRMED',
          totalAmount: 150.5,
          currency: 'USD',
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          departureAt: new Date('2026-09-01T08:00:00.000Z'),
          flightSnapshot: {
            segments: [
              {
                airline: { iataCode: 'VN' },
                flightNumber: '123',
                departureAirport: { iataCode: 'SGN' },
                arrivalAirport: { iataCode: 'HAN' },
                departureAt: '2026-09-01T08:00:00.000Z',
                arrivalAt: '2026-09-01T10:00:00.000Z',
              },
            ],
            totalDuration: 'PT2H',
            stops: 0,
            fareClass: 'Economy',
            baggageAllowance: '20kg checked',
          },
          passengerSnapshot: {
            passengers: [{ name: 'Ada Lovelace' }],
          },
          payment: { status: 'SUCCEEDED' },
        },
        {
          id: 'booking-2',
          status: 'PROCESSING',
          totalAmount: 200,
          currency: 'USD',
          createdAt: new Date('2026-09-02T00:00:00.000Z'),
          flightSnapshot: null,
          passengerSnapshot: null,
          payment: { status: 'REFUNDED' },
        },
      ];

      prismaService.booking.findMany.mockResolvedValueOnce(mockBookings);

      const result = await service.getUserBookings('user-1', 'trace-3', 'corr-3');

      expect(result.bookings).toHaveLength(2);
      expect(result.bookings[0]).toEqual({
        id: 'booking-1',
        airline: 'VN',
        flightNumber: '123',
        origin: 'SGN',
        destination: 'HAN',
        departureTime: '2026-09-01T08:00:00.000Z',
        arrivalTime: '2026-09-01T10:00:00.000Z',
        duration: 120,
        stops: 0,
        fareClass: 'Economy',
        price: 150.5,
        currency: 'USD',
        passengers: 1,
        baggageAllowance: '20kg checked',
        status: 'CONFIRMED',
      });
      expect(result.bookings[1].status).toBe('REFUNDED');

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'users/bookings',
          actorId: 'user-1',
          outcome: 'SUCCESS',
          traceId: 'trace-3',
          correlationId: 'corr-3',
        }),
      );
    });

    it('logs FAILURE audit when getUserBookings query fails', async () => {
      prismaService.booking.findMany.mockRejectedValueOnce(new Error('DB failure'));

      await expect(service.getUserBookings('user-1', 'trace-err', 'corr-err')).rejects.toThrow(
        'DB failure',
      );

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'users/bookings',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'INTERNAL_ERROR',
        }),
      );
    });
  });
});
