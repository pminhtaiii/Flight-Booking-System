/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import type { BookingDetailDto } from '@shared/booking-types';
import { DisruptionStatus } from '@shared/disruption-types';
import { BookingStatusBadge } from '@/components/bookings/BookingStatusBadge';
import { DisruptionAlert } from '@/components/bookings/DisruptionAlert';
import { ItineraryChangeSummary } from '@/components/bookings/ItineraryChangeSummary';
import { ItineraryRevisionHistory } from '@/components/bookings/ItineraryRevisionHistory';
import { BookingProcessingState } from '@/components/bookings/BookingProcessingState';
import { BookingFailureState } from '@/components/bookings/BookingFailureState';

const apiUrl = process.env.NEXT_PUBLIC_API_URL;

type BookingDetailProps = {
  booking: BookingDetailDto & {
    currentItinerary?: any;
    disruption?: any;
    payment?: { status: string } | null;
    bookingIntent?: { id: string; offerId: string };
    ancillarySummary?: {
      seats: {
        intentPassengerId: string;
        passengerName: string;
        segmentId: string;
        seatDesignator: string;
        amount: string;
        currency: string;
      }[];
      baggage: {
        intentPassengerId: string;
        passengerName: string;
        type: string;
        quantity: number;
        amount: string;
        currency: string;
      }[];
    } | null;
  } | null;
  showConfirmation?: boolean;
  isMockEnabled?: boolean;
  bookingId?: string;
};

const currencyFormatter = (amount: string, currency: string): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Number(amount));

export function BookingDetail({ booking: initialBooking, isMockEnabled, bookingId }: BookingDetailProps) {
  if (!apiUrl) {
    throw new Error('NEXT_PUBLIC_API_URL is required but not configured.');
  }
  const [booking, setBooking] = useState<any>(initialBooking);

  const [loadingMock, setLoadingMock] = useState(!!isMockEnabled);
  const [mockError, setMockError] = useState<string | null>(null);

  // Disruption state
  const [loadingAction, setLoadingAction] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  useEffect(() => {
    setBooking(initialBooking);
    setConflictError(null);
    setActionSuccess(null);
  }, [initialBooking]);

  const [cancellationStatus, setCancellationStatus] = useState<any>(null);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: session } = useSession();
  const accessToken = (session as any)?.accessToken;
  const router = useRouter();

  // Client-side fallback fetch for Playwright routing mocks
  useEffect(() => {
    if (isMockEnabled && bookingId && accessToken) {
      setLoadingMock(true);
      fetch(`${apiUrl}/api/bookings/${bookingId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(res.status === 403 ? 'You do not have access to this booking.' : 'We could not find this booking.');
          }
          return res.json();
        })
        .then((data) => {
          setBooking(data);
          setLoadingMock(false);
        })
        .catch((err) => {
          setMockError(err.message);
          setLoadingMock(false);
        });
    }
  }, [isMockEnabled, bookingId, accessToken]);

  const fetchCancellationStatus = useCallback(async () => {
    try {
      if (!accessToken || !booking) return;
      const res = await fetch(`${apiUrl}/api/bookings/${booking.id}/cancellation`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setCancellationStatus(data);
        
        // If status changed to a completed state from a pending state, refresh the parent
        if (
          booking.status !== data.bookingStatus && 
          data.bookingStatus !== 'CANCELLATION_PENDING' && 
          data.bookingStatus !== 'CANCELLED_PENDING_REFUND'
        ) {
          router.refresh();
        }
      }
    } catch (e) {
      // Ignore error to avoid console noise
    }
  }, [booking, router, accessToken]);

  useEffect(() => {
    if (!booking) return;
    let interval: NodeJS.Timeout;
    if (booking.status === 'CANCELLATION_PENDING' || booking.status === 'CANCELLED_PENDING_REFUND') {
      fetchCancellationStatus();
      interval = setInterval(fetchCancellationStatus, 5000);
    } else if (booking.status === 'REFUND_FAILED_NEEDS_ATTENTION' || booking.status === 'CANCELLED_AND_REFUNDED' || booking.status === 'CANCELLED_NO_REFUND') {
      fetchCancellationStatus();
    }
    return () => {
      if (interval) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking?.status, fetchCancellationStatus]);

  const handleOpenCancelModal = async () => {
    if (!booking) return;
    setShowCancelModal(true);
    setLoadingQuote(true);
    setError(null);
    try {
      if (!accessToken) throw new Error('Not authenticated');
      const res = await fetch(`${apiUrl}/api/bookings/${booking.id}/cancellation-quote`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Failed to fetch cancellation quote');
      const data = await res.json();
      setQuote(data);
    } catch (err: any) {
      setError(err.message || 'An error occurred while fetching the quote.');
    } finally {
      setLoadingQuote(false);
    }
  };

  const handleConfirmCancellation = async () => {
    if (!quote?.quoteId || !booking) return;
    setCancelling(true);
    setError(null);
    try {
      if (!accessToken) throw new Error('Not authenticated');
      const res = await fetch(`${apiUrl}/api/bookings/${booking.id}/cancel`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ quoteId: quote.quoteId }),
      });
      if (!res.ok) throw new Error('Failed to confirm cancellation');
      setShowCancelModal(false);
      router.refresh();
    } catch (err: any) {
      setError(err.message || 'An error occurred during cancellation.');
    } finally {
      setCancelling(false);
    }
  };

  const handleDisruptionAction = async (action: 'acknowledge' | 'accept') => {
    if (!booking) return;
    const activeRevisionId = booking.disruption?.activeRevisionId;
    if (!activeRevisionId || !accessToken) return;

    setLoadingAction(true);
    setConflictError(null);
    setActionSuccess(null);

    try {
      const res = await fetch(`${apiUrl}/api/bookings/${booking.id}/disruptions/${activeRevisionId}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 409) {
        setConflictError('A newer change exists and must be reviewed.');
        router.refresh();
        return;
      }

      if (!res.ok) {
        throw new Error(`Failed to ${action} disruption`);
      }

      setActionSuccess(`Successfully ${action === 'acknowledge' ? 'acknowledged' : 'accepted'} the changes.`);
      router.refresh();
    } catch (err: any) {
      setConflictError(err.message || 'An error occurred. Please try again.');
    } finally {
      setLoadingAction(false);
    }
  };

  if (loadingMock) {
    return (
      <section className="card space-y-6">
        <p className="text-text-secondary text-sm">Loading your booking details…</p>
      </section>
    );
  }

  if (mockError) {
    return (
      <section className="card space-y-6">
        <p role="alert" className="text-text-cancelled text-sm font-semibold">{mockError}</p>
      </section>
    );
  }

  if (!booking) {
    return (
      <section className="card space-y-6">
        <p className="text-text-secondary text-sm">Booking details not available.</p>
      </section>
    );
  }

  if (booking.status === 'PROCESSING') {
    return <BookingProcessingState />;
  }

  if (booking.status === 'FAILED') {
    return (
      <BookingFailureState
        failureReason={booking.failureReason}
        flightSnapshot={booking.flightSnapshot}
        paymentStatus={booking.payment?.status ?? booking.paymentStatus}
        offerId={booking.bookingIntent?.offerId}
      />
    );
  }

  const segments = booking.currentItinerary?.segments ?? booking.flightSnapshot?.segments ?? [];
  const passengers = booking.passengerSnapshot?.passengers ?? [];

  const isCancellable = booking.status === 'CONFIRMED' && 
    booking.cancellationDeadline && new Date(booking.cancellationDeadline) > new Date();

  const activeDisruptionStatus = booking.disruption?.status ?? DisruptionStatus.NONE;
  const isDisrupted = activeDisruptionStatus !== DisruptionStatus.NONE;

  return (
    <section aria-labelledby="booking-detail-title" className="card space-y-6 relative">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 id="booking-detail-title" className="text-xl font-bold text-text-primary">Flight details</h2>
          {booking.pnrReference && <p className="mt-1 text-sm text-text-secondary">PNR: {booking.pnrReference}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          <BookingStatusBadge status={booking.status as any} />
          {isCancellable && (
            <button 
              onClick={handleOpenCancelModal}
              className="text-sm px-3 py-1 rounded bg-bg-cancelled text-text-cancelled border border-danger-border hover:bg-bg-cancelled/80"
            >
              Cancel booking
            </button>
          )}
        </div>
      </div>

      {/* Disruption Alert */}
      {isDisrupted && (
        <DisruptionAlert
          status={activeDisruptionStatus}
          isMaterial={booking.disruption.isMaterial}
          materialReasons={booking.disruption.materialReasons}
          stabilizationWarning={booking.disruption.stabilizationWarning}
          resolvedReason={booking.disruption.resolvedReason}
        />
      )}

      {/* Itinerary Change Summary */}
      {isDisrupted && (
        <ItineraryChangeSummary
          incrementalSummary={booking.disruption.incrementalSummary}
          cumulativeSummary={booking.disruption.cumulativeSummary}
        />
      )}

      {/* Traveller Disruption Actions */}
      {(activeDisruptionStatus === DisruptionStatus.DETECTED || activeDisruptionStatus === DisruptionStatus.ACKNOWLEDGED) && (
        <div className="bg-bg-secondary p-5 rounded-xl border border-card-border space-y-4">
          <h3 className="font-bold text-text-primary text-sm">Review Required</h3>
          <p className="text-xs text-text-secondary">
            Please confirm your preference regarding the schedule changes proposed by the airline.
          </p>

          {conflictError && (
            <div className="p-3 bg-bg-cancelled border border-danger-border text-text-cancelled rounded-lg text-xs font-semibold">
              {conflictError}
            </div>
          )}

          {actionSuccess && (
            <div className="p-3 bg-bg-confirmed border border-color-text-confirmed/30 text-text-confirmed rounded-lg text-xs font-semibold">
              {actionSuccess}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            {activeDisruptionStatus === DisruptionStatus.DETECTED && (
              <button
                onClick={() => handleDisruptionAction('acknowledge')}
                disabled={loadingAction}
                className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-50"
              >
                {loadingAction ? 'Processing...' : 'I understand'}
              </button>
            )}
            <button
              onClick={() => handleDisruptionAction('accept')}
              disabled={loadingAction}
              className="btn-primary text-xs py-1.5 px-3 disabled:opacity-50"
            >
              {loadingAction ? 'Processing...' : 'Accept current itinerary'}
            </button>
          </div>
        </div>
      )}

      {cancellationStatus && (booking.status === 'CANCELLATION_PENDING' || booking.status === 'CANCELLED_PENDING_REFUND' || booking.status === 'REFUND_FAILED_NEEDS_ATTENTION' || booking.status === 'CANCELLED_AND_REFUNDED' || booking.status === 'CANCELLED_NO_REFUND') && (
        <div className="bg-bg-secondary p-4 rounded-lg border border-border-primary">
          <h3 className="font-semibold text-text-primary mb-2">Cancellation Status</h3>
          <p className="text-sm text-text-secondary mb-1">Status: <span className="font-medium text-text-primary">{cancellationStatus.bookingStatus}</span></p>
          
          {cancellationStatus.customerRefundAmount && (
            <p className="text-sm text-text-secondary mb-1">Expected Refund: <span className="font-medium text-text-primary">{currencyFormatter(cancellationStatus.customerRefundAmount, booking.currency)}</span></p>
          )}
          
          {booking.status === 'REFUND_FAILED_NEEDS_ATTENTION' && cancellationStatus && (
            <div className="mt-4 p-3 bg-danger-border/10 border border-danger-border rounded">
              <p className="text-sm font-semibold text-text-cancelled mb-2">
                {cancellationStatus.escalationMessage || 'Refund requires attention. Please contact support.'}
              </p>
              <ul className="text-xs text-text-secondary space-y-1">
                {cancellationStatus.refundStatus && <li>Refund Status: {cancellationStatus.refundStatus}</li>}
                {cancellationStatus.retryCount !== null && <li>Retry Count: {cancellationStatus.retryCount}</li>}
                {cancellationStatus.lastErrorCode && <li>Last Error: {cancellationStatus.lastErrorCode}</li>}
              </ul>
            </div>
          )}
        </div>
      )}

      {segments.length > 0 && (
        <div className="space-y-4">
          {segments.map((segment: any) => (
            <article key={`${segment.flightNumber}-${segment.departureAt}`} className="rounded-lg border border-card-border p-4">
              <p className="font-semibold text-text-primary">{segment.airline.name} {segment.flightNumber}</p>
              <p className="mt-1 text-sm text-text-secondary">
                {segment.departureAirport.city} ({segment.departureAirport.iataCode}) to {segment.arrivalAirport.city} ({segment.arrivalAirport.iataCode})
              </p>
              <p className="mt-2 text-sm text-text-secondary">
                {new Date(segment.departureAt).toLocaleString('en-GB')} – {new Date(segment.arrivalAt).toLocaleString('en-GB')}
              </p>
            </article>
          ))}
          {booking.flightSnapshot?.baggageAllowance && <p className="text-sm text-text-secondary">Baggage: {booking.flightSnapshot.baggageAllowance}</p>}
        </div>
      )}

      {passengers.length > 0 && (
        <div>
          <h3 className="font-semibold text-text-primary">Passengers</h3>
          <ul className="mt-2 space-y-2 text-sm text-text-secondary">
            {passengers.map((passenger: any) => <li key={`${passenger.firstName}-${passenger.lastName}`}>{passenger.firstName} {passenger.lastName}</li>)}
          </ul>
        </div>
      )}

      {booking.ancillarySummary && (booking.ancillarySummary.seats?.length > 0 || booking.ancillarySummary.baggage?.length > 0) && (
        <div className="border-t border-card-border pt-4">
          <h3 className="font-semibold text-text-primary">Extras Purchased</h3>
          <div className="mt-2 space-y-3 text-sm text-text-secondary">
            {booking.ancillarySummary.seats && booking.ancillarySummary.seats.length > 0 && (
              <div>
                <h4 className="font-medium text-text-primary text-xs uppercase tracking-wider mb-1">Seats</h4>
                <ul className="list-disc list-inside space-y-1 pl-1">
                  {booking.ancillarySummary.seats.map((seat: any, idx: number) => (
                    <li key={`seat-${idx}`}>
                      {seat.passengerName || 'Passenger'}: Seat {seat.seatDesignator} ({currencyFormatter(seat.amount, seat.currency)})
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {booking.ancillarySummary.baggage && booking.ancillarySummary.baggage.length > 0 && (
              <div>
                <h4 className="font-medium text-text-primary text-xs uppercase tracking-wider mb-1">Baggage</h4>
                <ul className="list-disc list-inside space-y-1 pl-1">
                  {booking.ancillarySummary.baggage.map((bag: any, idx: number) => (
                    <li key={`bag-${idx}`}>
                      {bag.passengerName || 'Passenger'}: {bag.quantity}x {bag.type} ({currencyFormatter((Number(bag.amount) * bag.quantity).toString(), bag.currency)})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="border-t border-card-border pt-4">
        <h3 className="font-semibold text-text-primary">Payment summary</h3>
        <p className="mt-1 text-sm text-text-secondary">Total paid: {currencyFormatter(booking.totalAmount, booking.currency)}</p>
      </div>

      {/* Itinerary Revision History */}
      {accessToken && (
        <div className="mt-8 border-t border-card-border pt-6">
          <ItineraryRevisionHistory bookingId={booking.id} accessToken={accessToken} />
        </div>
      )}

      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-background border border-border-primary rounded-xl p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-xl font-bold text-text-primary mb-4">Cancel Booking</h3>
            
            {loadingQuote ? (
              <p className="text-text-secondary">Fetching cancellation quote...</p>
            ) : error ? (
              <div>
                <p className="text-text-cancelled mb-4">{error}</p>
                <button 
                  onClick={() => setShowCancelModal(false)}
                  className="px-4 py-2 bg-bg-secondary text-text-primary rounded hover:bg-border-primary transition-colors"
                >
                  Close
                </button>
              </div>
            ) : quote ? (
              <div className="space-y-4">
                <div className="bg-bg-secondary p-4 rounded-lg space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-text-secondary">Total Paid:</span>
                    <span className="font-medium text-text-primary">{currencyFormatter(booking.totalAmount, booking.currency)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-text-secondary">Refund Amount:</span>
                    <span className="font-medium text-text-primary">{currencyFormatter(quote.refundAmount, quote.currency)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-text-cancelled">
                    <span>Penalty / Fees:</span>
                    <span>{currencyFormatter((Number(booking.totalAmount) - Number(quote.refundAmount)).toString(), quote.currency)}</span>
                  </div>
                  {quote.refundTo && (
                    <div className="flex justify-between text-sm">
                      <span className="text-text-secondary">Refund Destination:</span>
                      <span className="font-medium text-text-primary">{quote.refundTo}</span>
                    </div>
                  )}
                  {quote.nonRefundableAncillaryAmount && (
                    <div className="flex justify-between text-sm text-text-cancelled">
                      <span>Non-refundable Extras:</span>
                      <span>{currencyFormatter(quote.nonRefundableAncillaryAmount, quote.nonRefundableAncillaryCurrency || quote.currency || booking.currency)}</span>
                    </div>
                  )}
                </div>

                <label className="flex items-start gap-2 cursor-pointer mt-4">
                  <input 
                    type="checkbox" 
                    className="mt-1"
                    checked={confirmCancel}
                    onChange={(e) => setConfirmCancel(e.target.checked)}
                  />
                  <span className="text-sm text-text-secondary">
                    I understand that this action cannot be undone and the refund amount is subject to airline policies.
                  </span>
                </label>

                <div className="flex justify-end gap-3 mt-6">
                  <button 
                    onClick={() => setShowCancelModal(false)}
                    disabled={cancelling}
                    className="px-4 py-2 bg-bg-secondary text-text-primary rounded hover:bg-border-primary transition-colors disabled:opacity-50"
                  >
                    Go Back
                  </button>
                  <button 
                    onClick={handleConfirmCancellation}
                    disabled={!confirmCancel || cancelling}
                    className="px-4 py-2 bg-danger-border text-white rounded hover:bg-red-600 transition-colors disabled:opacity-50"
                  >
                    {cancelling ? 'Cancelling...' : 'Confirm Cancellation'}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
