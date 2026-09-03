'use client';

import React, { type FormEvent, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  FlightSearchMeta,
  FlightSearchOfferView,
  FlightSearchOutcome,
  FlightSearchQuery,
  FlightSelectionOutcome,
} from '@shared/types';
import { FlightResultsControls, type FlightSortOption } from './FlightResultsControls';
import { FlightResults } from './FlightResults';
import { isCabinClass } from '@/lib/search-prefill';

export type SearchFormClientProps = {
  initialValues?: Partial<FlightSearchQuery>;
  initialOutcome?: FlightSearchOutcome | null;
  initialSortBy?: FlightSortOption;
  initialBookingOfferId?: string | null;
  onSearchAction?: (query: FlightSearchQuery) => Promise<FlightSearchOutcome>;
  onSelectAction?: (offerId: string) => Promise<FlightSelectionOutcome>;
  onNavigate?: (url: string) => void;
  onBookFlightCapture?: (fn: (offerId: string) => Promise<void>) => void;
  onSubmitCapture?: (fn: (event?: FormEvent<HTMLFormElement>) => Promise<void>) => void;
};

function useSafeRouter(): { push: (url: string) => void } | null {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useRouter();
  } catch {
    return null;
  }
}

export function SearchFormClient({
  initialValues,
  initialOutcome,
  initialSortBy,
  initialBookingOfferId,
  onSearchAction,
  onSelectAction,
  onNavigate,
  onBookFlightCapture,
  onSubmitCapture,
}: SearchFormClientProps): JSX.Element {
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
  const [error, setError] = useState<string | null>(
    initialOutcome && !initialOutcome.ok ? initialOutcome.message : null,
  );
  const [mode, setMode] = useState<'MATCHED' | 'RANKED' | null>(
    initialOutcome && initialOutcome.ok ? (initialOutcome.mode ?? null) : null,
  );
  const [offers, setOffers] = useState<FlightSearchOfferView[]>(
    initialOutcome && initialOutcome.ok ? initialOutcome.offers : [],
  );
  const [meta, setMeta] = useState<FlightSearchMeta | null>(
    initialOutcome && initialOutcome.ok ? initialOutcome.meta : null,
  );
  const [sortBy, setSortBy] = useState<FlightSortOption | undefined>(initialSortBy);
  const [bookingOfferId, setBookingOfferId] = useState<string | null>(
    initialBookingOfferId ?? null,
  );
  const bookingOfferIdRef = useRef<string | null>(initialBookingOfferId ?? null);
  const router = useSafeRouter();

  const isBooking = bookingOfferId !== null;
  const isFormDisabled = loading || isBooking;

  const handleSubmit = async (event?: FormEvent<HTMLFormElement>): Promise<void> => {
    event?.preventDefault();
    if (loading || bookingOfferId !== null || bookingOfferIdRef.current !== null) {
      return;
    }
    setLoading(true);
    setError(null);
    setMode(null);
    setOffers([]);
    setMeta(null);
    setSortBy(undefined);

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

      const searchAction =
        onSearchAction ??
        (async (q: FlightSearchQuery): Promise<FlightSearchOutcome> => {
          const { searchFlightsAction } = await import('@/app/search/actions');
          return searchFlightsAction(q);
        });

      const outcome = await searchAction(query);

      if (outcome.ok) {
        setMode(outcome.mode ?? null);
        setOffers(outcome.offers);
        setMeta(outcome.meta);
        setSortBy(undefined);
      } else {
        setError(outcome.message);
        setMode(null);
        setOffers([]);
        setMeta(null);
      }
    } catch {
      setError('Failed to connect to the search service.');
      setMode(null);
      setOffers([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  };

  const handleBook = async (offerId: string): Promise<void> => {
    if (bookingOfferId !== null || bookingOfferIdRef.current !== null) {
      return;
    }
    bookingOfferIdRef.current = offerId;
    setBookingOfferId(offerId);
    setError(null);
    let navigating = false;
    try {
      const selectAction =
        onSelectAction ??
        (async (id: string): Promise<FlightSelectionOutcome> => {
          const { selectFlightOfferAction } = await import('@/app/search/actions');
          return selectFlightOfferAction(id);
        });

      const outcome = await selectAction(offerId);

      if (outcome.ok) {
        try {
          if (onNavigate) {
            onNavigate(outcome.checkoutPath);
          } else if (router) {
            router.push(outcome.checkoutPath);
          } else if (typeof window !== 'undefined') {
            window.location.href = outcome.checkoutPath;
          }
          navigating = true;
        } catch {
          setError('Failed to navigate to checkout. Please try again.');
        }
      } else {
        setError(outcome.message);
      }
    } catch {
      setError('Flight offer is temporarily unavailable. Please try again in a few moments.');
    } finally {
      if (!navigating) {
        bookingOfferIdRef.current = null;
        setBookingOfferId(null);
      }
    }
  };

  onBookFlightCapture?.(handleBook);
  onSubmitCapture?.(handleSubmit);

  return (
    <div className="space-y-8">
      <form onSubmit={handleSubmit} className="card space-y-6">
        <fieldset disabled={isFormDisabled} className="space-y-6 border-0 p-0 m-0 min-w-0">
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
        </fieldset>

        <div className="flex justify-end pt-4">
          <button
            type="submit"
            disabled={isFormDisabled}
            className="btn-primary min-h-[44px] w-full md:w-auto"
          >
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

      {mode && offers.length > 0 && (
        <FlightResultsControls
          mode={mode}
          totalResults={offers.length}
          sortBy={sortBy}
          onSortChange={setSortBy}
        />
      )}

      {(mode !== null || offers.length > 0) && (
        <FlightResults
          offers={offers}
          mode={mode ?? undefined}
          meta={meta}
          sortBy={sortBy}
          onSelectFlight={handleBook}
          bookingOfferId={bookingOfferId}
        />
      )}

      {!loading && !error && !mode && offers.length === 0 && (
        <div className="card text-center p-8">
          <p className="text-text-secondary">
            No flight offers search results yet. Enter search criteria and search.
          </p>
        </div>
      )}
    </div>
  );
}
