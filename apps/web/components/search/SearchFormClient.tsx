'use client';

import { useState } from 'react';
import Link from 'next/link';

interface FlightOffer {
  id: string;
  duffelOfferId: string;
  airline: string;
  flightNumber: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTime: string;
  arrivalTime: string;
  duration: number;
  stops: number;
  price: number;
  currency: string;
  fareClass: string | null;
  requestedCabinClass: string;
  cabinClassMatch: string;
}

interface SearchFormClientProps {
  accessToken: string;
}

export function SearchFormClient({ accessToken }: SearchFormClientProps) {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [departureDate, setDepartureDate] = useState('');
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [infants, setInfants] = useState(0);
  const [cabinClass, setCabinClass] = useState('economy');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offers, setOffers] = useState<FlightOffer[]>([]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setOffers([]);

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

    try {
      const response = await fetch(`${apiUrl}/api/flights/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          origin: origin.toUpperCase().trim(),
          destination: destination.toUpperCase().trim(),
          departureDate,
          adults: Number(adults),
          children: Number(children),
          infants: Number(infants),
          cabinClass,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || 'Failed to search flights. Please verify input data.');
      }

      const data = await response.json();
      setOffers(data.results || []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to connect to the search service.';
      setError(message);
    } finally {
      setLoading(false);
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
            <label htmlFor="destination" className="block text-sm font-medium text-text-secondary mb-1">
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
            <label htmlFor="departureDate" className="block text-sm font-medium text-text-secondary mb-1">
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
            <label htmlFor="cabinClass" className="block text-sm font-medium text-text-secondary mb-1">
              Cabin Class
            </label>
            <select
              id="cabinClass"
              value={cabinClass}
              onChange={(e) => setCabinClass(e.target.value)}
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
            <label htmlFor="children" className="block text-sm font-medium text-text-secondary mb-1">
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
              <div key={offer.id} className="card flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-text-primary">{offer.airline}</span>
                    <span className="text-xs text-text-muted font-normal">Flight {offer.flightNumber}</span>
                  </div>
                  <div className="flex gap-8 text-sm">
                    <div>
                      <p className="font-semibold text-text-primary">{offer.departureAirport}</p>
                      <p className="text-xs text-text-secondary">
                        {new Date(offer.departureTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <div className="flex flex-col items-center justify-center">
                      <span className="text-xs text-text-muted">{offer.stops === 0 ? 'Non-stop' : `${offer.stops} stops`}</span>
                      <div className="w-16 h-0.5 bg-secondary-border my-1"></div>
                      <span className="text-xs text-text-muted">{Math.floor(offer.duration / 60)}h {offer.duration % 60}m</span>
                    </div>
                    <div>
                      <p className="font-semibold text-text-primary">{offer.arrivalAirport}</p>
                      <p className="text-xs text-text-secondary">
                        {new Date(offer.arrivalTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
                  <Link
                    href={`/checkout/passengers?offerId=${offer.id}`}
                    className="btn-primary"
                  >
                    Book
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && !error && offers.length === 0 && (
        <div className="card text-center p-8">
          <p className="text-text-secondary">No flight offers search results yet. Enter search criteria and search.</p>
        </div>
      )}
    </div>
  );
}
