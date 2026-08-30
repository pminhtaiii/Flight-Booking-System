'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { buildSearchUrl, validateQuickSearch } from './dashboard-search';
import styles from '@/app/dashboard/dashboard.module.css';

export function DashboardQuickSearch(): JSX.Element {
  const router = useRouter();
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [departureDate, setDepartureDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const result = validateQuickSearch({ origin, destination, departureDate });
    if (!result.valid) {
      setError(result.error ?? 'Invalid search parameters');
      return;
    }

    setError(null);
    const searchUrl = buildSearchUrl(result.value);
    router.push(searchUrl);
  };

  return (
    <section className={styles.quickSearchSection} aria-labelledby="quick-search-heading">
      <div className={styles.sectionHeader}>
        <h2 id="quick-search-heading" className={styles.sectionHeading}>
          Quick flight search
        </h2>
      </div>
      <form className={styles.quickSearchForm} onSubmit={handleSubmit} noValidate>
        <div className={styles.searchFields}>
          <div className={styles.inputGroup}>
            <label htmlFor="dashboard-origin-input" className={styles.inputLabel}>
              Departure airport code
            </label>
            <input
              id="dashboard-origin-input"
              type="text"
              aria-label="Departure airport code"
              placeholder="e.g. SGN"
              maxLength={4}
              value={origin}
              onChange={(e) => setOrigin(e.target.value.toUpperCase())}
              className={styles.searchInput}
            />
          </div>

          <div className={styles.inputGroup}>
            <label htmlFor="dashboard-dest-input" className={styles.inputLabel}>
              Arrival airport code
            </label>
            <input
              id="dashboard-dest-input"
              type="text"
              aria-label="Arrival airport code"
              placeholder="e.g. HAN"
              maxLength={4}
              value={destination}
              onChange={(e) => setDestination(e.target.value.toUpperCase())}
              className={styles.searchInput}
            />
          </div>

          <div className={styles.inputGroup}>
            <label htmlFor="dashboard-date-input" className={styles.inputLabel}>
              Departure date
            </label>
            <input
              id="dashboard-date-input"
              type="date"
              aria-label="Departure date"
              value={departureDate}
              onChange={(e) => setDepartureDate(e.target.value)}
              className={styles.searchInput}
            />
          </div>
        </div>

        {error ? <p className={styles.searchError} role="alert">{error}</p> : null}

        <button type="submit" className={styles.searchButton}>
          <Search className={styles.searchButtonIcon} aria-hidden="true" />
          <span>Search Flights</span>
        </button>
      </form>
    </section>
  );
}
