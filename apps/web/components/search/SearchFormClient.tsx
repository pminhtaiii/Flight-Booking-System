'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { FlightSearchOfferView, FlightSearchQuery } from '@shared/types';
import { searchFlightsAction, selectFlightOfferAction } from '@/app/search/actions';

const isCabinClass = (value: string): value is FlightSearchQuery['cabinClass'] =>
  value === 'economy' || value === 'premium_economy' || value === 'business' || value === 'first';

const formatDuration = (duration: string): string => {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(duration);
  if (!match || match.slice(1).every((value: string | undefined): boolean => value === undefined))
    return duration;

  const [days, hours, minutes, seconds] = match
    .slice(1)
    .map((value: string | undefined): number => Number(value ?? 0));
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return duration;

  const totalMinutes = days * 1_440 + hours * 60 + minutes + Math.ceil(seconds / 60);
  if (!Number.isSafeInteger(totalMinutes)) return duration;

  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
};

type SearchFormClientProps = {
  initialValues?: Partial<FlightSearchQuery>;
};

export function SearchFormClient({ initialValues }: SearchFormClientProps): JSX.Element {
  const [origin, setOrigin] = useState(initialValues?.origin ?? '');
  const [destination, setDestination] = useState(initialValues?.destination ?? '');
  const [departureDate, setDepartureDate] = useState(initialValues?.departureDate ?? '');
  const [adults, setAdults] = useState(initialValues?.adults ?? 1);
  const [children, setChildren] = useState(initialValues?.children ?? 0);
  const [infants, setInfants] = useState(initialValues?.infants ?? 0);
  const [cabinClass, setCabinClass] = useState<FlightSearchQuery['cabinClass']>(
    initialValues?.cabinClass ?? 'economy',
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offers, setOffers] = useState<FlightSearchOfferView[]>([]);
  const [bookingOfferId, setBookingOfferId] = useState<string | null>(null);
  const router = useRouter();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setOffers([]);

    try {
      const query: FlightSearchQuery = {
        origin: origin.toUpperCase().trim(),
        destination: destination.toUpperCase().trim(),
        departureDate,
        returnDate: null,
        adults: Number(adults),
        children: Number(children),
        infants: Number(infants),
        cabinClass,
      };
      const outcome = await searchFlightsAction(query);

      if (outcome.ok) {
        setOffers(outcome.offers);
      } else {
        setError(outcome.message);
      }
    } catch {
      setError('Failed to connect to the search service.');
    } finally {
      setLoading(false);
    }
  };

  const handleBook = async (offerId: string): Promise<void> => {
    setBookingOfferId(offerId);
    setError(null);
    try {
      const outcome = await selectFlightOfferAction(offerId);

      if (outcome.ok) {
        router.push(outcome.checkoutPath);
      } else {
        setError(outcome.message);
      }
    } catch {
      setError('Flight offer is temporarily unavailable. Please try again in a few moments.');
    } finally {
      setBookingOfferId(null);
    }
  };

  return (
    <div className="space-y-8">
      <form onSubmit={handleSubmit} className="card space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label htmlFor="origin" className="block text-sm font-medium text-text-secondary mb-1">
              Origin (IATA)
            </label>
            <input
              id="origin"
              type="text"
              required
              maxLength={3}
              pattern="[A-Za-z]{3}"
              placeholder="e.g. JFK"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              className="form-input w-full uppercase"
            />
          </div>

          <div>
            <label
              htmlFor="destination"
              className="block text-sm font-medium text-text-secondary mb-1"
            >
              Destination (IATA)
            </label>
            <input
              id="destination"
              type="text"
              required
              maxLength={3}
              pattern="[A-Za-z]{3}"
              placeholder="e.g. LHR"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              className="form-input w-full uppercase"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label
              htmlFor="departureDate"
              className="block text-sm font-medium text-text-secondary mb-1"
            >
              Departure Date
            </label>
            <input
              id="departureDate"
              type="date"
              required
              value={departureDate}
              onChange={(e) => setDepartureDate(e.target.value)}
              className="form-input w-full"
            />
          </div>

          <div>
            <label
              htmlFor="cabinClass"
              className="block text-sm font-medium text-text-secondary mb-1"
            >
              Cabin Class
            </label>
            <select
              id="cabinClass"
              value={cabinClass}
              onChange={(event) => {
                if (isCabinClass(event.target.value)) {
                  setCabinClass(event.target.value);
                }
              }}
              className="form-input w-full animate-none"
            >
              <option value="economy">Economy</option>
              <option value="premium_economy">Premium Economy</option>
              <option value="business">Business</option>
              <option value="first">First</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label htmlFor="adults" className="block text-sm font-medium text-text-secondary mb-1">
              Adults
            </label>
            <input
              id="adults"
              type="number"
              min={1}
              max={9}
              required
              value={adults}
              onChange={(e) => setAdults(Number(e.target.value))}
              className="form-input w-full"
            />
          </div>
          <div>
            <label
              htmlFor="children"
              className="block text-sm font-medium text-text-secondary mb-1"
            >
              Children
            </label>
            <input
              id="children"
              type="number"
              min={0}
              max={9}
              value={children}
              onChange={(e) => setChildren(Number(e.target.value))}
              className="form-input w-full"
            />
          </div>
          <div>
            <label htmlFor="infants" className="block text-sm font-medium text-text-secondary mb-1">
              Infants
            </label>
            <input
              id="infants"
              type="number"
              min={0}
              max={9}
              value={infants}
              onChange={(e) => setInfants(Number(e.target.value))}
              className="form-input w-full"
            />
          </div>
        </div>

        <div className="flex justify-end pt-4">
          <button type="submit" disabled={loading} className="btn-primary w-full md:w-auto">
            {loading ? 'Searching...' : 'Search Flights'}
          </button>
        </div>
      </form>

      {error && (
        <div role="alert" className="card bg-bg-cancelled text-text-cancelled p-4">
          <p className="font-semibold text-text-cancelled">Search Error</p>
          <p className="text-sm mt-1">{error}</p>
        </div>
      )}

      {offers.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-xl font-bold text-text-primary">Flight Offers</h2>
          <div className="space-y-4">
            {offers.map((offer) => (
              <div
                key={offer.id}
                className="card flex flex-col md:flex-row justify-between items-start md:items-center gap-4"
              >
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-text-primary">{offer.airline}</span>
                    <span className="text-xs text-text-muted font-normal">
                      Flight {offer.flightNumber}
                    </span>
                  </div>
                  <div className="flex gap-8 text-sm">
                    <div>
                      <p className="font-semibold text-text-primary">{offer.origin}</p>
                      <p className="text-xs text-text-secondary">
                        {new Date(offer.departureAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                    <div className="flex flex-col items-center justify-center">
                      <span className="text-xs text-text-muted">
                        {offer.stops === 0 ? 'Non-stop' : `${offer.stops} stops`}
                      </span>
                      <div className="w-16 h-0.5 bg-secondary-border my-1"></div>
                      <span className="text-xs text-text-muted">
                        {formatDuration(offer.duration)}
                      </span>
                    </div>
                    <div>
                      <p className="font-semibold text-text-primary">{offer.destination}</p>
                      <p className="text-xs text-text-secondary">
                        {new Date(offer.arrivalAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex flex-row md:flex-col items-end justify-between w-full md:w-auto gap-4 pt-4 md:pt-0 border-t md:border-t-0 border-secondary-border">
                  <div>
                    <span className="text-2xl font-bold text-text-primary">
                      {offer.price} {offer.currency}
                    </span>
                  </div>
                  <button
                    onClick={() => handleBook(offer.id)}
                    disabled={bookingOfferId !== null}
                    className="btn-primary"
                  >
                    {bookingOfferId === offer.id ? 'Loading...' : 'Book'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && !error && offers.length === 0 && (
        <div className="card text-center p-8">
          <p className="text-text-secondary">
            No flight offers search results yet. Enter search criteria and search.
          </p>
        </div>
      )}
    </div>
  );
}
