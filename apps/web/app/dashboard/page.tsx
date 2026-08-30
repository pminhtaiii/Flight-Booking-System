import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { DashboardRecentBookings } from '@/components/dashboard/DashboardRecentBookings';
import { DashboardQuickActions } from '@/components/dashboard/DashboardQuickActions';
import { DashboardQuickSearch } from '@/components/dashboard/DashboardQuickSearch';
import { DashboardShell } from '@/components/dashboard/DashboardShell';
import { DashboardStats } from '@/components/dashboard/DashboardStats';
import { buildDashboardActions } from '@/components/dashboard/dashboard-actions';
import { authOptions } from '@/lib/auth';
import { isBookingReadinessEnabled } from '@/lib/featureFlags';
import { getDashboardSummary } from '@/lib/server/dashboard';
import styles from './dashboard.module.css';

export const dynamic = 'force-dynamic';

export default async function DashboardPage(): Promise<JSX.Element> {
  const outcome = await getDashboardSummary();

  if (!outcome.ok) {
    if (outcome.reason === 'UNAUTHENTICATED') {
      redirect('/login?callbackUrl=/dashboard');
    }

    throw new Error('Unable to load dashboard.');
  }

  const session = await getServerSession(authOptions);
  const user = {
    name: session?.user?.name,
    email: session?.user?.email,
  };
  const showProfileNavigation = isBookingReadinessEnabled();
  const dashboardActions = buildDashboardActions({ isBookingReadinessEnabled: showProfileNavigation });

  return (
    <DashboardShell user={user} showProfileNavigation={showProfileNavigation}>
      <section className={styles.quickSearchSection} aria-labelledby="quick-search-heading">
        <div className={styles.quickSectionHeader}>
          <h2 id="quick-search-heading" className={styles.quickSectionHeading}>
            Quick Search
          </h2>
          <p className={styles.quickSectionDescription}>Start a flight search with airport codes and your departure date.</p>
        </div>
        <DashboardQuickSearch />
      </section>
      <DashboardStats stats={outcome.data.stats} />
      <div className={styles.quickActionsSection}>
        <DashboardQuickActions actions={dashboardActions} />
      </div>
      <DashboardRecentBookings recentBookings={outcome.data.recentBookings} />
    </DashboardShell>
  );
}
