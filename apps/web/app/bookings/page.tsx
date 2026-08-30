import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { Suspense } from 'react';
import { BookingsList, type BookingTab } from '@/components/bookings/BookingsList';
import { Header } from '@/components/layout/Header';
import { listBookings } from '@/lib/server/booking-management';
import type { BookingListView } from '@shared/types/booking-management.types';

type BookingsPageProps = {
  searchParams: {
    tab?: string;
    page?: string;
  };
};

export default async function BookingsPage({ searchParams }: BookingsPageProps) {
  const tab: BookingTab = searchParams.tab === 'past' ? 'past' : 'upcoming';
  const requestedPage = Number(searchParams.page);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const outcome = await listBookings(tab, page, 20);

  if (!outcome.ok) {
    if (outcome.reason === 'UNAUTHENTICATED') {
      const cookieHeader = headers().get('cookie') ?? '';
      const hasSessionCookie =
        cookieHeader.includes('next-auth') || cookieHeader.includes('__Secure-next-auth');
      redirect(hasSessionCookie ? '/login?message=session_expired' : '/login');
    }

    const error =
      outcome.reason === 'FORBIDDEN'
        ? 'You do not have access to these bookings.'
        : outcome.message || 'We could not load your bookings. Please try again.';

    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <main className="mx-auto w-full max-w-[1440px] flex-1 p-8">
          <Suspense fallback={<p className="card text-text-secondary">Loading your bookings…</p>}>
            <BookingsList tab={tab} error={error} />
          </Suspense>
        </main>
      </div>
    );
  }

  const data: BookingListView = outcome.data;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto w-full max-w-[1440px] flex-1 p-8">
        <Suspense fallback={<p className="card text-text-secondary">Loading your bookings…</p>}>
          <BookingsList data={data} tab={tab} />
        </Suspense>
      </main>
    </div>
  );
}
