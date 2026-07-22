/**
 * BookingStatus enum for the Flight Booking System.
 * Represents all possible lifecycle states of a Booking record.
 */
export enum BookingStatus {
  /** Pipeline is running — Booking just created at start of confirm */
  PROCESSING = 'PROCESSING',
  /** PNR created, payment captured successfully */
  CONFIRMED = 'CONFIRMED',
  /** Pipeline failed at some stage */
  FAILED = 'FAILED',
  /** Flight departure date has passed */
  COMPLETED = 'COMPLETED',
  /** Cancellation quote or request is in progress */
  CANCELLATION_PENDING = 'CANCELLATION_PENDING',
  /** Cancelled with Duffel/airline, pending refund processing */
  CANCELLED_PENDING_REFUND = 'CANCELLED_PENDING_REFUND',
  /** Cancelled and refund successfully issued */
  CANCELLED_AND_REFUNDED = 'CANCELLED_AND_REFUNDED',
  /** Cancelled without refund (non-refundable or zero refund) */
  CANCELLED_NO_REFUND = 'CANCELLED_NO_REFUND',
}
