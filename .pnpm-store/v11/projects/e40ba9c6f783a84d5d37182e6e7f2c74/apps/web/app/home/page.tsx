import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { AuthenticatedHome } from '@/components/home/AuthenticatedHome';
import { authOptions } from '@/lib/auth';

export default async function HomePage(): Promise<JSX.Element> {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/login');
  }

  return <AuthenticatedHome displayName={session.user?.name ?? undefined} />;
}
