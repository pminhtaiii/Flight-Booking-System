import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  BookingFailureReason,
  BookingStatus,
  DisruptionActorType,
  DisruptionStatus,
  Prisma,
} from '@prisma/client';
import {
  BookingCreatedEvent,
  BookingConfirmedEvent,
  BookingFailedEvent,
  BookingCompletedEvent,
  TransactionEventContext,
} from '@/domain-events';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingPipelineOutcome } from './booking-lifecycle.types';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';

describe('BookingLifecycleService', () => {
  let service: BookingLifecycleService;
  let mockPrisma: any;
  let mockPublisher: any;
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

    mockPublisher = {
      createContext: jest.fn((tx) => ({ tx, events: [] })),
      publish: jest.fn().mockResolvedValue(undefined),
    };

    mockProjectionService = {
      createOrUpdateProjection: jest.fn().mockResolvedValue(null),
      updateProjectionStatus: jest.fn().mockResolvedValue(null),
    };

    service = new BookingLifecycleService(mockPrisma, mockPublisher, mockProjectionService);
  });

  describe('createBooking', () => {
    it('creates version 1 booking and emits BookingCreatedEvent standalone post-commit', async () => {
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
        version: 1,
      });

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1');

      expect(result).toEqual(
        expect.objectContaining({
          id: 'booking-1',
          status: BookingStatus.PROCESSING,
          version: 1,
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
          version: 1,
        },
      });
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const emittedEvents = mockPublisher.publish.mock.calls[0][0];
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toBeInstanceOf(BookingCreatedEvent);
      expect(emittedEvents[0]).toEqual(
        expect.objectContaining({
          bookingId: 'booking-1',
          sourceVersion: 1,
          status: BookingStatus.PROCESSING,
        }),
      );
    });

    it('appends BookingCreatedEvent to context.events and does NOT call publisher.publish when context provided', async () => {
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
        version: 1,
      });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.createBooking(
        'user-1',
        'booking-1',
        'intent-1',
        undefined,
        context,
      );

      expect(result.id).toBe('booking-1');
      expect(context.events).toHaveLength(1);
      expect(context.events[0]).toBeInstanceOf(BookingCreatedEvent);
      expect(context.events[0]).toEqual(
        expect.objectContaining({
          bookingId: 'booking-1',
          sourceVersion: 1,
        }),
      );
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if booking intent does not exist', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue(null);

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPublisher.publish).not.toHaveBeenCalled();
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
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('handles P2002 error, attaches paymentId to existing booking without version increment, and emits ZERO events', async () => {
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
        version: 1,
      });
      mockPrisma.booking.update.mockResolvedValueOnce({
        id: 'booking-existing',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: 'pay-new',
        version: 1,
      });

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-new');

      expect(result.id).toBe('booking-existing');
      expect(mockPrisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'booking-existing' },
        data: { paymentId: 'pay-new' },
      });
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('handles P2002 duplicate replay when paymentId already present, returns existing booking without increment, and emits ZERO events', async () => {
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
        version: 1,
      });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.createBooking(
        'user-1',
        'booking-1',
        'intent-1',
        'pay-new',
        context,
      );

      expect(result.id).toBe('booking-existing');
      expect(mockPrisma.booking.update).not.toHaveBeenCalled();
      expect(context.events).toHaveLength(0);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
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
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('handles P2002 error when booking by ID exists for same user and intent, attaching paymentId without increment and zero events', async () => {
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
        bookingIntentId: 'intent-1',
        paymentId: null,
        version: 1,
      });
      mockPrisma.booking.update.mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: 'pay-1',
        version: 1,
      });

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1');

      expect(result.id).toBe('booking-1');
      expect(mockPrisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'booking-1' },
        data: { paymentId: 'pay-1' },
      });
      expect(mockPublisher.publish).not.toHaveBeenCalled();
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
      expect(mockPublisher.publish).not.toHaveBeenCalled();
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
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('rethrows generic errors and emits zero events', async () => {
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
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });

  describe('updateToConfirmed & confirmBooking', () => {
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
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('updates booking to CONFIRMED, increments version by 1, and produces BookingConfirmedEvent standalone', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        pnrReference: 'PNR1',
        duffelOrderId: 'ord-1',
        version: 2,
      });

      const result = await service.updateToConfirmed(
        'b-1',
        'PNR1',
        'ord-1',
        flightSnapshot,
        passengerSnapshot,
      );

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(result.version).toBe(2);
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
          version: { increment: 1 },
        },
      });
      expect(mockProjectionService.createOrUpdateProjection).toHaveBeenCalledWith(
        'b-1',
        mockPrisma,
      );
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const emitted = mockPublisher.publish.mock.calls[0][0];
      expect(emitted[0]).toBeInstanceOf(BookingConfirmedEvent);
      expect(emitted[0]).toEqual(
        expect.objectContaining({
          bookingId: 'b-1',
          sourceVersion: 2,
          status: BookingStatus.CONFIRMED,
        }),
      );
    });

    it('confirmBooking alias delegates to updateToConfirmed and behaves identically', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        pnrReference: 'PNR1',
        duffelOrderId: 'ord-1',
        version: 2,
      });

      const result = await service.confirmBooking(
        'b-1',
        'PNR1',
        'ord-1',
        flightSnapshot,
        passengerSnapshot,
      );

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
    });

    it('appends event to context.events and does NOT call publisher.publish when context provided', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        version: 2,
      });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.updateToConfirmed(
        'b-1',
        'PNR1',
        'ord-1',
        flightSnapshot,
        passengerSnapshot,
        undefined,
        context,
      );

      expect(result.id).toBe('b-1');
      expect(context.events).toHaveLength(1);
      expect(context.events[0]).toBeInstanceOf(BookingConfirmedEvent);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('supports custom transaction client without context and calls publisher.publish', async () => {
      const customTx: any = {
        booking: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({ id: 'b-1', status: BookingStatus.CONFIRMED, version: 2 }),
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
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      expect(mockPublisher.publish).toHaveBeenCalledWith([expect.any(BookingConfirmedEvent)]);
    });

    it('does not construct or emit event on rejected/no-op update (0 rows updated)', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        version: 2,
      });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.updateToConfirmed(
        'b-1',
        'PNR1',
        'ord-1',
        flightSnapshot,
        passengerSnapshot,
        undefined,
        context,
      );

      expect(result.id).toBe('b-1');
      expect(context.events).toHaveLength(0);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if booking not found after update', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.updateToConfirmed('b-1', 'PNR1', 'ord-1', flightSnapshot, passengerSnapshot),
      ).rejects.toThrow(NotFoundException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });

  describe('updateToFailed & failBooking', () => {
    it('updates booking to FAILED with failureReason, increments version, and emits BookingFailedEvent', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.FAILED,
        failureReason: BookingFailureReason.CAPTURE_FAILED,
        version: 2,
      });

      const result = await service.updateToFailed('b-1', BookingFailureReason.CAPTURE_FAILED);

      expect(result.status).toBe(BookingStatus.FAILED);
      expect(result.version).toBe(2);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', status: BookingStatus.PROCESSING },
        data: {
          status: BookingStatus.FAILED,
          failureReason: BookingFailureReason.CAPTURE_FAILED,
          version: { increment: 1 },
        },
      });
      expect(mockProjectionService.updateProjectionStatus).toHaveBeenCalledWith(
        'b-1',
        BookingStatus.FAILED,
        mockPrisma,
      );
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const emitted = mockPublisher.publish.mock.calls[0][0];
      expect(emitted[0]).toBeInstanceOf(BookingFailedEvent);
      expect(emitted[0]).toEqual(
        expect.objectContaining({
          bookingId: 'b-1',
          sourceVersion: 2,
          status: BookingStatus.FAILED,
          failureReason: BookingFailureReason.CAPTURE_FAILED,
        }),
      );
    });

    it('failBooking alias delegates to updateToFailed and behaves identically', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.FAILED,
        failureReason: BookingFailureReason.CAPTURE_FAILED,
        version: 2,
      });

      const result = await service.failBooking('b-1', BookingFailureReason.CAPTURE_FAILED);

      expect(result.status).toBe(BookingStatus.FAILED);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
    });

    it('appends event to context.events and does NOT call publisher.publish when context provided', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.FAILED,
        failureReason: BookingFailureReason.CAPTURE_FAILED,
        version: 2,
      });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.updateToFailed(
        'b-1',
        BookingFailureReason.CAPTURE_FAILED,
        undefined,
        undefined,
        undefined,
        undefined,
        context,
      );

      expect(result.id).toBe('b-1');
      expect(context.events).toHaveLength(1);
      expect(context.events[0]).toBeInstanceOf(BookingFailedEvent);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('emits ZERO events on rejected/no-op fail on already CONFIRMED or COMPLETED booking', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        version: 2,
      });

      const result = await service.updateToFailed('b-1', BookingFailureReason.SYSTEM_ERROR);

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if booking not found', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.updateToFailed('b-1', BookingFailureReason.SYSTEM_ERROR),
      ).rejects.toThrow(NotFoundException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
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

  describe('checkAndCompleteBooking & completeBooking', () => {
    it('fetches booking with relations when given a string bookingId, completes it with version increment and BookingCompletedEvent standalone', async () => {
      const pastDeparture = new Date(Date.now() - 3600 * 1000);
      const bookingData: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: pastDeparture,
        currentFinalArrivalAt: null,
        disruptionStatus: null,
        activeDisruptionRevisionId: null,
        version: 1,
      };

      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(bookingData) // Initial lookup by id
        .mockResolvedValueOnce(bookingData); // Transaction lookup
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.checkAndCompleteBooking('b-1');

      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(result.version).toBe(2);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'b-1',
          status: BookingStatus.CONFIRMED,
          currentFinalArrivalAt: null,
          departureAt: pastDeparture,
        },
        data: {
          status: BookingStatus.COMPLETED,
          version: { increment: 1 },
        },
      });
      expect(mockProjectionService.updateProjectionStatus).toHaveBeenCalledWith(
        'b-1',
        BookingStatus.COMPLETED,
        mockPrisma,
      );
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const emitted = mockPublisher.publish.mock.calls[0][0];
      expect(emitted[0]).toBeInstanceOf(BookingCompletedEvent);
      expect(emitted[0]).toEqual(
        expect.objectContaining({
          bookingId: 'b-1',
          sourceVersion: 2,
          status: BookingStatus.COMPLETED,
        }),
      );
    });

    it('completeBooking alias delegates to checkAndCompleteBooking and behaves identically', async () => {
      const pastDeparture = new Date(Date.now() - 3600 * 1000);
      const bookingData: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: pastDeparture,
        currentFinalArrivalAt: null,
        disruptionStatus: null,
        activeDisruptionRevisionId: null,
        version: 1,
      };

      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(bookingData)
        .mockResolvedValueOnce(bookingData);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.completeBooking('b-1');

      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
    });

    it('appends BookingCompletedEvent to context.events and does NOT call publisher.publish when context provided', async () => {
      const pastDeparture = new Date(Date.now() - 3600 * 1000);
      const bookingData: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: pastDeparture,
        currentFinalArrivalAt: null,
        disruptionStatus: null,
        activeDisruptionRevisionId: null,
        version: 1,
      };

      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(bookingData)
        .mockResolvedValueOnce(bookingData);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.checkAndCompleteBooking('b-1', context);

      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(context.events).toHaveLength(1);
      expect(context.events[0]).toBeInstanceOf(BookingCompletedEvent);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when string bookingId is not found', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.checkAndCompleteBooking('non-existent')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('does not complete booking or emit events if status is not CONFIRMED', async () => {
      const booking: any = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        departureAt: new Date(Date.now() - 3600 * 1000),
      };

      const result = await service.checkAndCompleteBooking(booking);

      expect(result.status).toBe(BookingStatus.PROCESSING);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('does not complete booking or emit events if departure time is in the future', async () => {
      const booking: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: new Date(Date.now() + 3600 * 1000),
      };

      const result = await service.checkAndCompleteBooking(booking);

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
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
        version: 1,
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
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      expect(mockPublisher.publish.mock.calls[0][0][0]).toBeInstanceOf(BookingCompletedEvent);
    });

    it('handles race condition when booking status was changed concurrently in tx and emits zero events', async () => {
      const pastDeparture = new Date(Date.now() - 3600 * 1000);
      const booking: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: pastDeparture,
        version: 1,
      };

      // db returns booking already changed to COMPLETED
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.COMPLETED,
        departureAt: pastDeparture,
        version: 2,
      });

      const result = await service.checkAndCompleteBooking(booking);

      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(result.status).toBe(BookingStatus.CONFIRMED); // local untouched because tx did not update
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });
});
