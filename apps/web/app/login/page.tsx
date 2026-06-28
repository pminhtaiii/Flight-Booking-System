import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { LoginForm } from '@/components/auth/LoginForm';

interface LoginPageProps {
  searchParams: {
    message?: string;
  };
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await getServerSession(authOptions);
  if (session) {
    redirect('/dashboard');
  }

  const isExpired = searchParams?.message === 'session_expired';

  return (
    <div className="flex min-h-screen items-center justify-center p-8 bg-background">
      <div className="card w-full max-w-md">
        <h2 className="text-lg font-semibold text-text-primary mb-6">Sign In</h2>

        {isExpired && (
          <div className="mb-4 p-3 bg-bg-cancelled border border-danger-border rounded-lg text-sm text-danger-foreground font-medium">
            Your session has expired. Please log in again.
          </div>
        )}

        <LoginForm />
      </div>
    </div>
  );
}
