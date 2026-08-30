import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  BookingFailureReason,
  BookingStatus,
  DisruptionActorType,
  DisruptionStatus,
  Prisma,
} from '@prisma/client';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingPipelineOutcome } from './booking-lifecycle.types';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';

describe('BookingLifecycleService', () => {
  let service: BookingLifecycleService;
  let mockPrisma: any;
  let mockProjectionService: any;

  beforeEach(() => {
    mockPrisma = {
      bookingIntent: {
        findUnique: jest.fn(),
      },
      booking: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      disruptionAuditEvent: {
        create: jest.fn(),
      },
      $transaction: jest.fn(async (cb) => cb(mockPrisma)),
    };

    mockProjectionService = {
      createOrUpdateProjection: jest.fn().mockResolvedValue(null),
      updateProjectionStatus: jest.fn().mockResolvedValue(null),
    };

    service = new BookingLifecycleService(mockPrisma, mockProjectionService);
  });

  describe('createBooking', () => {
    it('creates a processing booking when valid intent exists and user owns it', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      mockPrisma.booking.create.mockResolvedValue({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        totalAmount: '450.00',
        currency: 'GBP',
        status: BookingStatus.PROCESSING,
        paymentId: 'pay-1',
      });

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1');

      expect(result).toEqual(
        expect.objectContaining({
          id: 'booking-1',
          status: BookingStatus.PROCESSING,
        }),
      );
      expect(mockPrisma.booking.create).toHaveBeenCalledWith({
        data: {
          id: 'booking-1',
          userId: 'user-1',
          bookingIntentId: 'intent-1',
          totalAmount: '450.00',
          currency: 'GBP',
          status: BookingStatus.PROCESSING,
          paymentId: 'pay-1',
        },
      });
    });

    it('throws NotFoundException if booking intent does not exist', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue(null);

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException if booking intent belongs to another user', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-2',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('handles P2002 error and returns existing booking by intent for same user', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-existing',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: null,
      });
      mockPrisma.booking.update.mockResolvedValueOnce({
        id: 'booking-existing',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: 'pay-new',
      });

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-new');

      expect(result.id).toBe('booking-existing');
      expect(mockPrisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'booking-existing' },
        data: { paymentId: 'pay-new' },
      });
    });

    it('handles P2002 error and returns existing booking without update if paymentId already present', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-existing',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: 'pay-existing',
      });

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-new');

      expect(result.id).toBe('booking-existing');
      expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException on P2002 if existing booking by intent belongs to another user', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-existing',
        userId: 'user-other',
        bookingIntentId: 'intent-1',
      });

      await expect(
        service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('handles P2002 error when booking by ID exists for same user and intent', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      // First findUnique by bookingIntentId returns null
      mockPrisma.booking.findUnique.mockResolvedValueOnce(null);
      // Second findUnique by bookingId returns existing
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: null,
      });
      mockPrisma.booking.update.mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: 'pay-1',
      });

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1');

      expect(result.id).toBe('booking-1');
      expect(mockPrisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'booking-1' },
        data: { paymentId: 'pay-1' },
      });
    });

    it('throws ForbiddenException on P2002 when existing by ID belongs to another user', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockResolvedValueOnce(null);
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-other',
        bookingIntentId: 'intent-1',
      });

      await expect(
        service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException on P2002 when existing by ID has different bookingIntentId', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockResolvedValueOnce(null);
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-other',
      });

      await expect(
        service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rethrows generic errors', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      mockPrisma.booking.create.mockRejectedValue(new Error('DB connection failed'));

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toThrow(
        'DB connection failed',
      );
    });
  });

  describe('updateToConfirmed', () => {
    const flightSnapshot: FlightSnapshot = {
      segments: [
        {
          airline: { name: 'Airline', iataCode: 'AL' },
          flightNumber: '101',
          departureAirport: { iataCode: 'JFK', name: 'JFK Airport', city: 'New York' },
          arrivalAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
          departureAt: '2026-09-01T10:00:00.000Z',
          arrivalAt: '2026-09-01T22:00:00.000Z',
          duration: 'PT8H',
        },
      ],
      totalDuration: 'PT8H',
      stops: 0,
      cabinClass: 'economy',
    };

    const passengerSnapshot: PassengerSnapshot = {
      passengers: [
        {
          type: 'ADULT',
          firstName: 'John',
          lastName: 'Doe',
        },
      ],
      contactEmail: 'john@example.com',
    };

    it('throws BadRequestException if flightSnapshot has no segments', async () => {
      const invalidSnapshot = { ...flightSnapshot, segments: [] };
      await expect(
        service.updateToConfirmed('b-1', 'PNR1', 'ord-1', invalidSnapshot, passengerSnapshot),
      ).rejects.toThrow(BadRequestException);
    });

    it('updates booking to CONFIRMED and updates projection', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        pnrReference: 'PNR1',
        duffelOrderId: 'ord-1',
      });

      const result = await service.updateToConfirmed(
        'b-1',
        'PNR1',
        'ord-1',
        flightSnapshot,
        passengerSnapshot,
      );

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', status: { in: [BookingStatus.PROCESSING, BookingStatus.FAILED] } },
        data: {
          status: BookingStatus.CONFIRMED,
          failureReason: null,
          pnrReference: 'PNR1',
          duffelOrderId: 'ord-1',
          flightSnapshot: flightSnapshot as any,
          passengerSnapshot: passengerSnapshot as any,
          departureAt: new Date('2026-09-01T10:00:00.000Z'),
        },
      });
      expect(mockProjectionService.createOrUpdateProjection).toHaveBeenCalledWith(
        'b-1',
        mockPrisma,
      );
    });

    it('supports custom transaction client', async () => {
      const customTx: any = {
        booking: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({ id: 'b-1', status: BookingStatus.CONFIRMED }),
        },
      };

      await service.updateToConfirmed(
        'b-1',
        'PNR1',
        'ord-1',
        flightSnapshot,
        passengerSnapshot,
        customTx,
      );

      expect(customTx.booking.updateMany).toHaveBeenCalled();
      expect(mockProjectionService.createOrUpdateProjection).toHaveBeenCalledWith('b-1', customTx);
    });

    it('throws NotFoundException if booking not found after update', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.updateToConfirmed('b-1', 'PNR1', 'ord-1', flightSnapshot, passengerSnapshot),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateToFailed', () => {
    it('updates booking to FAILED with failureReason and updates projection status', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.FAILED,
        failureReason: BookingFailureReason.CAPTURE_FAILED,
      });

      const result = await service.updateToFailed('b-1', BookingFailureReason.CAPTURE_FAILED);

      expect(result.status).toBe(BookingStatus.FAILED);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', status: BookingStatus.PROCESSING },
        data: {
          status: BookingStatus.FAILED,
          failureReason: BookingFailureReason.CAPTURE_FAILED,
        },
      });
      expect(mockProjectionService.updateProjectionStatus).toHaveBeenCalledWith(
        'b-1',
        BookingStatus.FAILED,
        mockPrisma,
      );
    });

    it('throws NotFoundException if booking not found', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.updateToFailed('b-1', BookingFailureReason.SYSTEM_ERROR),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('applyPipelineOutcome', () => {
    const flightSnapshot: FlightSnapshot = {
      segments: [
        {
          airline: { name: 'Airline', iataCode: 'AL' },
          flightNumber: '101',
          departureAirport: { iataCode: 'JFK', name: 'JFK Airport', city: 'New York' },
          arrivalAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
          departureAt: '2026-09-01T10:00:00.000Z',
          arrivalAt: '2026-09-01T22:00:00.000Z',
          duration: 'PT8H',
        },
      ],
      totalDuration: 'PT8H',
      stops: 0,
      cabinClass: 'economy',
    };

    const passengerSnapshot: PassengerSnapshot = {
      passengers: [{ type: 'ADULT', firstName: 'John', lastName: 'Doe' }],
      contactEmail: 'john@example.com',
    };

    it('dispatches CONFIRMED outcome to updateToConfirmed', async () => {
      const outcome: BookingPipelineOutcome = {
        status: 'CONFIRMED',
        bookingId: 'b-1',
        paymentId: 'p-1',
        pnrReference: 'PNR123',
        duffelOrderId: 'ord-123',
        flightSnapshot,
        passengerSnapshot,
        occurredAt: '2026-08-23T10:00:00.000Z',
      };

      jest.spyOn(service, 'updateToConfirmed').mockResolvedValue({ id: 'b-1' } as any);

      await service.applyPipelineOutcome(outcome);

      expect(service.updateToConfirmed).toHaveBeenCalledWith(
        'b-1',
        'PNR123',
        'ord-123',
        flightSnapshot,
        passengerSnapshot,
        undefined,
      );
    });

    it('dispatches FAILED outcome to updateToFailed', async () => {
      const outcome: BookingPipelineOutcome = {
        status: 'FAILED',
        bookingId: 'b-1',
        paymentId: 'p-1',
        category: BookingFailureReason.CAPTURE_FAILED,
        partialState: {
          flightSnapshot,
          passengerSnapshot,
          departureAt: new Date('2026-09-01T10:00:00.000Z'),
        },
        occurredAt: '2026-08-23T10:00:00.000Z',
      };

      jest.spyOn(service, 'updateToFailed').mockResolvedValue({ id: 'b-1' } as any);

      await service.applyPipelineOutcome(outcome);

      expect(service.updateToFailed).toHaveBeenCalledWith(
        'b-1',
        BookingFailureReason.CAPTURE_FAILED,
        flightSnapshot,
        passengerSnapshot,
        expect.any(Date),
        undefined,
      );
    });
  });

  describe('checkAndCompleteBooking', () => {
    it('fetches booking with relations when given a string bookingId and completes it', async () => {
      const pastDeparture = new Date(Date.now() - 3600 * 1000);
      const bookingData: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: pastDeparture,
        currentFinalArrivalAt: null,
        disruptionStatus: null,
        activeDisruptionRevisionId: null,
      };

      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(bookingData) // Initial lookup by id
        .mockResolvedValueOnce(bookingData); // Transaction lookup
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.checkAndCompleteBooking('b-1');

      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(mockProjectionService.updateProjectionStatus).toHaveBeenCalledWith(
        'b-1',
        BookingStatus.COMPLETED,
        mockPrisma,
      );
    });

    it('throws NotFoundException when string bookingId is not found', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.checkAndCompleteBooking('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('does not complete booking if status is not CONFIRMED', async () => {
      const booking: any = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        departureAt: new Date(Date.now() - 3600 * 1000),
      };

      const result = await service.checkAndCompleteBooking(booking);

      expect(result.status).toBe(BookingStatus.PROCESSING);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    });

    it('does not complete booking if departure time is in the future', async () => {
      const booking: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: new Date(Date.now() + 3600 * 1000),
      };

      const result = await service.checkAndCompleteBooking(booking);

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    });

    it('completes booking and resolves active disruption when present', async () => {
      const pastArrival = new Date(Date.now() - 1000);
      const booking: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: new Date(Date.now() - 3600 * 1000),
        currentFinalArrivalAt: pastArrival,
        disruptionStatus: DisruptionStatus.DETECTED,
        activeDisruptionRevisionId: 'rev-1',
      };

      mockPrisma.booking.findUnique.mockResolvedValue(booking);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.checkAndCompleteBooking(booking);

      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(result.disruptionStatus).toBe(DisruptionStatus.RESOLVED);
      expect(result.disruptionResolvedReason).toBe('DEPARTURE_PASSED');
      expect(mockPrisma.disruptionAuditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bookingId: 'b-1',
          revisionId: 'rev-1',
          action: 'DEPARTURE_RESOLVED',
          fromStatus: DisruptionStatus.DETECTED,
          toStatus: DisruptionStatus.RESOLVED,
          actorType: DisruptionActorType.SYSTEM,
        }),
      });
    });

    it('handles race condition when booking status was changed concurrently in tx', async () => {
      const pastDeparture = new Date(Date.now() - 3600 * 1000);
      const booking: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: pastDeparture,
      };

      // db returns booking already changed to COMPLETED
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.COMPLETED,
        departureAt: pastDeparture,
      });

      const result = await service.checkAndCompleteBooking(booking);

      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(result.status).toBe(BookingStatus.CONFIRMED); // local untouched because tx did not update
    });
  });
});
