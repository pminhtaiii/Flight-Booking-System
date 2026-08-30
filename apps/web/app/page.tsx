import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { LandingPage } from '@/components/landing/LandingPage';
import { authOptions } from '@/lib/auth';

export default async function IndexPage(): Promise<JSX.Element> {
  const session = await getServerSession(authOptions);
  if (session?.user) {
    redirect('/dashboard');
  }

  return <LandingPage />;
}
