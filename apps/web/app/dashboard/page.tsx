import { getServerSession } from 'next-auth';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { DashboardQuickActions } from '@/components/dashboard/DashboardQuickActions';
import { DashboardQuickSearch } from '@/components/dashboard/DashboardQuickSearch';
import { DashboardRecentBookings } from '@/components/dashboard/DashboardRecentBookings';
import { DashboardShell } from '@/components/dashboard/DashboardShell';
import { DashboardStats } from '@/components/dashboard/DashboardStats';
import { authOptions } from '@/lib/auth';
import { isBookingReadinessEnabled } from '@/lib/featureFlags';
import { getDashboardSummary } from '@/lib/server/dashboard';

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

  const cookieStore = cookies();
  const mockScenario = cookieStore.get('mock-scenario')?.value;
  let readinessEnabled = isBookingReadinessEnabled();
  if (mockScenario === 'dashboard-readiness-disabled') {
    readinessEnabled = false;
  } else if (mockScenario === 'dashboard-readiness-enabled') {
    readinessEnabled = true;
  }

  return (
    <DashboardShell user={user}>
      <DashboardStats stats={outcome.data.stats} />
      <DashboardQuickSearch />
      <DashboardQuickActions isBookingReadinessEnabled={readinessEnabled} />
      <DashboardRecentBookings recentBookings={outcome.data.recentBookings} />
    </DashboardShell>
  );
}
