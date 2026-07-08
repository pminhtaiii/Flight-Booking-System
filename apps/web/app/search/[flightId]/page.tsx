import { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/layout/Header';
import { FlightDetailPageClient } from '@/components/search/FlightDetailPageClient';
import { getAirportByIataCode, getAllAirports } from '@/lib/airport-service';

type Props = {
  params: {
    flightId: string;
  };
  searchParams?: {
    from?: string;
    to?: string;
  };
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return {
    title: `Flight Details - ${params.flightId}`,
    description: `Detailed itinerary, route map and booking for flight ${params.flightId}`,
  };
}

const MOCK_FLIGHTS: Record<string, {
  id: string;
  airline: string;
  flightNumber: string;
  departureTime: string;
  arrivalTime: string;
  duration: string;
  stops: number;
  price: number;
  layoverAirport?: string;
  layoverDuration?: string;
  matchScore: number;
  matchGrade: string;
  matchClass: string;
}> = {
  'FL-101': {
    id: 'FL-101',
    airline: 'SkyLink Express',
    flightNumber: 'SL101',
    departureTime: '08:00 AM',
    arrivalTime: '12:30 PM',
    duration: '4h 30m',
    stops: 0,
    price: 340,
    matchScore: 92,
    matchGrade: 'Strong Match',
    matchClass: 'bg-bg-match-strong text-text-match-strong',
  },
  'FL-202': {
    id: 'FL-202',
    airline: 'Pacific Airways',
    flightNumber: 'PA202',
    departureTime: '11:15 AM',
    arrivalTime: '06:45 PM',
    duration: '7h 30m',
    stops: 1,
    layoverAirport: 'ICN',
    layoverDuration: '2h 15m',
    price: 280,
    matchScore: 84,
    matchGrade: 'Fair Match',
    matchClass: 'bg-bg-match-fair text-text-match-fair',
  },
  'FL-303': {
    id: 'FL-303',
    airline: 'Global Connect',
    flightNumber: 'GC303',
    departureTime: '09:30 PM',
    arrivalTime: '05:00 AM',
    duration: '7h 30m',
    stops: 1,
    layoverAirport: 'TPE',
    layoverDuration: '1h 45m',
    price: 220,
    matchScore: 68,
    matchGrade: 'Weak Match',
    matchClass: 'bg-bg-match-weak text-text-match-weak',
  },
};

export default async function FlightDetailPage({ params, searchParams }: Props) {
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
  let flightData;

  try {
    const detailRes = await fetch(`${apiUrl}/api/flights/${flightId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
    });

    if (!detailRes.ok) {
      if (detailRes.status === 410) {
        const errorJson = await detailRes.json();
        const rec = errorJson.recovery;
        const queryParams = new URLSearchParams({
          origin: rec.origin,
          destination: rec.destination,
          departureDate: rec.departureDate,
          ...(rec.returnDate ? { returnDate: rec.returnDate } : {}),
          passengers: String(rec.passengers),
          expired: 'true',
        });
        redirect(`/search?${queryParams.toString()}`);
      }
      if (detailRes.status === 404 || detailRes.status === 400) {
        notFound();
      }
      throw new Error('Failed to fetch flight details');
    }

    flightData = await detailRes.json();
  } catch (err) {
    console.error('Error fetching flight detail:', err);
    notFound();
  }

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
