import { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/layout/Header';
import { FlightDetailPageClient } from '@/components/search/FlightDetailPageClient';
import { getAllAirports } from '@/lib/airport-service';

type Props = {
  params: {
    flightId: string;
  };
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return {
    title: `Flight Details - ${params.flightId}`,
    description: `Detailed itinerary, route map and booking for flight ${params.flightId}`,
  };
}

export default async function FlightDetailPage({ params }: Props) {
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
  if (!token) {
    redirect('/login?message=session_expired');
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${apiUrl}/api/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!res.ok) {
      redirect('/login?message=session_expired');
    }
  } catch {
    redirect('/login?message=session_expired');
  } finally {
    clearTimeout(timeoutId);
  }

  const flightId = params.flightId;
  const detailController = new AbortController();
  const detailTimeoutId = setTimeout(() => detailController.abort(), 5000);
  let detailRes;

  try {
    detailRes = await fetch(`${apiUrl}/api/flights/${flightId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
      signal: detailController.signal,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error fetching flight detail:', err);
    notFound();
  } finally {
    clearTimeout(detailTimeoutId);
  }

  if (!detailRes.ok) {
    if (detailRes.status === 410) {
      let recovery = null;
      try {
        const errorJson = await detailRes.json();
        if (
          errorJson &&
          errorJson.recovery &&
          errorJson.recovery.origin &&
          errorJson.recovery.destination &&
          errorJson.recovery.departureDate
        ) {
          recovery = errorJson.recovery;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Error parsing 410 recovery json:', err);
      }

      if (recovery) {
        const queryParams = new URLSearchParams({
          origin: recovery.origin,
          destination: recovery.destination,
          departureDate: recovery.departureDate,
          ...(recovery.returnDate ? { returnDate: recovery.returnDate } : {}),
          adults: String(recovery.adults || recovery.passengers || 1),
          children: String(recovery.children || 0),
          infants: String(recovery.infants || 0),
          cabinClass: recovery.cabinClass || 'economy',
          expired: 'true',
        });
        redirect(`/search?${queryParams.toString()}`);
      }
    }
    notFound();
  }

  const flightData = await detailRes.json();

  const allAirports = await getAllAirports();

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      <main className="flex-1 max-w-[1440px] w-full mx-auto p-8">
        <FlightDetailPageClient
          flight={flightData}
          allAirports={allAirports}
        />
      </main>
    </div>
  );
}
