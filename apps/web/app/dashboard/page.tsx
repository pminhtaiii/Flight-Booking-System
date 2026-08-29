import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { DashboardRecentBookings } from '@/components/dashboard/DashboardRecentBookings';
import { DashboardShell } from '@/components/dashboard/DashboardShell';
import { DashboardStats } from '@/components/dashboard/DashboardStats';
import { authOptions } from '@/lib/auth';
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

  return (
    <DashboardShell user={user}>
      <DashboardStats stats={outcome.data.stats} />
      <DashboardRecentBookings recentBookings={outcome.data.recentBookings} />
    </DashboardShell>
  );
}
