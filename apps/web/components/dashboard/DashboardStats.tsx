import { Calendar, CheckCircle2, Plane, XCircle, type LucideIcon } from 'lucide-react';
import type { DashboardStats as DashboardStatsData } from '@shared/types';
import styles from '@/app/dashboard/dashboard.module.css';

type DashboardStatsProps = {
  stats: DashboardStatsData;
};

type Metric = {
  label: string;
  value: number;
  icon: LucideIcon;
  className: string;
};

export function DashboardStats({ stats }: DashboardStatsProps) {
  const metrics: Metric[] = [
    {
      label: 'Total Bookings',
      value: stats.totalBookings,
      icon: Plane,
      className: styles.totalMetric,
    },
    {
      label: 'Upcoming Bookings',
      value: stats.upcomingBookings,
      icon: Calendar,
      className: styles.upcomingMetric,
    },
    {
      label: 'Completed Bookings',
      value: stats.completedBookings,
      icon: CheckCircle2,
      className: styles.completedMetric,
    },
    {
      label: 'Cancelled Bookings',
      value: stats.cancelledBookings,
      icon: XCircle,
      className: styles.cancelledMetric,
    },
  ];

  return (
    <section className={styles.statsSection} aria-labelledby="dashboard-stats-heading">
      <h2 id="dashboard-stats-heading" className={styles.visuallyHidden}>
        Booking statistics
      </h2>
      <div className={styles.statsGrid}>
        {metrics.map(({ label, value, icon: Icon, className }) => (
          <article key={label} className={`${styles.metricCard} ${className}`}>
            <div className={styles.metricHeading}>
              <h3 className={styles.metricLabel}>{label}</h3>
              <Icon className={styles.metricIcon} aria-hidden="true" />
            </div>
            <p className={styles.metricValue}>{value}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
