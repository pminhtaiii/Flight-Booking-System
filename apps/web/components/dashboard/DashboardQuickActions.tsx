import Link from 'next/link';
import { Search, Calendar, History, User } from 'lucide-react';
import { buildDashboardActions, type BuildDashboardActionsOptions } from './dashboard-actions';
import styles from '@/app/dashboard/dashboard.module.css';

type DashboardQuickActionsProps = BuildDashboardActionsOptions;

export function DashboardQuickActions({ isBookingReadinessEnabled }: DashboardQuickActionsProps): JSX.Element {
  const actions = buildDashboardActions({ isBookingReadinessEnabled });

  const getActionIcon = (iconName: string) => {
    switch (iconName) {
      case 'search':
        return <Search className={styles.actionIcon} aria-hidden="true" />;
      case 'calendar':
        return <Calendar className={styles.actionIcon} aria-hidden="true" />;
      case 'history':
        return <History className={styles.actionIcon} aria-hidden="true" />;
      case 'user':
        return <User className={styles.actionIcon} aria-hidden="true" />;
      default:
        return null;
    }
  };

  return (
    <section className={styles.quickActionsSection} role="region" aria-label="Quick Actions">
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionHeading}>Quick Actions</h2>
      </div>
      <div className={styles.actionsGrid}>
        {actions.map((action) => (
          <Link key={action.href} href={action.href} className={styles.actionCard}>
            <div className={styles.actionIconWrapper}>
              {getActionIcon(action.icon)}
            </div>
            <div className={styles.actionDetails}>
              <span className={styles.actionLabel}>{action.label}</span>
              <span className={styles.actionDescription}>{action.description}</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
