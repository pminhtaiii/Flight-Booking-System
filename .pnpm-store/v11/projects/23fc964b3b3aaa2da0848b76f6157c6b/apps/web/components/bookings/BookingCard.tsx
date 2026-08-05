/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';
import type { BookingListItemDto, FlightSnapshot } from '@shared/booking-types';
import type { BookingDisruptionDto } from '@shared/disruption-types';
import { DisruptionStatus } from '@shared/disruption-types';
import { BookingStatusBadge } from '@/components/bookings/BookingStatusBadge';
import { AlertTriangle } from 'lucide-react';

type BookingCardBooking = BookingListItemDto & {
  flightSnapshot?: FlightSnapshot | null;
  disruption?: BookingDisruptionDto;
};

type BookingCardProps = {
  booking: BookingCardBooking;
};

const formatDate = (value?: string): string => {
  if (!value) {
    return 'Processing details…';
  }

  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
};

const formatCurrency = (amount: string, currency: string): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Number(amount));

export function BookingCard({ booking }: BookingCardProps) {
  const firstSegment = booking.flightSnapshot?.segments[0];
  const airline = booking.airline ?? firstSegment?.airline;
  const origin = booking.origin ?? firstSegment?.departureAirport;
  const lastSegment = booking.flightSnapshot?.segments.at(-1);
  const destination = booking.destination ?? lastSegment?.arrivalAirport;
  const arrivalAt = lastSegment?.arrivalAt;
  const destinationLabel = destination?.city ?? 'Flight booking';
  const isProcessing = booking.status === 'PROCESSING';
  const isFailed = booking.status === 'FAILED';

  return (
    <article className="card flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {airline?.logoUrl ? (
            <img src={airline.logoUrl} alt={`${airline.name} logo`} className="h-10 w-10 rounded-lg border border-card-border object-contain" />
          ) : (
            <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-lg border border-card-border bg-background text-sm font-semibold text-text-secondary">
              {airline?.iataCode ?? '✈'}
            </span>
          )}
          <div>
            <h2 className="font-semibold text-text-primary">
              <Link href={`/bookings/${booking.id}`} className="hover:text-accent">
                {destinationLabel}
              </Link>
            </h2>
            <p className="text-sm text-text-secondary">
              {isProcessing ? 'Processing details…' : airline?.name ?? 'Airline details pending'}
            </p>
          </div>
          <BookingStatusBadge status={booking.status} />
          {booking.disruption && 
            (booking.disruption.status === DisruptionStatus.DETECTED || 
             booking.disruption.status === DisruptionStatus.ACKNOWLEDGED) && (
            <Link 
              href={`/bookings/${booking.id}`}
              className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                booking.disruption.status === DisruptionStatus.DETECTED
                  ? 'bg-bg-pending text-text-pending border-color-text-pending/30 hover:bg-bg-pending/80'
                  : 'bg-bg-match-fair text-text-match-fair border-color-text-match-fair/30 hover:bg-bg-match-fair/80'
              }`}
            >
              <AlertTriangle className="h-3 w-3" />
              <span>
                {booking.disruption.status === DisruptionStatus.DETECTED ? 'Schedule Action Needed' : 'Change Under Review'}
              </span>
            </Link>
          )}
        </div>

        <div className="grid gap-2 text-sm text-text-secondary sm:grid-cols-2">
          <p>
            {origin && destination ? `${origin.city} (${origin.iataCode}) to ${destination.city} (${destination.iataCode})` : 'Route details will appear when available'}
          </p>
          <p>
            {formatDate(booking.departureAt)}{arrivalAt ? ` – ${formatDate(arrivalAt)}` : ''}
          </p>
          {!isProcessing && booking.pnrReference && <p>PNR: {booking.pnrReference}</p>}
          <p>Total: {formatCurrency(booking.totalAmount, booking.currency)}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <Link href={`/bookings/${booking.id}`} className="btn-secondary">View booking</Link>
        {isFailed && <Link href={`/bookings/${booking.id}`} className="btn-primary">Retry booking</Link>}
      </div>
    </article>
  );
}
