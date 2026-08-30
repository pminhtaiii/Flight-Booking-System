import Link from 'next/link';
import type { FlightSnapshot } from '@shared/booking-types';
import { BookingFailureReason } from '@shared/booking-failure-reason';

type BookingFailureStateProps = {
  failureReason?: BookingFailureReason;
  flightSnapshot?: FlightSnapshot;
  paymentStatus?: string;
  offerId?: string;
};

const failureMessages: Record<BookingFailureReason, string> = {
  [BookingFailureReason.OFFER_EXPIRED]: 'This offer is no longer available.',
  [BookingFailureReason.PRICE_CHANGED]:
    'The price for this flight changed before we could confirm it.',
  [BookingFailureReason.BOOKING_TIMEOUT]: 'The airline did not confirm this booking in time.',
  [BookingFailureReason.CAPTURE_FAILED]: 'We could not finish taking payment for this booking.',
  [BookingFailureReason.SYSTEM_ERROR]:
    'We could not complete this booking because of a system error.',
};

const chargeMessage = (paymentStatus?: string): string => {
  if (paymentStatus === 'SUCCEEDED' || paymentStatus === 'CAPTURED') {
    return 'Your card was charged. Our support team will help resolve this.';
  }
  if (paymentStatus === 'AUTHORIZED') {
    return "A hold was placed on your card — we're working to release it.";
  }
  return 'No charge was made to your card.';
};

export function BookingFailureState({
  failureReason,
  flightSnapshot,
  paymentStatus,
  offerId,
}: BookingFailureStateProps) {
  const firstSegment = flightSnapshot?.segments[0];
  const routeQuery = firstSegment
    ? `?origin=${encodeURIComponent(firstSegment.departureAirport.iataCode)}&destination=${encodeURIComponent(firstSegment.arrivalAirport.iataCode)}`
    : '';
  const message = failureReason
    ? failureMessages[failureReason]
    : failureMessages[BookingFailureReason.SYSTEM_ERROR];

  return (
    <section aria-labelledby="booking-failed-title" className="card border border-text-cancelled">
      <h1 id="booking-failed-title" className="text-xl font-bold text-text-cancelled">
        We could not complete your booking
      </h1>
      <p className="mt-2 text-sm text-text-secondary">{message}</p>
      <p className="mt-3 text-sm font-medium text-text-primary">{chargeMessage(paymentStatus)}</p>
      <div className="mt-5">
        {failureReason === BookingFailureReason.OFFER_EXPIRED ? (
          <Link href={`/search${routeQuery}`} className="btn-primary">
            Search flights again
          </Link>
        ) : failureReason === BookingFailureReason.CAPTURE_FAILED ? (
          <a href="mailto:support@flightsystem.example" className="btn-secondary">
            Contact support
          </a>
        ) : (
          <Link href={offerId ? `/search/${offerId}` : '/search'} className="btn-primary">
            Review this flight
          </Link>
        )}
      </div>
    </section>
  );
}
