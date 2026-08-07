"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookingStatus = void 0;
/**
 * BookingStatus enum for the Flight Booking System.
 * Represents all possible lifecycle states of a Booking record.
 */
var BookingStatus;
(function (BookingStatus) {
    /** Pipeline is running — Booking just created at start of confirm */
    BookingStatus["PROCESSING"] = "PROCESSING";
    /** PNR created, payment captured successfully */
    BookingStatus["CONFIRMED"] = "CONFIRMED";
    /** Pipeline failed at some stage */
    BookingStatus["FAILED"] = "FAILED";
    /** Flight departure date has passed */
    BookingStatus["COMPLETED"] = "COMPLETED";
    /** Cancellation quote or request is in progress */
    BookingStatus["CANCELLATION_PENDING"] = "CANCELLATION_PENDING";
    /** Cancelled with Duffel/airline, pending refund processing */
    BookingStatus["CANCELLED_PENDING_REFUND"] = "CANCELLED_PENDING_REFUND";
    /** Cancelled and refund successfully issued */
    BookingStatus["CANCELLED_AND_REFUNDED"] = "CANCELLED_AND_REFUNDED";
    /** Cancelled without refund (non-refundable or zero refund) */
    BookingStatus["CANCELLED_NO_REFUND"] = "CANCELLED_NO_REFUND";
    /** Cancellation succeeded but Stripe refund failed */
    BookingStatus["REFUND_FAILED_NEEDS_ATTENTION"] = "REFUND_FAILED_NEEDS_ATTENTION";
})(BookingStatus || (exports.BookingStatus = BookingStatus = {}));
