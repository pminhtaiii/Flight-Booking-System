import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { Suspense } from 'react';
import { BookingsList, type BookingsResponse, type BookingTab } from '@/components/bookings/BookingsList';
import { Header } from '@/components/layout/Header';
import { authOptions } from '@/lib/auth';

type BookingsPageProps = {
  searchParams: {
    tab?: string;
    page?: string;
  };
};

export default async function BookingsPage({ searchParams }: BookingsPageProps) {
  const session = await getServerSession(authOptions);

  if (!session) {
    const cookieHeader = headers().get('cookie') ?? '';
    const hasSessionCookie = cookieHeader.includes('next-auth') || cookieHeader.includes('__Secure-next-auth');
    redirect(hasSessionCookie ? '/login?message=session_expired' : '/login');
  }

  const tab: BookingTab = searchParams.tab === 'past' ? 'past' : 'upcoming';
  const requestedPage = Number(searchParams.page);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const accessToken = (session as { accessToken?: string }).accessToken;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  let data: BookingsResponse | undefined;
  let error: string | undefined;

  try {
    const response = await fetch(`${apiUrl}/api/bookings?tab=${tab}&page=${page}&limit=20`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      cache: 'no-store',
    });
    if (!response.ok) {
      error = response.status === 403 ? 'You do not have access to these bookings.' : 'We could not load your bookings. Please try again.';
    } else {
      // The NestJS endpoint validates this response at its HTTP boundary before rendering.
      data = (await response.json()) as BookingsResponse;
    }
  } catch {
    error = 'We could not load your bookings. Please try again.';
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto w-full max-w-[1440px] flex-1 p-8">
        <Suspense fallback={<p className="card text-text-secondary">Loading your bookings…</p>}>
          <BookingsList data={data} tab={tab} error={error} />
        </Suspense>
      </main>
    </div>
  );
}
