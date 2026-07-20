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
}
