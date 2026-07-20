import type { BookingDetailDto } from '@shared/booking-types';
import { BookingStatusBadge } from '@/components/bookings/BookingStatusBadge';

type BookingDetailProps = {
  booking: BookingDetailDto;
};

const currencyFormatter = (amount: string, currency: string): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Number(amount) / 100);

export function BookingDetail({ booking }: BookingDetailProps) {
  const segments = booking.flightSnapshot?.segments ?? [];
  const passengers = booking.passengerSnapshot?.passengers ?? [];

  return (
    <section aria-labelledby="booking-detail-title" className="card space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 id="booking-detail-title" className="text-xl font-bold text-text-primary">Flight details</h2>
          {booking.pnrReference && <p className="mt-1 text-sm text-text-secondary">PNR: {booking.pnrReference}</p>}
        </div>
        <BookingStatusBadge status={booking.status} />
      </div>

      {segments.length > 0 && (
        <div className="space-y-4">
          {segments.map((segment) => (
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
            {passengers.map((passenger) => <li key={`${passenger.firstName}-${passenger.lastName}`}>{passenger.firstName} {passenger.lastName}</li>)}
          </ul>
        </div>
      )}

      <div className="border-t border-card-border pt-4">
        <h3 className="font-semibold text-text-primary">Payment summary</h3>
        <p className="mt-1 text-sm text-text-secondary">Total paid: {currencyFormatter(booking.totalAmount, booking.currency)}</p>
      </div>
    </section>
  );
}
