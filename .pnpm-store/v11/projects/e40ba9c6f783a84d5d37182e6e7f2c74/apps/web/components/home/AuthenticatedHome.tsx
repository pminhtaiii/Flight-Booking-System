import Link from 'next/link';
import { Suspense } from 'react';
import { LogoutButton } from '@/components/auth/LogoutButton';
import { HomeMapBackgroundData } from './HomeMapBackgroundData';
import styles from './authenticated-home.module.css';

type AuthenticatedHomeProps = {
  displayName?: string;
};

export function AuthenticatedHome({ displayName }: AuthenticatedHomeProps): JSX.Element {
  const welcomeMessage = displayName ? `Welcome back, ${displayName}` : 'Welcome back';

  return (
    <div className={styles.page}>
      <Suspense fallback={null}>
        <HomeMapBackgroundData />
      </Suspense>
      <div className={styles.veil} aria-hidden="true" />
      <header className={styles.header}>
        <nav className={styles.navigation} aria-label="Primary navigation">
          <Link className={styles.brand} href="/home" aria-current="page">
            wayfinder<span aria-hidden="true">°</span>
          </Link>
          <div className={styles.navigationActions}>
            <Link className={styles.navigationLink} href="/search">
              <span className={styles.fullLabel}>Search flights</span>
              <span className={styles.shortLabel} aria-hidden="true">Search</span>
            </Link>
            <Link className={styles.navigationLink} href="/bookings">
              <span className={styles.fullLabel}>My bookings</span>
              <span className={styles.shortLabel} aria-hidden="true">Bookings</span>
            </Link>
            <LogoutButton />
          </div>
        </nav>
      </header>

      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="authenticated-home-title">
          <p className={styles.eyebrow}>{welcomeMessage}</p>
          <h1 id="authenticated-home-title">Where would you like to go next?</h1>
          <p className={styles.description}>
            Start with a route, then shape the journey around what matters to you.
          </p>
          <Link className={styles.primaryAction} href="/search">
            Plan a trip
          </Link>
        </section>
      </main>
    </div>
  );
}
