'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { BookingListItemDto, FlightSnapshot } from '@shared/booking-types';
import { BookingCard } from '@/components/bookings/BookingCard';

export type BookingTab = 'upcoming' | 'past';

type BookingListItem = BookingListItemDto & {
  flightSnapshot?: FlightSnapshot | null;
};

export type BookingsResponse = {
  bookings: BookingListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

type BookingsListProps = {
  data?: BookingsResponse;
  tab: BookingTab;
  error?: string;
};

export function BookingsList({ data, tab, error }: BookingsListProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const page = data?.pagination.page ?? 1;

  const updateQuery = (tab: BookingTab, nextPage: number): void => {
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.set('tab', tab);
    nextSearchParams.set('page', String(nextPage));
    router.push(`/bookings?${nextSearchParams.toString()}`);
  };

  const bookings = data?.bookings ?? [];

  return (
    <section aria-labelledby="my-bookings-title" className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 id="my-bookings-title" className="text-2xl font-bold text-text-primary">My Bookings</h1>
          <p className="mt-1 text-sm text-text-secondary">View the latest status of every flight you have booked.</p>
        </div>
        <div role="tablist" aria-label="Booking history" className="flex gap-2">
          {(['upcoming', 'past'] as const).map((tabName) => (
            <button
              key={tabName}
              type="button"
              role="tab"
              aria-selected={tab === tabName}
              onClick={() => updateQuery(tabName, 1)}
              className={tab === tabName ? 'btn-primary' : 'btn-secondary'}
            >
              {tabName === 'upcoming' ? 'Upcoming' : 'Past'}
            </button>
          ))}
        </div>
      </div>

      {error && <p role="alert" className="card text-text-cancelled">{error}</p>}
      {!error && !data && <p className="card text-text-secondary">Loading your bookings…</p>}
      {!error && data && bookings.length === 0 && (
        <div className="card space-y-4 text-center">
          <p className="text-text-secondary">No bookings yet — start planning your next trip.</p>
          <Link href="/search" className="btn-primary">Search Flights</Link>
        </div>
      )}
      {!error && bookings.length > 0 && <div className="space-y-4">{bookings.map((booking) => <BookingCard key={booking.id} booking={booking} />)}</div>}

      {data && data.pagination.totalPages > 1 && (
        <nav aria-label="Booking pages" className="flex items-center justify-between gap-4">
          <button type="button" onClick={() => updateQuery(tab, page - 1)} disabled={page === 1} className="btn-secondary disabled:cursor-not-allowed disabled:opacity-50">
            Previous
          </button>
          <p className="text-sm text-text-secondary">Page {data.pagination.page} of {data.pagination.totalPages}</p>
          <button type="button" onClick={() => updateQuery(tab, page + 1)} disabled={page >= data.pagination.totalPages} className="btn-secondary disabled:cursor-not-allowed disabled:opacity-50">
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
