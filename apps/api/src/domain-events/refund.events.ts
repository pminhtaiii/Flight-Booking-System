/**
 * Refund Event Catalog Constants & Events
 *
 * Settlement-owned terminal facts. Note: refund.settled does not subscribe to projection
 * and does not fabricate a bookingId when unlinked from a booking.
 */

export const REFUND_EVENTS = {
  SETTLED: 'refund.settled',
} as const;

export type RefundEventType = (typeof REFUND_EVENTS)[keyof typeof REFUND_EVENTS];

export type RefundSettledEventInit = {
  eventId: string;
  refundId: string;
  amount: number;
  currency: string;
  timestamp?: Date;
  bookingId?: string;
};

export class RefundSettledEvent {
  readonly eventId: string;
  readonly refundId: string;
  readonly timestamp: Date;
  readonly amount: number;
  readonly currency: string;
  readonly bookingId?: string;

  constructor(
    initOrEventId: RefundSettledEventInit | string,
    refundId?: string,
    amount?: number,
    currency?: string,
    timestamp?: Date,
    bookingId?: string,
  ) {
    if (typeof initOrEventId === 'string') {
      this.eventId = initOrEventId;
      this.refundId = refundId ?? '';
      this.amount = amount ?? 0;
      this.currency = currency ?? '';
      this.timestamp = timestamp ?? new Date();
      if (bookingId !== undefined) {
        this.bookingId = bookingId;
      }
    } else {
      this.eventId = initOrEventId.eventId;
      this.refundId = initOrEventId.refundId;
      this.amount = initOrEventId.amount;
      this.currency = initOrEventId.currency;
      this.timestamp = initOrEventId.timestamp ?? new Date();
      if (initOrEventId.bookingId !== undefined) {
        this.bookingId = initOrEventId.bookingId;
      }
    }
  }
}
