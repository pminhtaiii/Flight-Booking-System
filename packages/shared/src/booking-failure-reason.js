"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookingFailureReason = void 0;
/**
 * BookingFailureReason enum for the Flight Booking System.
 * Maps pipeline failure points to user-facing failure states on a Booking record.
 * Note: PAYMENT_DECLINED is intentionally excluded — card declines are handled inline
 * on the checkout page before the Booking record exists.
 */
var BookingFailureReason;
(function (BookingFailureReason) {
    /** Duffel offer no longer available */
    BookingFailureReason["OFFER_EXPIRED"] = "OFFER_EXPIRED";
    /** Duffel re-pricing returned different amount */
    BookingFailureReason["PRICE_CHANGED"] = "PRICE_CHANGED";
    /** Duffel 30s PNR creation timeout */
    BookingFailureReason["BOOKING_TIMEOUT"] = "BOOKING_TIMEOUT";
    /** Stripe capture failure after PNR creation */
    BookingFailureReason["CAPTURE_FAILED"] = "CAPTURE_FAILED";
    /** Unexpected exception */
    BookingFailureReason["SYSTEM_ERROR"] = "SYSTEM_ERROR";
})(BookingFailureReason || (exports.BookingFailureReason = BookingFailureReason = {}));
