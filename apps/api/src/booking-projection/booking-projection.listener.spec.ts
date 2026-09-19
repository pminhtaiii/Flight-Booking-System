import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BookingProjectionListener } from './booking-projection.listener';
import { BookingProjectionMetrics } from './booking-projection.metrics';
import { BookingProjectionService, MalformedRevisionError, SafeBookingProjectionData } from './booking-projection.service';
import { BookingProjectionRepository } from './booking-projection.repository';
import { BookingEventHydratorService, CoherentBookingSnapshot } from '@/domain-events/booking-event-hydrator.service';
import { BookingCreatedEvent, BookingConfirmedEvent } from '@/domain-events/booking.events';
import { RefundSettledEvent } from '@/domain-events/refund.events';

describe('BookingProjectionListener', () => {
  let listener: BookingProjectionListener;
  let hydrator: jest.Mocked<BookingEventHydratorService>;
  let projectionService: jest.Mocked<BookingProjectionService>;
  let repository: jest.Mocked<BookingProjectionRepository>;
  let metrics: BookingProjectionMetrics;

  const mockDate = new Date('2026-09-17T12:00:00.000Z');

  const createMockSnapshot = (overrides: Partial<CoherentBookingSnapshot> = {}): CoherentBookingSnapshot => {
    return {
      id: 'bk_valid_001',
      bookingReference: 'REF123',
      userId: 'usr_001',
      status: 'PROCESSING',
      version: 5,
      totalAmount: 10000,
      currency: 'USD',
      flightSnapshot: null,
      createdAt: mockDate,
      updatedAt: mockDate,
      itineraryRevisions: [
        {
          id: 'rev_1',
          bookingId: 'bk_valid_001',
          version: 1,
          createdAt: mockDate,
          segments: [
            {
              id: 'seg_1',
              revisionId: 'rev_1',
              globalOrder: 0,
              departureAirportIata: 'SFO',
              arrivalAirportIata: 'JFK',
              departureAt: new Date('2026-09-18T10:00:00Z'),
              arrivalAt: new Date('2026-09-18T18:00:00Z'),
              airlineName: 'Delta',
              flightNumber: '100',
              marketingCarrierIata: 'DL',
              operatingCarrierIata: 'DL',
              cabinClass: 'economy',
              createdAt: mockDate,
              updatedAt: mockDate,
            },
          ],
        },
      ],
      ...overrides,
    } as unknown as CoherentBookingSnapshot;
  };

  const mockSafeData: SafeBookingProjectionData = {
    airline: 'Delta',
    origin: 'SFO',
    destination: 'JFK',
    departureAt: new Date('2026-09-18T10:00:00Z'),
    arrivalAt: new Date('2026-09-18T18:00:00Z'),
    durationMinutes: 480,
    stopCount: 0,
    flightNumber: 'DL 100',
    baggageSummary: null,
    refundable: null,
    changeable: null,
  };

  beforeEach(async () => {
    const hydratorMock = {
      hydrate: jest.fn(),
    };

    const projectionServiceMock = {
      extractProjectionData: jest.fn(),
      generateAgentReference: jest.fn(),
    };

    const repositoryMock = {
      upsertGuarded: jest.fn(),
      upsertProjection: jest.fn(),
      findByBookingId: jest.fn(),
      findByReferenceAndUserId: jest.fn(),
    };

    metrics = new BookingProjectionMetrics();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingProjectionListener,
        { provide: BookingEventHydratorService, useValue: hydratorMock },
        { provide: BookingProjectionService, useValue: projectionServiceMock },
        { provide: BookingProjectionRepository, useValue: repositoryMock },
        { provide: BookingProjectionMetrics, useValue: metrics },
      ],
    }).compile();

    listener = module.get<BookingProjectionListener>(BookingProjectionListener);
    hydrator = module.get(BookingEventHydratorService);
    projectionService = module.get(BookingProjectionService);
    repository = module.get(BookingProjectionRepository);
  });

  describe('a) Successfully handles booking event through hydrate -> extract -> upsertGuarded', () => {
    it('handles BookingCreatedEvent and passes snapshot.version to upsertGuarded', async () => {
      const event = new BookingCreatedEvent({
        bookingId: 'bk_valid_001',
        eventId: 'evt_create_001',
        sourceVersion: 2, // Note: snapshot may have higher/committed version
        timestamp: mockDate,
      });

      const snapshot = createMockSnapshot({ version: 5, status: 'PROCESSING' });
      hydrator.hydrate.mockResolvedValue(snapshot);
      projectionService.extractProjectionData.mockReturnValue(mockSafeData);
      repository.upsertGuarded.mockResolvedValue({ outcome: 'SUCCESS' });

      await listener.handleBookingEvent(event);

      expect(hydrator.hydrate).toHaveBeenCalledWith('bk_valid_001', 2, event.eventId);
      expect(projectionService.extractProjectionData).toHaveBeenCalledWith(snapshot);
      expect(repository.upsertGuarded).toHaveBeenCalledWith({
        bookingId: 'bk_valid_001',
        status: 'PROCESSING',
        sourceVersion: 5, // Uses snapshot.version, not event.sourceVersion!
        data: mockSafeData,
      });

      expect(metrics.getEventsTotal('booking.created', 'SUCCESS')).toBe(1);
      expect(metrics.getEventsTotal('booking.created', 'ERROR')).toBe(0);
      expect(metrics.getDurations().length).toBe(1);
    });

    it('handles BookingConfirmedEvent successfully', async () => {
      const event = new BookingConfirmedEvent({
        bookingId: 'bk_valid_002',
        eventId: 'evt_confirm_001',
        sourceVersion: 3,
      });

      const snapshot = createMockSnapshot({ id: 'bk_valid_002', version: 3, status: 'CONFIRMED' });
      hydrator.hydrate.mockResolvedValue(snapshot);
      projectionService.extractProjectionData.mockReturnValue(mockSafeData);
      repository.upsertGuarded.mockResolvedValue({ outcome: 'SUCCESS' });

      await listener.handleBookingEvent(event);

      expect(hydrator.hydrate).toHaveBeenCalledWith('bk_valid_002', 3, event.eventId);
      expect(repository.upsertGuarded).toHaveBeenCalledWith({
        bookingId: 'bk_valid_002',
        status: 'CONFIRMED',
        sourceVersion: 3,
        data: mockSafeData,
      });
      expect(metrics.getEventsTotal('booking.confirmed', 'SUCCESS')).toBe(1);
    });
  });

  describe('b) Confirms only booking.* events are subscribed; refund.settled is NOT subscribed', () => {
    it('verifies OnEvent decorator metadata targets booking.** and strictly excludes refund.settled', () => {
      const metadata = Reflect.getMetadata('EVENT_LISTENER_METADATA', BookingProjectionListener.prototype.handleBookingEvent);
      expect(metadata).toBeDefined();
      expect(Array.isArray(metadata)).toBe(true);
      expect(metadata.length).toBeGreaterThan(0);

      const subscribedPatterns = metadata.flatMap((m: any) =>
        Array.isArray(m.event) ? m.event : [m.event],
      );
      expect(subscribedPatterns).toContain('booking.**');

      // Assert no subscription to refund.settled or refund.*
      for (const pattern of subscribedPatterns) {
        expect(pattern).not.toBe('refund.settled');
        expect(pattern).not.toBe('refund.*');
      }
      expect(subscribedPatterns).not.toContain('refund.settled');
      expect(subscribedPatterns).not.toContain('refund.*');
    });

    it('dispatches only booking events including multi-segment through EventEmitter2 and ignores refund.settled', async () => {
      const emitter = new EventEmitter2({ wildcard: true, delimiter: '.' });
      const spy = jest.spyOn(listener, 'handleBookingEvent').mockResolvedValue(undefined);

      // Register listener methods with emitter based on decorator metadata
      const metadata = Reflect.getMetadata('EVENT_LISTENER_METADATA', BookingProjectionListener.prototype.handleBookingEvent);
      for (const item of metadata) {
        const events = Array.isArray(item.event) ? item.event : [item.event];
        for (const evt of events) {
          emitter.on(evt, (data) => listener.handleBookingEvent(data));
        }
      }

      // Emitting refund.settled
      const refundEvent = new RefundSettledEvent({
        eventId: 'evt_ref_01',
        refundId: 'ref_01',
        amount: 5000,
        currency: 'USD',
        bookingId: 'bk_valid_001',
      });
      emitter.emit('refund.settled', refundEvent);

      expect(spy).not.toHaveBeenCalled();

      // Emitting booking.created
      const bookingEvent = new BookingCreatedEvent({
        bookingId: 'bk_valid_001',
        eventId: 'evt_create_001',
        sourceVersion: 1,
      });
      emitter.emit('booking.created', bookingEvent);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(bookingEvent);

      // Emitting multi-segment booking.recovery.resolved
      const recoveryEvent = {
        eventName: 'booking.recovery.resolved',
        bookingId: 'bk_valid_001',
        eventId: 'evt_rec_001',
        sourceVersion: 2,
      };
      emitter.emit('booking.recovery.resolved', recoveryEvent as any);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith(recoveryEvent);

      // Emitting multi-segment booking.disruption.synced
      const disruptionEvent = {
        eventName: 'booking.disruption.synced',
        bookingId: 'bk_valid_001',
        eventId: 'evt_disrupt_001',
        sourceVersion: 3,
      };
      emitter.emit('booking.disruption.synced', disruptionEvent as any);

      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy).toHaveBeenLastCalledWith(disruptionEvent);
    });
  });

  describe('c) Isolates hydrator failure without throwing, logs structured error, records ERROR metric', () => {
    it('catches hydrator error, does not bubble, logs error and records ERROR metric', async () => {
      const event = new BookingCreatedEvent({
        bookingId: 'bk_err_001',
        eventId: 'evt_err_001',
        sourceVersion: 1,
      });

      const dbError = new Error('PostgreSQL connection timeout');
      hydrator.hydrate.mockRejectedValue(dbError);

      const loggerErrorSpy = jest.spyOn((listener as any).logger, 'error').mockImplementation(() => {});

      await expect(listener.handleBookingEvent(event)).resolves.not.toThrow();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: 'bk_err_001',
          eventId: 'evt_err_001',
          sourceVersion: 1,
          error: 'PostgreSQL connection timeout',
        }),
      );

      expect(metrics.getEventsTotal('booking.created', 'ERROR')).toBe(1);
      expect(metrics.getFailureTotal('HYDRATION_FAILED')).toBe(1);
      expect(metrics.getDurations().length).toBe(1);
    });
  });

  describe('d) Isolates malformed revision failure without throwing, logs structured error, records ERROR metric', () => {
    it('catches MalformedRevisionError from projectionService without throwing', async () => {
      const event = new BookingCreatedEvent({
        bookingId: 'bk_malformed_001',
        eventId: 'evt_malformed_001',
        sourceVersion: 2,
      });

      const snapshot = createMockSnapshot({ id: 'bk_malformed_001', version: 2 });
      hydrator.hydrate.mockResolvedValue(snapshot);
      projectionService.extractProjectionData.mockImplementation(() => {
        throw new MalformedRevisionError('Latest itinerary revision is empty or has no segments');
      });

      const loggerErrorSpy = jest.spyOn((listener as any).logger, 'error').mockImplementation(() => {});

      await expect(listener.handleBookingEvent(event)).resolves.not.toThrow();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: 'bk_malformed_001',
          eventId: 'evt_malformed_001',
          sourceVersion: 2,
          error: 'Latest itinerary revision is empty or has no segments',
        }),
      );

      expect(metrics.getEventsTotal('booking.created', 'ERROR')).toBe(1);
      expect(metrics.getFailureTotal('EXTRACTION_FAILED')).toBe(1);
      expect(repository.upsertGuarded).not.toHaveBeenCalled();
      expect(metrics.getDurations().length).toBe(1);
    });
  });

  describe('e) Isolates repository failure without throwing, records ERROR metric', () => {
    it('catches repository upsertGuarded rejection without throwing', async () => {
      const event = new BookingCreatedEvent({
        bookingId: 'bk_repo_err_001',
        eventId: 'evt_repo_err_001',
        sourceVersion: 3,
      });

      const snapshot = createMockSnapshot({ id: 'bk_repo_err_001', version: 3 });
      hydrator.hydrate.mockResolvedValue(snapshot);
      projectionService.extractProjectionData.mockReturnValue(mockSafeData);
      repository.upsertGuarded.mockRejectedValue(new Error('Transaction serialization conflict'));

      const loggerErrorSpy = jest.spyOn((listener as any).logger, 'error').mockImplementation(() => {});

      await expect(listener.handleBookingEvent(event)).resolves.not.toThrow();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: 'bk_repo_err_001',
          eventId: 'evt_repo_err_001',
          sourceVersion: 3,
          error: 'Transaction serialization conflict',
        }),
      );

      expect(metrics.getEventsTotal('booking.created', 'ERROR')).toBe(1);
      expect(metrics.getFailureTotal('DATABASE_ERROR')).toBe(1);
      expect(metrics.getDurations().length).toBe(1);
    });
  });

  describe('f) When repository returns outcome STALE_IGNORED, records STALE_IGNORED metric and returns cleanly', () => {
    it('records STALE_IGNORED metric and does not throw', async () => {
      const event = new BookingCreatedEvent({
        bookingId: 'bk_stale_001',
        eventId: 'evt_stale_001',
        sourceVersion: 1,
      });

      const snapshot = createMockSnapshot({ id: 'bk_stale_001', version: 1 });
      hydrator.hydrate.mockResolvedValue(snapshot);
      projectionService.extractProjectionData.mockReturnValue(mockSafeData);
      repository.upsertGuarded.mockResolvedValue({ outcome: 'STALE_IGNORED' });

      await expect(listener.handleBookingEvent(event)).resolves.not.toThrow();

      expect(metrics.getEventsTotal('booking.created', 'STALE_IGNORED')).toBe(1);
      expect(metrics.getEventsTotal('booking.created', 'SUCCESS')).toBe(0);
      expect(metrics.getEventsTotal('booking.created', 'ERROR')).toBe(0);
      expect(metrics.getDurations().length).toBe(1);
    });
  });

  describe('g) Measures duration in metrics across execution paths', () => {
    it('records latency duration in finally block on success', async () => {
      const event = new BookingCreatedEvent({
        bookingId: 'bk_timer_001',
        eventId: 'evt_timer_001',
        sourceVersion: 1,
      });

      hydrator.hydrate.mockResolvedValue(createMockSnapshot());
      projectionService.extractProjectionData.mockReturnValue(mockSafeData);
      repository.upsertGuarded.mockResolvedValue({ outcome: 'SUCCESS' });

      await listener.handleBookingEvent(event);

      const durations = metrics.getDurations();
      expect(durations.length).toBe(1);
      expect(durations[0]).toBeGreaterThanOrEqual(0);
    });

    it('records latency duration in finally block on error', async () => {
      const event = new BookingCreatedEvent({
        bookingId: 'bk_timer_err_001',
        eventId: 'evt_timer_err_001',
        sourceVersion: 1,
      });

      hydrator.hydrate.mockRejectedValue(new Error('Network failure'));
      jest.spyOn((listener as any).logger, 'error').mockImplementation(() => {});

      await listener.handleBookingEvent(event);

      const durations = metrics.getDurations();
      expect(durations.length).toBe(1);
      expect(durations[0]).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Missing payload fields and null returns', () => {
    it('handles missing bookingId by logging warn and recording ERROR metric', async () => {
      const event = { eventId: 'evt_missing_id', sourceVersion: 1 } as any;

      const loggerWarnSpy = jest.spyOn((listener as any).logger, 'warn').mockImplementation(() => {});

      await expect(listener.handleBookingEvent(event)).resolves.not.toThrow();

      expect(loggerWarnSpy).toHaveBeenCalled();
      expect(metrics.getEventsTotal('booking.unknown', 'ERROR')).toBe(1);
      expect(metrics.getFailureTotal('INVALID_EVENT')).toBe(1);
      expect(hydrator.hydrate).not.toHaveBeenCalled();
      expect(metrics.getDurations().length).toBe(1);
    });

    it('handles null snapshot from hydrator by logging warn and recording ERROR metric', async () => {
      const event = new BookingCreatedEvent({
        bookingId: 'bk_null_snap_001',
        eventId: 'evt_null_snap_001',
        sourceVersion: 1,
      });

      hydrator.hydrate.mockResolvedValue(null);
      const loggerWarnSpy = jest.spyOn((listener as any).logger, 'warn').mockImplementation(() => {});

      await expect(listener.handleBookingEvent(event)).resolves.not.toThrow();

      expect(loggerWarnSpy).toHaveBeenCalled();
      expect(metrics.getEventsTotal('booking.created', 'ERROR')).toBe(1);
      expect(metrics.getFailureTotal('HYDRATION_FAILED')).toBe(1);
      expect(projectionService.extractProjectionData).not.toHaveBeenCalled();
      expect(repository.upsertGuarded).not.toHaveBeenCalled();
      expect(metrics.getDurations().length).toBe(1);
    });

    it('handles null data from projection service by logging warn and recording ERROR metric', async () => {
      const event = new BookingCreatedEvent({
        bookingId: 'bk_null_data_001',
        eventId: 'evt_null_data_001',
        sourceVersion: 1,
      });

      hydrator.hydrate.mockResolvedValue(createMockSnapshot());
      projectionService.extractProjectionData.mockReturnValue(null);
      const loggerWarnSpy = jest.spyOn((listener as any).logger, 'warn').mockImplementation(() => {});

      await expect(listener.handleBookingEvent(event)).resolves.not.toThrow();

      expect(loggerWarnSpy).toHaveBeenCalled();
      expect(metrics.getEventsTotal('booking.created', 'ERROR')).toBe(1);
      expect(metrics.getFailureTotal('EXTRACTION_FAILED')).toBe(1);
      expect(repository.upsertGuarded).not.toHaveBeenCalled();
      expect(metrics.getDurations().length).toBe(1);
    });
  });
});
