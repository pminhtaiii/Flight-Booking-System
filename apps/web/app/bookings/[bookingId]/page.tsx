import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { Header } from '@/components/layout/Header';
import { BookingConfirmationBanner } from '@/components/bookings/BookingConfirmationBanner';
import { BookingDetail as BookingDetailClient } from '@/components/bookings/BookingDetail';
import { getBookingDetail } from '@/lib/server/booking-management';
import type { BookingDetailView } from '@shared/types/booking-management.types';
import { MOCK_BOOKINGS } from './mock-bookings';

type Props = {
  params: {
    bookingId: string;
  };
  searchParams: {
    confirmed?: string;
  };
};

export default async function BookingDetailPage({ params, searchParams }: Props) {
  const cookieHeader = headers().get('cookie') ?? '';
  const mockScenarioMatch = cookieHeader.match(/mock-scenario=([^;]+)/);
  const mockScenario = mockScenarioMatch ? mockScenarioMatch[1].trim() : null;

  if ((process.env.NODE_ENV === 'test' || process.env.CI === 'true') && mockScenario && MOCK_BOOKINGS[mockScenario]) {
    const booking = MOCK_BOOKINGS[mockScenario];
    const showConfirmation = searchParams.confirmed === 'true';
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <main className="mx-auto w-full max-w-3xl space-y-6 py-12 px-4">
          {showConfirmation && booking.status === 'CONFIRMED' && (
            <BookingConfirmationBanner pnrReference={booking.pnrReference ?? undefined} />
          )}
          <BookingDetailClient booking={booking as unknown as BookingDetailView} showConfirmation={showConfirmation} />
        </main>
      </div>
    );
  }

  const { bookingId } = params;
  const showConfirmation = searchParams.confirmed === 'true';

  const outcome = await getBookingDetail(bookingId);

  if (!outcome.ok) {
    if (outcome.reason === 'UNAUTHENTICATED') {
      const hasSessionCookie = cookieHeader.includes('next-auth') || cookieHeader.includes('__Secure-next-auth');
      redirect(hasSessionCookie ? '/login?message=session_expired' : '/login');
    }

    const error = outcome.reason === 'FORBIDDEN'
      ? 'You do not have access to this booking.'
      : outcome.reason === 'NOT_FOUND'
      ? 'We could not find this booking.'
      : (outcome.message || 'We could not load this booking. Please try again.');

    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <main className="mx-auto w-full max-w-3xl py-12 px-4">
          <p role="alert" className="card text-text-cancelled">
            {error}
          </p>
        </main>
      </div>
    );
  }

  const booking: BookingDetailView = outcome.data;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto w-full max-w-3xl space-y-6 py-12 px-4">
        {showConfirmation && booking.status === 'CONFIRMED' && (
          <BookingConfirmationBanner pnrReference={booking.pnrReference ?? undefined} />
        )}
        <BookingDetailClient 
          booking={booking} 
          showConfirmation={showConfirmation} 
          bookingId={bookingId}
        />
      </main>
    </div>
  );
}
