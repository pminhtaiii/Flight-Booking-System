/* eslint-disable @typescript-eslint/no-explicit-any */
import { ItineraryRevisionHistory } from '@/components/bookings/ItineraryRevisionHistory';
import { currencyFormatter } from './types';

export function BookingSummary({ booking, accessToken }: { booking: any; accessToken?: string }) {
  const segments = booking.currentItinerary?.segments ?? booking.flightSnapshot?.segments ?? [];
  const passengers = booking.passengerSnapshot?.passengers ?? [];
  return <>
    {segments.length > 0 && <div className="space-y-4">
      {segments.map((segment: any) => <article key={`${segment.flightNumber}-${segment.departureAt}`} className="rounded-lg border border-card-border p-4">
        <p className="font-semibold text-text-primary">{segment.airline.name} {segment.flightNumber}</p>
        <p className="mt-1 text-sm text-text-secondary">{segment.departureAirport.city} ({segment.departureAirport.iataCode}) to {segment.arrivalAirport.city} ({segment.arrivalAirport.iataCode})</p>
        <p className="mt-2 text-sm text-text-secondary">{new Date(segment.departureAt).toLocaleString('en-GB')} â€“ {new Date(segment.arrivalAt).toLocaleString('en-GB')}</p>
      </article>)}
      {booking.flightSnapshot?.baggageAllowance && <p className="text-sm text-text-secondary">Baggage: {booking.flightSnapshot.baggageAllowance}</p>}
    </div>}
    {passengers.length > 0 && <div><h3 className="font-semibold text-text-primary">Passengers</h3><ul className="mt-2 space-y-2 text-sm text-text-secondary">{passengers.map((passenger: any) => <li key={`${passenger.firstName}-${passenger.lastName}`}>{passenger.firstName} {passenger.lastName}</li>)}</ul></div>}
    <div className="border-t border-card-border pt-4"><h3 className="font-semibold text-text-primary">Payment summary</h3><p className="mt-1 text-sm text-text-secondary">Total paid: {currencyFormatter(booking.totalAmount, booking.currency)}</p></div>
    {accessToken && <div className="mt-8 border-t border-card-border pt-6"><ItineraryRevisionHistory bookingId={booking.id} accessToken={accessToken} /></div>}
  </>;
}
