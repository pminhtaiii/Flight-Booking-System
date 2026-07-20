/**
 * BookingFailureReason enum for the Flight Booking System.
 * Maps pipeline failure points to user-facing failure states on a Booking record.
 * Note: PAYMENT_DECLINED is intentionally excluded — card declines are handled inline
 * on the checkout page before the Booking record exists.
 */
export enum BookingFailureReason {
  /** Duffel offer no longer available */
  OFFER_EXPIRED = 'OFFER_EXPIRED',
  /** Duffel re-pricing returned different amount */
  PRICE_CHANGED = 'PRICE_CHANGED',
  /** Duffel 30s PNR creation timeout */
  BOOKING_TIMEOUT = 'BOOKING_TIMEOUT',
  /** Stripe capture failure after PNR creation */
  CAPTURE_FAILED = 'CAPTURE_FAILED',
  /** Unexpected exception */
  SYSTEM_ERROR = 'SYSTEM_ERROR',
}
