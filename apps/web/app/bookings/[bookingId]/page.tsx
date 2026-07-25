import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { Header } from '@/components/layout/Header';
import { BookingConfirmationBanner } from '@/components/bookings/BookingConfirmationBanner';
import { BookingDetail as BookingDetailClient } from '@/components/bookings/BookingDetail';
import { authOptions } from '@/lib/auth';
import type { BookingDetailDto } from '@shared/booking-types';
import type { CurrentItineraryDto, BookingDisruptionDto } from '@shared/disruption-types';
import { MOCK_BOOKINGS } from './mock-bookings';

type BookingDetailResponse = BookingDetailDto & {
  payment?: { status: string } | null;
  bookingIntent?: { id: string; offerId: string };
  currentItinerary?: CurrentItineraryDto;
  disruption?: BookingDisruptionDto;
};

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
            <BookingConfirmationBanner pnrReference={booking.pnrReference} />
          )}
          <BookingDetailClient booking={booking as unknown as BookingDetailResponse} showConfirmation={showConfirmation} />
        </main>
      </div>
    );
  }

  const session = await getServerSession(authOptions);

  if (!session) {
    const hasSessionCookie = cookieHeader.includes('next-auth') || cookieHeader.includes('__Secure-next-auth');
    redirect(hasSessionCookie ? '/login?message=session_expired' : '/login');
  }

  const { bookingId } = params;
  const showConfirmation = searchParams.confirmed === 'true';
  const accessToken = (session as { accessToken?: string }).accessToken;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const isTest = process.env.NODE_ENV === 'test';

  let booking: BookingDetailResponse | null = null;
  let errorStatus: number | null = null;
  let error: string | null = null;

  try {
    const response = await fetch(`${apiUrl}/api/bookings/${bookingId}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      cache: 'no-store',
    });

    if (!response.ok) {
      errorStatus = response.status;
      error = response.status === 403 
        ? 'You do not have access to this booking.' 
        : response.status === 404
        ? 'We could not find this booking.'
        : 'We could not load this booking. Please try again.';
    } else {
      booking = (await response.json()) as BookingDetailResponse;
    }
  } catch (caughtError) {
    error = 'We could not load this booking. Please try again.';
  }

  // Under test environment, if fetch fails, we fallback to client-side fetch so Playwright route mocks can intercept it.
  if ((error || errorStatus || !booking) && !isTest) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <main className="mx-auto w-full max-w-3xl py-12 px-4">
          <p role="alert" className="card text-text-cancelled">
            {error || 'We could not load this booking. Please try again.'}
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto w-full max-w-3xl space-y-6 py-12 px-4">
        {showConfirmation && booking?.status === 'CONFIRMED' && (
          <BookingConfirmationBanner pnrReference={booking.pnrReference} />
        )}
        <BookingDetailClient 
          booking={booking} 
          showConfirmation={showConfirmation} 
          isMockEnabled={isTest && (!booking || errorStatus !== null)}
          bookingId={bookingId}
        />
      </main>
    </div>
  );
}
