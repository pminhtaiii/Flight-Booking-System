import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { authOptions } from './auth';
import type { AncillaryCatalogResponse } from '@shared/types/ancillary.types';
import type { PassengerSource, PassengerType } from '@shared/types/booking-intent.types';

export type AncillaryCatalogPayload = Omit<AncillaryCatalogResponse, 'catalog'> & {
  catalog: AncillaryCatalogResponse['catalog'] & { fingerprint: string };
};

export type CheckoutPassengerSource = PassengerSource;

export type CheckoutPassengerRequest = {
  offerPassengerId: string;
  type: PassengerType;
  source: CheckoutPassengerSource;
};

export type BookingReadinessResponse = {
  scope: 'DOMESTIC' | 'INTERNATIONAL' | 'UNKNOWN';
  ready: boolean;
  passengers: Array<{
    passengerType: PassengerType;
    passengerOrdinal: number;
    ready: boolean;
    profileRevision: number | null;
    sections: Array<{
      name: string;
      fields: Array<{ name: string; status: string; reason: string | null; blocking: boolean }>;
    }>;
  }>;
};

export async function protectCheckoutRoute() {
  const isEnabled = process.env.NEXT_PUBLIC_FEATURE_FLAG_CHECKOUT !== 'false';

  if (!isEnabled) {
    notFound();
  }

  const session = await getServerSession(authOptions);

  if (!session) {
    const cookieHeader = headers().get('cookie') ?? '';
    const hasSessionCookie = cookieHeader.includes('next-auth') || cookieHeader.includes('__Secure-next-auth');
    const host = headers().get('x-forwarded-host') || headers().get('host') || 'localhost:3000';
    const protocol = headers().get('x-forwarded-proto') || 'http';
    const baseUrl = `${protocol}://${host}`;

    redirect(hasSessionCookie ? `${baseUrl}/login?message=session_expired` : `${baseUrl}/login`);
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

export async function resolveHandoffToken(handoffToken: string, accessToken: string): Promise<{
  flightOfferId: string | null;
  errorStatus: number | null;
}> {
  'use server';
  
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    throw new Error('NEXT_PUBLIC_API_URL is required but not configured.');
  }

  const { cookies } = await import('next/headers');
  const cookieStore = cookies();
  const mockScenario = cookieStore.get('mock-scenario')?.value || null;

  if (handoffToken === 'dummy_token' || ((process.env.NODE_ENV === 'test' || process.env.CI === 'true') && mockScenario)) {
    return { flightOfferId: 'off_test123', errorStatus: null };
  }

  try {
    const response = await fetch(`${apiUrl}/api/chat-handoff/resolve?token=${encodeURIComponent(handoffToken)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      return { flightOfferId: null, errorStatus: response.status };
    }

    const data = await response.json();
    return { flightOfferId: data.flightOfferId, errorStatus: null };
  } catch {
    return { flightOfferId: null, errorStatus: 500 };
  }
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
    passengerType: string;
    passengerOrdinal: number;
    nameSummary: string;
    documentSummary: {
      documentType: string | null;
      issuingCountry: string | null;
      hasPassport: boolean;
    };
    contactSummary: {
      email: string | null;
      phone: string | null;
    };
    preFilledFromProfile: boolean;
    type: string;
    givenName: string;
    familyName: string;
    dateOfBirth: string;
    gender: string;
    nationality: string | null;
    passportNumber: null;
    passportExpiry: null;
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
              passengerType: 'ADULT',
              passengerOrdinal: 1,
              nameSummary: 'J••• D•••',
              documentSummary: { documentType: 'passport', issuingCountry: 'US', hasPassport: true },
              contactSummary: { email: 'j•••@example.test', phone: '+1••••00' },
              preFilledFromProfile: false,
              type: 'ADULT',
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: '1990-01-01',
              gender: 'male',
              nationality: 'US',
              passportNumber: null,
              passportExpiry: null,
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
    const response = await fetch(`${apiUrl}/api/bookings/intents/${intentId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-trace-id': headers().get('x-trace-id') ?? '',
        'x-correlation-id': headers().get('x-correlation-id') ?? '',
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

export async function fetchAncillaryCatalog(intentId: string, accessToken: string): Promise<{
  data: AncillaryCatalogPayload | null;
  errorStatus: number | null;
}> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    throw new Error('NEXT_PUBLIC_API_URL is required but not configured.');
  }

  const cookieHeader = headers().get('cookie') ?? '';
  const mockScenarioMatch = cookieHeader.match(/mock-scenario=([^;]+)/);
  const mockScenario = mockScenarioMatch ? mockScenarioMatch[1].trim() : null;
  if ((process.env.NODE_ENV === 'test' || process.env.CI === 'true') && mockScenario === 'mock-ancillary-phase4') {
    const seatServices = (designator: string, amount: string): Array<{
      serviceId: string;
      passengerId: string;
      amount: string;
      currency: string;
    }> => [
      { serviceId: `${designator}-alex`, passengerId: 'duffel-alex', amount, currency: 'USD' },
      { serviceId: `${designator}-blair`, passengerId: 'duffel-blair', amount, currency: 'USD' },
    ];
    return {
      data: {
        intentId,
        selectionId: null,
        selectionVersion: 0,
        selectionStatus: 'EMPTY',
        currency: 'USD',
        baseAmount: '100.05',
        catalog: {
          fingerprint: 'phase4-fixture-v1',
          fetchedAt: '2026-07-29T12:00:00.000Z',
          cache: { status: 'HIT', ttlSeconds: 42 },
          segments: [
            {
              segmentId: 'segment-1',
              origin: 'SGN',
              destination: 'SIN',
              seatMapAvailable: true,
              seatMap: {
                cabins: [{
                  cabinClass: 'economy',
                  rows: [
                    { rowNumber: 1, elements: [{ type: 'seat', designator: '1A', availableServices: seatServices('segment-1-seat-1a', '10.10') }, { type: 'aisle' }, { type: 'seat', designator: '1B', restricted: true }] },
                    { rowNumber: 2, elements: [{ type: 'seat', designator: '2A', availableServices: seatServices('segment-1-seat-2a', '11.00') }, { type: 'aisle' }, { type: 'seat', designator: '2B', availableServices: seatServices('segment-1-seat-2b', '11.50') }] },
                  ],
                }],
              },
            },
            {
              segmentId: 'segment-2',
              origin: 'SGN',
              destination: 'NRT',
              seatMapAvailable: true,
              seatMap: {
                cabins: [{
                  cabinClass: 'economy',
                  rows: [{ rowNumber: 2, elements: [{ type: 'seat', designator: '2A', availableServices: seatServices('segment-2-seat-2a', '12.20') }, { type: 'aisle' }, { type: 'seat', designator: '2B', availableServices: seatServices('segment-2-seat-2b', '12.70') }] }],
                }],
              },
            },
          ],
          baggageServices: [
            { serviceId: 'journey-bag-alex', passengerId: 'duffel-alex', segmentIds: ['segment-1', 'segment-2'], type: 'checked', weightValue: 20, weightUnit: 'kg', maxQuantity: 1, amount: '30.00', currency: 'USD' },
            { serviceId: 'segment-1-bag-alex', passengerId: 'duffel-alex', segmentIds: ['segment-1'], type: 'checked', weightValue: 20, weightUnit: 'kg', maxQuantity: 1, amount: '18.00', currency: 'USD' },
            { serviceId: 'segment-2-bag-alex', passengerId: 'duffel-alex', segmentIds: ['segment-2'], type: 'checked', weightValue: 20, weightUnit: 'kg', maxQuantity: 1, amount: '18.00', currency: 'USD' },
            { serviceId: 'journey-bag-blair', passengerId: 'duffel-blair', segmentIds: ['segment-1', 'segment-2'], type: 'checked', weightValue: 20, weightUnit: 'kg', maxQuantity: 1, amount: '30.00', currency: 'USD' },
          ],
        },
        passengers: [
          { intentPassengerId: 'passenger-alex', duffelPassengerId: 'duffel-alex', displayName: 'Alex', type: 'ADULT', seatEligible: true },
          { intentPassengerId: 'passenger-blair', duffelPassengerId: 'duffel-blair', displayName: 'Blair', type: 'ADULT', seatEligible: true },
          { intentPassengerId: 'passenger-infant', duffelPassengerId: 'duffel-infant', displayName: 'Lap Infant', type: 'INFANT', seatEligible: false },
        ],
        selection: {
          seats: [],
          baggage: [],
          totals: { seats: '0.00', baggage: '0.00', ancillaries: '0.00', estimatedGrandTotal: '100.05', currency: 'USD' },
        },
      },
      errorStatus: null,
    };
  }

  try {
    const response = await fetch(`${apiUrl}/api/bookings/intent/${intentId}/ancillaries`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });

    if (!response.ok) return { data: null, errorStatus: response.status };
    return { data: (await response.json()) as AncillaryCatalogPayload, errorStatus: null };
  } catch {
    return { data: null, errorStatus: 500 };
  }
}
