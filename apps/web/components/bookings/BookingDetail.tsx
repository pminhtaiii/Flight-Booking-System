/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import type { BookingDetailDto } from '@shared/booking-types';
import { BookingStatusBadge } from '@/components/bookings/BookingStatusBadge';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type BookingDetailProps = {
  booking: BookingDetailDto;
  onRefresh?: () => void;
};

const currencyFormatter = (amount: string, currency: string): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Number(amount));

export function BookingDetail({ booking, onRefresh }: BookingDetailProps) {
  const [cancellationStatus, setCancellationStatus] = useState<any>(null);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: session } = useSession();
  const accessToken = (session as any)?.accessToken;

  const fetchCancellationStatus = useCallback(async () => {
    try {
      if (!accessToken) return;
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
          onRefresh?.();
        }
      }
    } catch (e) {
      // Ignore error to avoid console noise
    }
  }, [booking.id, booking.status, onRefresh, accessToken]);

  useEffect(() => {
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
  }, [booking.status, fetchCancellationStatus]);

  const handleOpenCancelModal = async () => {
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
    if (!quote?.quoteId) return;
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
      onRefresh?.();
    } catch (err: any) {
      setError(err.message || 'An error occurred during cancellation.');
    } finally {
      setCancelling(false);
    }
  };

  const segments = booking.flightSnapshot?.segments ?? [];
  const passengers = booking.passengerSnapshot?.passengers ?? [];

  const isCancellable = booking.status === 'CONFIRMED' && 
    booking.cancellationDeadline && new Date(booking.cancellationDeadline) > new Date();

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

      <div className="border-t border-card-border pt-4">
        <h3 className="font-semibold text-text-primary">Payment summary</h3>
        <p className="mt-1 text-sm text-text-secondary">Total paid: {currencyFormatter(booking.totalAmount, booking.currency)}</p>
      </div>

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
