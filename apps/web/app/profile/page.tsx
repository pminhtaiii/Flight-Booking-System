import { getServerSession } from 'next-auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { TravelerProfileForm } from '@/components/profile/TravelerProfileForm';
import { authOptions } from '@/lib/auth';
import { fetchProfile, ProfileRequestError } from '@/lib/profile';
import { isBookingReadinessEnabled } from '@/lib/featureFlags';
import { getSafeReturnTarget } from '@/lib/safeReturnTarget';

function ProfileDisabledFallback(): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-6 py-16">
        <section className="card w-full space-y-4 p-8" aria-labelledby="profile-disabled-title">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-accent">Traveler profile</p>
          <h1 id="profile-disabled-title" className="text-3xl font-bold text-text-primary">Profile workspace is not available yet</h1>
          <p className="text-text-secondary">This workspace is being prepared for the next booking-readiness release. Your account is unchanged.</p>
        </section>
      </main>
    </div>
  );
}

function ProfileLoadError({ message }: { message: string }): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-6 py-16">
        <section className="card w-full space-y-4 p-8" aria-labelledby="profile-error-title">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-accent">Traveler profile</p>
          <h1 id="profile-error-title" className="text-3xl font-bold text-text-primary">We could not load your profile</h1>
          <p className="text-text-secondary">{message}</p>
          <a className="btn-primary inline-flex w-fit" href="/profile">Try again</a>
        </section>
      </main>
    </div>
  );
}

export default async function ProfilePage({
  searchParams,
}: {
  searchParams?: { returnTo?: string; [key: string]: string | undefined };
}): Promise<JSX.Element> {
  if (!isBookingReadinessEnabled()) {
    return <ProfileDisabledFallback />;
  }

  // Reject any passenger PII query parameters to prevent PII exposure in browser history/logs
  const hasPiiInQuery = Object.keys(searchParams || {}).some((key) =>
    ['name', 'email', 'phone', 'passport', 'dob', 'gender'].some((pii) => key.toLowerCase().includes(pii)),
  );

  if (hasPiiInQuery) {
    const safeReturn = getSafeReturnTarget(searchParams?.returnTo);
    const returnParam = safeReturn !== '/' ? `?returnTo=${encodeURIComponent(safeReturn)}` : '';
    redirect(`/profile${returnParam}`);
  }

  const session = await getServerSession(authOptions);

  if (!session) {
    const cookieHeader = headers().get('cookie') ?? '';
    const hasSessionCookie = cookieHeader.includes('next-auth') || cookieHeader.includes('__Secure-next-auth');
    redirect(hasSessionCookie ? '/login?message=session_expired' : '/login');
  }

  const accessToken = (session as { accessToken?: string }).accessToken;

  if (!accessToken) {
    redirect('/login');
  }

  try {
    const profile = await fetchProfile(accessToken);
    const returnTarget = getSafeReturnTarget(searchParams?.returnTo);

    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <TravelerProfileForm initialProfile={profile} returnTarget={returnTarget} />
      </div>
    );
  } catch (error: unknown) {
    if (error instanceof ProfileRequestError && (error.status === 401 || error.status === 403)) {
      redirect('/login?message=session_expired');
    }

    const message = error instanceof ProfileRequestError && error.status === 404
      ? 'The profile workspace is not enabled on the API yet.'
      : 'Please try again in a moment.';

    return <ProfileLoadError message={message} />;
  }
}
