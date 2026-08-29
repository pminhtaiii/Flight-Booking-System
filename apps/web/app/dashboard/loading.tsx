import { DashboardShell } from '@/components/dashboard/DashboardShell';
import styles from './dashboard.module.css';

export default function DashboardLoading(): JSX.Element {
  return (
    <DashboardShell user={{}}>
      <div className={styles.loadingContent} aria-busy="true" aria-live="polite">
        <p className={styles.visuallyHidden} role="status">
          Loading dashboard
        </p>
        <section className={styles.statsSection} aria-hidden="true">
          <div className={styles.statsGrid}>
            {Array.from({ length: 4 }, (_, index) => (
              <div className={`${styles.metricCard} ${styles.skeletonMetricCard}`} key={index}>
                <span className={`${styles.skeletonBlock} ${styles.skeletonLabel}`} />
                <span className={`${styles.skeletonBlock} ${styles.skeletonValue}`} />
              </div>
            ))}
          </div>
        </section>
        <section className={styles.recentBookingsSection} aria-hidden="true">
          <div className={styles.sectionHeader}>
            <span className={`${styles.skeletonBlock} ${styles.skeletonHeading}`} />
            <span className={`${styles.skeletonBlock} ${styles.skeletonLink}`} />
          </div>
          <div className={styles.skeletonList}>
            {Array.from({ length: 5 }, (_, index) => (
              <div className={styles.skeletonRow} key={index}>
                <span className={`${styles.skeletonBlock} ${styles.skeletonRoute}`} />
                <span className={`${styles.skeletonBlock} ${styles.skeletonStatus}`} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </DashboardShell>
  );
}
