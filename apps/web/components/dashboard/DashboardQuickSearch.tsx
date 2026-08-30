'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { buildSearchUrl, validateQuickSearch } from './dashboard-search';

export function DashboardQuickSearch(): JSX.Element {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [departureDate, setDepartureDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const result = validateQuickSearch({ origin, destination, departureDate });
    if (!result.valid) {
      setError(result.error);
      return;
    }

    setError(null);
    router.push(buildSearchUrl(result.value));
  };

  return (
    <form onSubmit={handleSubmit} className="card space-y-4" noValidate>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label htmlFor="dashboard-origin" className="block text-sm font-medium text-text-secondary mb-1">
            Departure airport code
          </label>
          <input
            id="dashboard-origin"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            maxLength={3}
            autoComplete="off"
            className="form-input w-full uppercase"
          />
        </div>
        <div>
          <label htmlFor="dashboard-destination" className="block text-sm font-medium text-text-secondary mb-1">
            Arrival airport code
          </label>
          <input
            id="dashboard-destination"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            maxLength={3}
            autoComplete="off"
            className="form-input w-full uppercase"
          />
        </div>
        <div>
          <label htmlFor="dashboard-departure-date" className="block text-sm font-medium text-text-secondary mb-1">
            Departure date
          </label>
          <input
            id="dashboard-departure-date"
            type="date"
            value={departureDate}
            onChange={(event) => setDepartureDate(event.target.value)}
            className="form-input w-full"
          />
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" className="btn-primary">
        Search flights
      </button>
    </form>
  );
}
