'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import type { BookingDetailDto } from '@shared/booking-types';
import { BookingConfirmationBanner } from '@/components/bookings/BookingConfirmationBanner';
import { BookingDetail } from '@/components/bookings/BookingDetail';
import { BookingFailureState } from '@/components/bookings/BookingFailureState';
import { BookingProcessingState } from '@/components/bookings/BookingProcessingState';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type BookingDetailResponse = BookingDetailDto & {
  payment?: { status: string } | null;
  bookingIntent?: { offerId?: string };
};

export default function BookingDetailPage() {
  const params = useParams<{ bookingId: string }>();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const [booking, setBooking] = useState<BookingDetailResponse>();
  const [error, setError] = useState<string>();
  const showConfirmation = searchParams.get('confirmed') === 'true';
  const accessToken = (session as { accessToken?: string } | null)?.accessToken;

  useEffect(() => {
    if (!showConfirmation) {
      return;
    }

    window.history.replaceState(null, '', `/bookings/${params.bookingId}`);
  }, [params.bookingId, showConfirmation]);

  useEffect(() => {
    const controller = new AbortController();

    const loadBooking = async (): Promise<void> => {
      try {
        const response = await fetch(`${apiUrl}/api/bookings/${params.bookingId}`, {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          setError(response.status === 403 ? 'You do not have access to this booking.' : 'We could not find this booking.');
          return;
        }

        // The backend response is validated at its HTTP boundary; this narrows the JSON payload for rendering.
        setBooking((await response.json()) as BookingDetailResponse);
      } catch (caughtError) {
        if (caughtError instanceof DOMException && caughtError.name === 'AbortError') {
          return;
        }
        setError('We could not load this booking. Please try again.');
      }
    };

    void loadBooking();
    return () => controller.abort();
  }, [accessToken, params.bookingId]);

  if (error) {
    return <main className="mx-auto max-w-3xl py-12"><p role="alert" className="card text-text-cancelled">{error}</p></main>;
  }

  if (!booking) {
    return <main className="mx-auto max-w-3xl py-12"><p className="card text-text-secondary">Loading your booking…</p></main>;
  }

  if (booking.status === 'PROCESSING') {
    return <main className="mx-auto max-w-3xl py-12"><BookingProcessingState /></main>;
  }

  if (booking.status === 'FAILED') {
    return (
      <main className="mx-auto max-w-3xl py-12">
        <BookingFailureState
          failureReason={booking.failureReason}
          flightSnapshot={booking.flightSnapshot}
          paymentStatus={booking.payment?.status ?? booking.paymentStatus}
          offerId={booking.bookingIntent?.offerId}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 py-12">
      {showConfirmation && booking.status === 'CONFIRMED' && <BookingConfirmationBanner pnrReference={booking.pnrReference} />}
      <BookingDetail booking={booking} />
    </main>
  );
}
