'use client';

import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckoutLoadingEscalation } from '@/components/checkout/CheckoutLoadingEscalation';

type ConfirmPaymentResponse = {
  bookingId?: string;
  bookingReference?: string;
  message?: string;
  status?: 'CONFIRMED' | 'FAILED' | 'PROCESSING' | 'SUCCEEDED' | 'PENDING';
  success?: boolean;
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function CheckoutPage() {
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const searchParams = useSearchParams();
  const paymentId = searchParams.get('paymentId');
  const accessToken = (session as { accessToken?: string } | null)?.accessToken;
  const [bookingId, setBookingId] = useState<string>();
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const beforeUnloadHandler = useRef((event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
  });

  const unregisterBeforeUnload = useCallback(() => {
    window.removeEventListener('beforeunload', beforeUnloadHandler.current);
  }, []);

  const registerBeforeUnload = useCallback(() => {
    unregisterBeforeUnload();
    window.addEventListener('beforeunload', beforeUnloadHandler.current);
  }, [unregisterBeforeUnload]);

  useEffect(() => unregisterBeforeUnload, [unregisterBeforeUnload]);

  const navigateToBooking = useCallback(
    (destination: string) => {
      unregisterBeforeUnload();
      router.push(destination);
    },
    [router, unregisterBeforeUnload],
  );

  const handleConfirmPayment = async () => {
    if (!paymentId || isConfirming || sessionStatus === 'loading') {
      return;
    }

    if (!accessToken) {
      setError('Your session has expired. Please sign in and try again.');
      return;
    }

    const clientBookingId = bookingId ?? crypto.randomUUID();
    setBookingId(clientBookingId);
    setError(undefined);
    setIsConfirming(true);
    registerBeforeUnload();

    let receivedResponse = false;
    try {
      const response = await fetch(`${apiUrl}/api/bookings/payment/confirm`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': clientBookingId,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ paymentId, bookingId: clientBookingId }),
      });
      const result = (await response.json()) as ConfirmPaymentResponse;
      receivedResponse = true;

      if (!response.ok) {
        throw new Error(result.message ?? 'We could not confirm your payment.');
      }

      if (!result.bookingId) {
        throw new Error('Your booking is still being prepared. Please try confirming your payment again.');
      }

      const canonicalBookingId = result.bookingId;

      if (result.status === 'PROCESSING' || result.status === 'PENDING') {
        setBookingId(canonicalBookingId);
        return;
      }

      if (result.status === 'CONFIRMED' || result.status === 'SUCCEEDED') {
        navigateToBooking(`/bookings/${canonicalBookingId}?confirmed=true`);
        return;
      }

      if (result.status === 'FAILED' || result.success === false) {
        navigateToBooking(`/bookings/${canonicalBookingId}`);
        return;
      }

      throw new Error('We could not determine your booking status.');
    } catch (caughtError) {
      unregisterBeforeUnload();
      setIsConfirming(false);
      setError(
        receivedResponse && caughtError instanceof Error
          ? caughtError.message
          : 'We could not confirm your payment.',
      );
    }
  };

  if (!paymentId) {
    return (
      <main className="mx-auto max-w-xl py-12">
        <section aria-labelledby="missing-payment-title" className="card space-y-4">
          <h1 id="missing-payment-title" className="text-xl font-bold text-text-primary">
            Payment information is missing
          </h1>
          <p className="text-sm text-text-secondary">
            Return to your flight search and start checkout again.
          </p>
          <Link href="/search" className="btn-secondary">
            Return to flight search
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl py-12">
      {isConfirming && bookingId ? (
        <CheckoutLoadingEscalation bookingId={bookingId} onNavigate={navigateToBooking} />
      ) : (
        <section aria-labelledby="checkout-title" className="card space-y-5">
          <div className="space-y-2">
            <h1 id="checkout-title" className="text-xl font-bold text-text-primary">
              Confirm your payment
            </h1>
            <p className="text-sm text-text-secondary">
              Your payment will be authorized while we reserve your flight.
            </p>
          </div>
          {error && <p role="alert" className="text-sm text-text-cancelled">{error}</p>}
          {sessionStatus === 'unauthenticated' ? (
            <p role="alert" className="text-sm text-text-cancelled">
              Your session has expired. <Link href="/login" className="font-semibold underline">Sign in to continue</Link>.
            </p>
          ) : (
            <button
              type="button"
              onClick={handleConfirmPayment}
              className="btn-primary"
              disabled={isConfirming || sessionStatus === 'loading'}
            >
              {sessionStatus === 'loading' ? 'Checking your session…' : 'Confirm payment'}
            </button>
          )}
        </section>
      )}
    </main>
  );
}
