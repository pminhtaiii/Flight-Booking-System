'use client';

import { DashboardShell } from '@/components/dashboard/DashboardShell';
import styles from './dashboard.module.css';

export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): JSX.Element {
  return (
    <DashboardShell user={{}}>
      <section className={styles.errorCard} aria-labelledby="dashboard-error-heading" role="alert">
        <p className={styles.errorEyebrow}>Dashboard unavailable</p>
        <h2 id="dashboard-error-heading" className={styles.errorHeading}>
          Unable to load dashboard
        </h2>
        <p className={styles.errorDescription}>
          We could not load your travel overview. Please wait a moment and try again.
        </p>
        <button className={styles.errorAction} type="button" onClick={reset}>
          Try Again
        </button>
      </section>
    </DashboardShell>
  );
}
