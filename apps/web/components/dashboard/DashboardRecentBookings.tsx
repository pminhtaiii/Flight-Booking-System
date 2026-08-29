import Link from 'next/link';
import { Plane } from 'lucide-react';
import type { DashboardRecentBooking } from '@shared/types';
import styles from '@/app/dashboard/dashboard.module.css';

type DashboardRecentBookingsProps = {
  recentBookings: DashboardRecentBooking[];
};

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeZone: 'UTC',
});

function formatBookingDate(date: string): string {
  return dateFormatter.format(new Date(date));
}

function getStatusClassName(status: DashboardRecentBooking['status']): string {
  if (status === 'CONFIRMED') {
    return styles.statusConfirmed;
  }

  if (status === 'COMPLETED') {
    return styles.statusCompleted;
  }

  if (
    status === 'CANCELLATION_PENDING' ||
    status.startsWith('CANCELLED') ||
    status === 'REFUND_FAILED_NEEDS_ATTENTION'
  ) {
    return styles.statusCancelled;
  }

  return styles.statusPending;
}

export function DashboardRecentBookings({ recentBookings }: DashboardRecentBookingsProps) {
  const visibleBookings = recentBookings.slice(0, 5);

  return (
    <section className={styles.recentBookingsSection} aria-labelledby="recent-bookings-heading">
      <div className={styles.sectionHeader}>
        <h2 id="recent-bookings-heading" className={styles.sectionHeading}>
          Recent bookings
        </h2>
        <Link className={styles.viewAllLink} href="/bookings">
          View all bookings
        </Link>
      </div>

      {visibleBookings.length > 0 ? (
        <ul className={styles.bookingList}>
          {visibleBookings.map((booking) => {
            const displayedDate = booking.departureAt ?? booking.createdAt;

            return (
              <li key={booking.id} className={styles.bookingListItem}>
                <Link className={styles.bookingLink} href={`/bookings/${booking.id}`}>
                  <div className={styles.bookingPrimaryContent}>
                    <p className={styles.flightNumber}>{booking.flightNumber || 'Flight'}</p>
                    {booking.airlineCode ? <p className={styles.airlineCode}>{booking.airlineCode}</p> : null}
                    <p className={styles.bookingRoute}>
                      <span className={styles.routeCode}>{booking.originCode || '—'}</span>
                      <span className={styles.routeSeparator} aria-hidden="true">
                        →
                      </span>
                      <span className={styles.routeCode}>{booking.destinationCode || '—'}</span>
                    </p>
                  </div>
                  <div className={styles.bookingSecondaryContent}>
                    <time className={styles.bookingDate} dateTime={displayedDate}>
                      {formatBookingDate(displayedDate)}
                    </time>
                    <span className={`${styles.statusBadge} ${getStatusClassName(booking.status)}`}>
                      {booking.status}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={styles.emptyState}>
          <div className={styles.emptyStateIllustration} role="img" aria-label="Empty booking illustration">
            <Plane aria-hidden="true" />
          </div>
          <h3 className={styles.emptyStateHeading}>No bookings yet</h3>
          <p className={styles.emptyStateDescription}>Search for a flight to begin planning your next trip.</p>
          <Link className={styles.emptyStateAction} href="/search">
            Search Flights
          </Link>
        </div>
      )}
    </section>
  );
}
