import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { authOptions } from './auth';

export async function protectCheckoutRoute() {
  if (process.env.NEXT_PUBLIC_FEATURE_FLAG_CHECKOUT !== 'true') {
    notFound();
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

  return {
    session,
    accessToken,
  };
}

export interface BookingIntentDto {
  intentId: string;
  status: string;
  originalPrice: number;
  confirmedPrice: number;
  priceChanged: boolean;
  currency: string;
  pricedAt: string;
  intentExpiresAt: string;
  offerExpiresAt: string | null;
  createdAt: string;
  passengers: Array<{
    id: string;
    type: string;
    givenName: string;
    familyName: string;
    dateOfBirth: string;
    gender: string;
    nationality: string | null;
    passportNumber: string | null;
    passportExpiry: string | null;
    preFilledFromProfile: boolean;
  }>;
  flight: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate: string | null;
    cabinClass: string;
    adults: number;
    children: number;
    infants: number;
  };
}

export async function fetchBookingIntent(intentId: string, accessToken: string): Promise<{
  intent: BookingIntentDto | null;
  errorStatus: number | null;
}> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    throw new Error('NEXT_PUBLIC_API_URL is required but not configured.');
  }

  const cookieHeader = headers().get('cookie') ?? '';
  const mockScenarioMatch = cookieHeader.match(/mock-scenario=([^;]+)/);
  const mockScenario = mockScenarioMatch ? mockScenarioMatch[1].trim() : null;

  if ((process.env.NODE_ENV === 'test' || process.env.CI === 'true') && mockScenario) {
    if (mockScenario === 'intent-not-found') {
      return { intent: null, errorStatus: 404 };
    }
    if (mockScenario === 'intent-forbidden') {
      return { intent: null, errorStatus: 403 };
    }
    if (mockScenario === 'intent-expired') {
      return { intent: null, errorStatus: 410 };
    }
    if (mockScenario === 'intent-unavailable') {
      return { intent: null, errorStatus: 500 };
    }
    
    if (mockScenario === 'valid-intent' || mockScenario.startsWith('mock-')) {
      return {
        intent: {
          intentId,
          status: 'PENDING',
          originalPrice: 150,
          confirmedPrice: 150,
          priceChanged: false,
          currency: 'USD',
          pricedAt: new Date().toISOString(),
          intentExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          offerExpiresAt: null,
          createdAt: new Date().toISOString(),
          passengers: [
            {
              id: 'p1',
              type: 'ADULT',
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: '1990-01-01',
              gender: 'male',
              nationality: 'US',
              passportNumber: '123456',
              passportExpiry: '2030-01-01',
              preFilledFromProfile: false,
            }
          ],
          flight: {
            origin: 'JFK',
            destination: 'LHR',
            departureDate: '2026-10-10',
            returnDate: null,
            cabinClass: 'economy',
            adults: 1,
            children: 0,
            infants: 0,
          }
        },
        errorStatus: null,
      };
    }
  }

  try {
    const response = await fetch(`${apiUrl}/api/bookings/intent/${intentId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      return {
        intent: null,
        errorStatus: response.status,
      };
    }

    const data = await response.json();
    return {
      intent: data as BookingIntentDto,
      errorStatus: null,
    };
  } catch (err) {
    return {
      intent: null,
      errorStatus: 500,
    };
  }
}
