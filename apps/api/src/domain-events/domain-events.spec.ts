import {
  DomainEventBase,
  BOOKING_EVENTS,
  BookingEventType,
  REFUND_EVENTS,
  RefundEventType,
  BookingCreatedEvent,
  BookingConfirmedEvent,
  BookingFailedEvent,
  BookingCompletedEvent,
  BookingRecoveryResolvedEvent,
  BookingCancellationPendingEvent,
  BookingCancelledEvent,
  BookingDisruptionSyncedEvent,
  BookingDisruptionAcknowledgedEvent,
  BookingDisruptionAcceptedEvent,
  BookingRefundUpdatedEvent,
  RefundSettledEvent,
} from './index';

describe('Domain Events Contract & Invariants', () => {
  const sampleDate = new Date('2026-09-17T12:00:00.000Z');

  const createSampleBookingEvents = (): DomainEventBase[] => [
    new BookingCreatedEvent({
      bookingId: 'book_001',
      eventId: 'evt_create_001',
      sourceVersion: 1,
      timestamp: sampleDate,
      status: 'PROCESSING',
    }),
    new BookingConfirmedEvent({
      bookingId: 'book_002',
      eventId: 'evt_confirm_001',
      sourceVersion: 2,
      timestamp: sampleDate,
      status: 'CONFIRMED',
    }),
    new BookingFailedEvent({
      bookingId: 'book_003',
      eventId: 'evt_fail_001',
      sourceVersion: 2,
      timestamp: sampleDate,
      status: 'FAILED',
      failureReason: 'PAYMENT_DECLINED',
    }),
    new BookingCompletedEvent({
      bookingId: 'book_004',
      eventId: 'evt_complete_001',
      sourceVersion: 3,
      timestamp: sampleDate,
      status: 'COMPLETED',
    }),
    new BookingRecoveryResolvedEvent({
      bookingId: 'book_005',
      eventId: 'evt_recovery_001',
      sourceVersion: 2,
      timestamp: sampleDate,
      status: 'CONFIRMED',
      recoveryOutcome: 'CONFIRMED_AFTER_PROCESSING',
    }),
    new BookingCancellationPendingEvent({
      bookingId: 'book_006',
      eventId: 'evt_cancel_pending_001',
      sourceVersion: 2,
      timestamp: sampleDate,
      status: 'CANCELLATION_PENDING',
      reason: 'TRAVELER_REQUESTED',
    }),
    new BookingCancelledEvent({
      bookingId: 'book_007',
      eventId: 'evt_cancel_001',
      sourceVersion: 3,
      timestamp: sampleDate,
      status: 'CANCELLED',
      reason: 'AIRLINE_CANCELLED',
    }),
    new BookingDisruptionSyncedEvent({
      bookingId: 'book_008',
      eventId: 'evt_disruption_sync_001',
      sourceVersion: 2,
      timestamp: sampleDate,
      status: 'CONFIRMED',
      revisionId: 'rev_001',
    }),
    new BookingDisruptionAcknowledgedEvent({
      bookingId: 'book_009',
      eventId: 'evt_disruption_ack_001',
      sourceVersion: 3,
      timestamp: sampleDate,
      status: 'CONFIRMED',
      disruptionId: 'disr_001',
    }),
    new BookingDisruptionAcceptedEvent({
      bookingId: 'book_010',
      eventId: 'evt_disruption_acc_001',
      sourceVersion: 4,
      timestamp: sampleDate,
      status: 'CONFIRMED',
      disruptionId: 'disr_001',
    }),
    new BookingRefundUpdatedEvent({
      bookingId: 'book_011',
      eventId: 'evt_refund_update_001',
      sourceVersion: 4,
      timestamp: sampleDate,
      status: 'CANCELLED_REFUNDED',
      refundStatus: 'SETTLED',
      reason: 'REFUND_SETTLED_SUCCESS',
    }),
  ];

  const createSampleRefundEvents = (): RefundSettledEvent[] => [
    new RefundSettledEvent({
      eventId: 'evt_refund_settled_001',
      refundId: 'ref_001',
      amount: 45000,
      currency: 'USD',
      timestamp: sampleDate,
      bookingId: 'book_011',
    }),
    new RefundSettledEvent({
      eventId: 'evt_refund_settled_002',
      refundId: 'ref_002',
      amount: 12000,
      currency: 'EUR',
      timestamp: sampleDate,
      // unlinked refund fact: no bookingId fabricated
    }),
  ];

  describe('Event Catalog Naming Contract', () => {
    it('matches exact contract strings for all 11 booking events', () => {
      expect(BOOKING_EVENTS.CREATED).toBe('booking.created');
      expect(BOOKING_EVENTS.CONFIRMED).toBe('booking.confirmed');
      expect(BOOKING_EVENTS.FAILED).toBe('booking.failed');
      expect(BOOKING_EVENTS.COMPLETED).toBe('booking.completed');
      expect(BOOKING_EVENTS.RECOVERY_RESOLVED).toBe('booking.recovery.resolved');
      expect(BOOKING_EVENTS.CANCELLATION_PENDING).toBe('booking.cancellation.pending');
      expect(BOOKING_EVENTS.CANCELLED).toBe('booking.cancelled');
      expect(BOOKING_EVENTS.DISRUPTION_SYNCED).toBe('booking.disruption.synced');
      expect(BOOKING_EVENTS.DISRUPTION_ACKNOWLEDGED).toBe('booking.disruption.acknowledged');
      expect(BOOKING_EVENTS.DISRUPTION_ACCEPTED).toBe('booking.disruption.accepted');
      expect(BOOKING_EVENTS.REFUND_UPDATED).toBe('booking.refund.updated');
    });

    it('contains exactly 11 booking events with no duplicate values', () => {
      const values = Object.values(BOOKING_EVENTS);
      expect(values).toHaveLength(11);
      const uniqueValues = new Set(values);
      expect(uniqueValues.size).toBe(11);
    });

    it('matches exact contract string for refund.settled', () => {
      expect(REFUND_EVENTS.SETTLED).toBe('refund.settled');
      const values = Object.values(REFUND_EVENTS);
      expect(values).toHaveLength(1);
    });

    it('validates catalog type constraints', () => {
      const eventType: BookingEventType = BOOKING_EVENTS.CREATED;
      expect(eventType).toBe('booking.created');
      const refundType: RefundEventType = REFUND_EVENTS.SETTLED;
      expect(refundType).toBe('refund.settled');
    });
  });

  describe('Behavior-Free Invariant', () => {
    const allInstances = [...createSampleBookingEvents(), ...createSampleRefundEvents()];

    it('ensures instances have zero prototype methods (excluding constructor)', () => {
      for (const instance of allInstances) {
        const proto = Object.getPrototypeOf(instance);
        const methodNames = Object.getOwnPropertyNames(proto).filter(
          (prop) => prop !== 'constructor',
        );
        expect(methodNames).toEqual([]);
      }
    });

    it('ensures instances have zero function/callback properties', () => {
      for (const instance of allInstances) {
        for (const value of Object.values(instance)) {
          expect(typeof value).not.toBe('function');
          expect(value).not.toBeInstanceOf(Function);
        }
      }
    });

    it('ensures instances contain no Prisma instances, DB connections, or SDK clients', () => {
      for (const instance of allInstances) {
        for (const value of Object.values(instance)) {
          if (value && typeof value === 'object') {
            expect(value).not.toHaveProperty('$connect');
            expect(value).not.toHaveProperty('$transaction');
            expect(value).not.toHaveProperty('paymentIntents');
            expect(value).not.toHaveProperty('orders');
            expect(value).not.toHaveProperty('emit');
          }
        }
      }
    });
  });

  describe('Plain Serializability', () => {
    const allInstances = [...createSampleBookingEvents(), ...createSampleRefundEvents()];

    it('serializes and deserializes cleanly without circular reference or error', () => {
      for (const instance of allInstances) {
        expect(() => JSON.stringify(instance)).not.toThrow();
        const json = JSON.stringify(instance);
        const parsed = JSON.parse(json);
        expect(parsed).toBeDefined();
        expect(typeof parsed).toBe('object');
      }
    });

    it('preserves all domain fields with full fidelity through JSON roundtrip', () => {
      for (const instance of allInstances) {
        const json = JSON.stringify(instance);
        const parsed = JSON.parse(json);

        for (const [key, value] of Object.entries(instance)) {
          if (value instanceof Date) {
            expect(new Date(parsed[key]).getTime()).toBe(value.getTime());
          } else {
            expect(parsed[key]).toEqual(value);
          }
        }
      }
    });
  });

  describe('Privacy Assurance & Allowlist Enforcement', () => {
    const disallowedPiiKeys = [
      'creditCard',
      'credit_card',
      'cardNumber',
      'card_number',
      'cvv',
      'cvc',
      'passport',
      'passportNumber',
      'passport_number',
      'email',
      'phone',
      'phoneNumber',
      'phone_number',
      'passenger',
      'passengers',
      'passengerName',
      'passenger_name',
      'firstName',
      'first_name',
      'lastName',
      'last_name',
      'dob',
      'dateOfBirth',
      'date_of_birth',
      'ssn',
      'address',
    ];

    const disallowedSupplierPayloadKeys = [
      'rawOfferSnapshot',
      'raw_offer_snapshot',
      'duffelPayload',
      'duffel_payload',
      'stripePayload',
      'stripe_payload',
      'rawPayload',
      'raw_payload',
      'supplierPayload',
      'supplier_payload',
      'offerSnapshot',
      'duffelOrder',
      'stripePaymentIntent',
      'paymentIntent',
      'clientSecret',
    ];

    const bookingEventAllowlist = new Set([
      'bookingId',
      'eventId',
      'sourceVersion',
      'timestamp',
      'status',
      'failureReason',
      'reason',
      'recoveryOutcome',
      'revisionId',
      'disruptionId',
      'refundStatus',
    ]);

    const refundEventAllowlist = new Set([
      'eventId',
      'refundId',
      'timestamp',
      'amount',
      'currency',
      'bookingId',
    ]);

    it('contains zero customer PII keys on any event envelope', () => {
      const allInstances = [...createSampleBookingEvents(), ...createSampleRefundEvents()];
      for (const instance of allInstances) {
        const instanceKeys = Object.keys(instance);
        for (const piiKey of disallowedPiiKeys) {
          expect(instanceKeys).not.toContain(piiKey);
        }
      }
    });

    it('contains zero supplier payloads or provider SDK snapshots', () => {
      const allInstances = [...createSampleBookingEvents(), ...createSampleRefundEvents()];
      for (const instance of allInstances) {
        const instanceKeys = Object.keys(instance);
        for (const supplierKey of disallowedSupplierPayloadKeys) {
          expect(instanceKeys).not.toContain(supplierKey);
        }
      }
    });

    it('strictly satisfies the privacy allowlist for booking events', () => {
      for (const bookingEvent of createSampleBookingEvents()) {
        for (const key of Object.keys(bookingEvent)) {
          expect(bookingEventAllowlist.has(key)).toBe(true);
        }
      }
    });

    it('strictly satisfies the privacy allowlist for refund events', () => {
      for (const refundEvent of createSampleRefundEvents()) {
        for (const key of Object.keys(refundEvent)) {
          expect(refundEventAllowlist.has(key)).toBe(true);
        }
      }
    });
  });

  describe('Contract Structure & Fact Integrity', () => {
    it('ensures all 11 booking events satisfy DomainEventBase contract', () => {
      for (const event of createSampleBookingEvents()) {
        expect(typeof event.bookingId).toBe('string');
        expect(event.bookingId.length).toBeGreaterThan(0);
        expect(typeof event.eventId).toBe('string');
        expect(event.eventId.length).toBeGreaterThan(0);
        expect(typeof event.sourceVersion).toBe('number');
        expect(event.sourceVersion).toBeGreaterThan(0);
        expect(Number.isInteger(event.sourceVersion)).toBe(true);
        expect(event.timestamp).toBeInstanceOf(Date);
      }
    });

    it('does not fabricate bookingId on unlinked refund.settled events', () => {
      const unlinkedRefund = new RefundSettledEvent({
        eventId: 'evt_unlinked_001',
        refundId: 'ref_unlinked_001',
        amount: 5000,
        currency: 'USD',
        timestamp: sampleDate,
      });

      expect(unlinkedRefund.bookingId).toBeUndefined();
      expect('bookingId' in unlinkedRefund).toBe(false);
      expect(unlinkedRefund.amount).toBe(5000);
      expect(unlinkedRefund.currency).toBe('USD');
      expect(unlinkedRefund.refundId).toBe('ref_unlinked_001');
    });

    it('supports linked refund.settled events with explicit bookingId', () => {
      const linkedRefund = new RefundSettledEvent({
        eventId: 'evt_linked_001',
        refundId: 'ref_linked_001',
        amount: 8000,
        currency: 'USD',
        timestamp: sampleDate,
        bookingId: 'book_linked_001',
      });

      expect(linkedRefund.bookingId).toBe('book_linked_001');
      expect(linkedRefund.amount).toBe(8000);
    });

    it('supports default timestamp if omitted in constructor', () => {
      const before = Date.now();
      const event = new BookingCreatedEvent({
        bookingId: 'book_default_ts',
        eventId: 'evt_default_ts',
        sourceVersion: 1,
      });
      const after = Date.now();

      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(before);
      expect(event.timestamp.getTime()).toBeLessThanOrEqual(after);
    });

    it('supports positional constructor arguments for booking events', () => {
      const event = new BookingConfirmedEvent('book_pos_001', 'evt_pos_001', 2, sampleDate);
      expect(event.bookingId).toBe('book_pos_001');
      expect(event.eventId).toBe('evt_pos_001');
      expect(event.sourceVersion).toBe(2);
      expect(event.timestamp).toEqual(sampleDate);
    });

    it('supports positional constructor arguments for refund events', () => {
      const event = new RefundSettledEvent(
        'evt_pos_ref',
        'ref_pos_001',
        1500,
        'USD',
        sampleDate,
        'book_pos_001',
      );
      expect(event.eventId).toBe('evt_pos_ref');
      expect(event.refundId).toBe('ref_pos_001');
      expect(event.amount).toBe(1500);
      expect(event.currency).toBe('USD');
      expect(event.timestamp).toEqual(sampleDate);
      expect(event.bookingId).toBe('book_pos_001');
    });
  });
});
