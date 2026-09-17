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

/**
 * Representation of monetary amount in integer minor currency units (e.g., cents, pence).
 * Uses the smallest currency unit (e.g., 1050 for $10.50, matching Refund.amount in the Prisma schema).
 * Strictly integer minor units; decimal major units are prohibited.
 */
export type MinorUnitAmount = number;

export type RefundSettledEventInit = {
  eventId: string;
  refundId: string;
  /**
   * Amount in integer minor currency units (e.g., cents, pence; 1050 represents $10.50).
   * Strictly uses integer minor units matching Refund.amount; decimal major units prohibited.
   */
  amount: MinorUnitAmount;
  currency: string;
  timestamp?: Date;
  bookingId?: string;
};

export class RefundSettledEvent {
  readonly eventId: string;
  readonly refundId: string;
  readonly timestamp: Date;
  /**
   * Amount in integer minor currency units (e.g., cents, pence; 1050 represents $10.50).
   * Strictly uses integer minor units matching Refund.amount; decimal major units prohibited.
   */
  readonly amount: MinorUnitAmount;
  readonly currency: string;
  readonly bookingId?: string;

  constructor(init: RefundSettledEventInit) {
    this.eventId = init.eventId;
    this.refundId = init.refundId;
    this.amount = init.amount;
    this.currency = init.currency;
    this.timestamp = init.timestamp ?? new Date();
    if (init.bookingId !== undefined) {
      this.bookingId = init.bookingId;
    }
  }
}
