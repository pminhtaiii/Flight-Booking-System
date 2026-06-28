import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/layout/Header';

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    const cookieHeader = headers().get('cookie') || '';
    const hasSessionCookie =
      cookieHeader.includes('next-auth') || cookieHeader.includes('__Secure-next-auth');

    if (hasSessionCookie) {
      redirect('/login?message=session_expired');
    }
    redirect('/login');
  }

  const token = (session as { accessToken?: string }).accessToken;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

  try {
    const res = await fetch(`${apiUrl}/api/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      redirect('/login?message=session_expired');
    }
  } catch {
    redirect('/login?message=session_expired');
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      <main className="flex-1 max-w-[1440px] w-full mx-auto p-8">
        <div className="card">
          <h2 className="text-lg font-semibold text-text-primary mb-2">
            Welcome to your Dashboard
          </h2>
          <p className="text-sm text-text-secondary">Logged in as {session.user?.email}</p>
        </div>
      </main>
    </div>
  );
}
