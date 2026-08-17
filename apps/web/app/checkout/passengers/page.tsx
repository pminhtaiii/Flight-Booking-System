import { protectCheckoutRoute } from '@/lib/checkout';
import { Header } from '@/components/layout/Header';
import { PassengerFormClient } from '@/components/checkout/PassengerFormClient';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { hasCheckoutHandoffContext, resolveHandoffForBootstrap } from '@/lib/handoffBootstrap';
import type { TravelerProfileResponse } from '@/lib/profile-contract';
import { getSafeReturnTarget } from '@/lib/safeReturnTarget';

interface PassengerPageFlightDetail {
  id: string;
  airline: string;
  flightNumber: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTime: string;
  arrivalTime: string;
  duration: number;
  stops: number;
  originalPrice: number;
  confirmedPrice: number;
  priceChanged: boolean;
  currency: string;
  fareClass?: string | null;
  baggageAllowance?: string | null;
  requestedCabinClass: string;
  cabinClassMatch: string;
  adults: number;
  children: number;
  infants: number;
  passengers: Array<{ id: string; type: 'ADULT' | 'CHILD' | 'INFANT' }>;
  segments: Array<{
    departureAirport: string;
    arrivalAirport: string;
  }>;
}

type Props = {
  searchParams: {
    offerId?: string;
    returnTo?: string;
    [key: string]: string | undefined;
  };
};

export default async function PassengersPage({ searchParams }: Props) {
  const { accessToken } = await protectCheckoutRoute();
  const offerId = searchParams.offerId;
  const safeReturnTarget = searchParams.returnTo ? getSafeReturnTarget(searchParams.returnTo) : null;
  const cookieStore = cookies();
  const handoffCookie = cookieStore.get('chat_handoff_token');
  
  const mockScenario = cookieStore.get('mock-scenario')?.value || null;

  if (handoffCookie?.value) {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    const resolved = await resolveHandoffForBootstrap(
      apiUrl,
      handoffCookie.value,
      accessToken,
      undefined,
      undefined,
      fetch,
      undefined,
      mockScenario,
    );
    if (!hasCheckoutHandoffContext(resolved)) {
      return (
        <div className="flex min-h-screen flex-col bg-background">
          <Header />
          <main className="mx-auto w-full max-w-3xl py-12 px-4">
            <div role="alert" className="card text-text-cancelled bg-bg-cancelled p-6">
              <h1 className="text-xl font-bold">Checkout Session Expired</h1>
              <p className="mt-2 text-sm text-text-secondary">
                Your checkout session has expired or is invalid. Please restart checkout from the chat assistant.
              </p>
            </div>
          </main>
        </div>
      );
    }
    const { offer, passengers } = resolved.context;
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <main className="mx-auto w-full max-w-3xl space-y-6 py-12 px-4">
          {safeReturnTarget && safeReturnTarget !== '/' ? (
            <div>
              <a
                className="inline-flex items-center gap-1 text-sm font-semibold text-text-link hover:underline"
                href={safeReturnTarget}
              >
                &larr; Back to previous workspace
              </a>
            </div>
          ) : null}
          <h1 className="text-3xl font-bold text-text-primary">Passenger Details</h1>
          <p className="text-text-secondary">Please enter the details for all passengers. Fields marked with * are required.</p>
          <div className="card p-6 space-y-4">
            <h2 className="text-lg font-semibold text-text-primary">Flight Selected</h2>
            <div className="flex flex-wrap gap-6 text-sm text-text-secondary">
              <div>
                <span className="font-semibold text-text-primary">Carrier:</span> {offer.airline}
              </div>
              <div>
                <span className="font-semibold text-text-primary">Route:</span> {offer.origin} to {offer.destination}
              </div>
              <div>
                <span className="font-semibold text-text-primary">Departure:</span> {offer.departureAt}
              </div>
              <div>
                <span className="font-semibold text-text-primary">Arrival:</span> {offer.arrivalAt}
              </div>
              <div>
                <span className="font-semibold text-text-primary">Price:</span> {offer.price} {offer.currency}
              </div>
            </div>
          </div>
          <PassengerFormClient
            flight={{ id: 'handoff', adults: offer.adults, children: offer.children, infants: offer.infants }}
            profile={null}
            offerPassengers={passengers}
            accessToken={accessToken}
            handoff
          />
        </main>
      </div>
    );
  }

  // Reject any passenger data passed via query string to prevent PII exposure
  const hasPiiInQuery = Object.keys(searchParams).some(key =>
    ['name', 'email', 'phone', 'passport', 'dob', 'gender'].some(pii => key.toLowerCase().includes(pii))
  );

  if (hasPiiInQuery) {
    const safeReturn = searchParams.returnTo ? getSafeReturnTarget(searchParams.returnTo) : '/';
    const returnParam = safeReturn !== '/' ? `&returnTo=${encodeURIComponent(safeReturn)}` : '';
    redirect(`/checkout/passengers?offerId=${offerId || ''}${returnParam}`);
  }

  if (!offerId) {
    redirect(`/search`);
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

  let flight: PassengerPageFlightDetail | null = null;
  let profile: TravelerProfileResponse | null = null;

  // 1. Mock support for test environment
  if ((process.env.NODE_ENV === 'test' || process.env.CI === 'true') && mockScenario) {
    profile = {
      profileId: 'mock-profile-id',
      revision: 1,
      identity: { givenName: 'Jane', middleName: null, familyName: 'Doe', dateOfBirth: '1995-05-05', gender: 'female', title: 'Ms' },
      contact: { email: 'jane@example.test', phoneCountryCode: '+1', phoneNumber: '5550000000' },
      travelDocument: { documentType: 'passport', passportNumber: 'P12345', passportExpiry: '2030-05-05', issuingCountry: 'US', nationality: 'US' },
      preferences: { seatPreference: 'window', classPreference: 'economy' },
    };

    if (mockScenario === 'international-offer' || mockScenario.includes('international')) {
      flight = {
        id: offerId,
        airline: 'British Airways',
        flightNumber: 'BA123',
        departureAirport: 'JFK',
        arrivalAirport: 'LHR',
        departureTime: '2026-10-10T12:00:00Z',
        arrivalTime: '2026-10-11T00:00:00Z',
        duration: 480,
        stops: 0,
        originalPrice: 500,
        confirmedPrice: 500,
        priceChanged: false,
        currency: 'USD',
        fareClass: 'Economy',
        baggageAllowance: '1 checked bag',
        requestedCabinClass: 'economy',
        cabinClassMatch: 'full',
        adults: 1,
        children: 0,
        infants: 0,
        passengers: [{ id: 'pas_001', type: 'ADULT' }],
        segments: [{ departureAirport: 'JFK', arrivalAirport: 'LHR' }],
      };
    } else {
      flight = {
        id: offerId,
        airline: 'Delta Air Lines',
        flightNumber: 'DL456',
        departureAirport: 'LAX',
        arrivalAirport: 'SFO',
        departureTime: '2026-10-10T12:00:00Z',
        arrivalTime: '2026-10-10T13:30:00Z',
        duration: 90,
        stops: 0,
        originalPrice: 150,
        confirmedPrice: 150,
        priceChanged: false,
        currency: 'USD',
        fareClass: 'Economy',
        baggageAllowance: '1 checked bag',
        requestedCabinClass: 'economy',
        cabinClassMatch: 'full',
        adults: 1,
        children: 1,
        infants: 0,
        passengers: [{ id: 'pas_001', type: 'ADULT' }, { id: 'pas_002', type: 'CHILD' }],
        segments: [{ departureAirport: 'LAX', arrivalAirport: 'SFO' }],
      };
    }
  } else {
    // 2. Production Flow
    // Fetch Flight Details
    try {
      const flightRes = await fetch(`${apiUrl}/api/flights/${offerId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        cache: 'no-store',
      });

      if (!flightRes.ok) {
        return (
          <div className="flex min-h-screen flex-col bg-background">
            <Header />
            <main className="mx-auto w-full max-w-3xl py-12 px-4">
              <div role="alert" className="card text-text-cancelled bg-bg-cancelled p-6">
                <h1 className="text-xl font-bold">Flight Offer Not Found</h1>
                <p className="mt-2 text-sm text-text-secondary">We could not load the flight offer details. It may have expired.</p>
              </div>
            </main>
          </div>
        );
      }

      flight = await flightRes.json();
    } catch (err) {
      return (
        <div className="flex min-h-screen flex-col bg-background">
          <Header />
          <main className="mx-auto w-full max-w-3xl py-12 px-4">
            <div role="alert" className="card text-text-cancelled bg-bg-cancelled p-6">
              <h1 className="text-xl font-bold">Service Error</h1>
              <p className="mt-2 text-sm text-text-secondary">Failed to retrieve flight offer details. Please try again later.</p>
            </div>
          </main>
        </div>
      );
    }

    // Load the authenticated traveler profile. The deprecated intent prefill
    // route is intentionally not used by first-party checkout.
    try {
      const profileRes = await fetch(`${apiUrl}/api/profile`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        cache: 'no-store',
      });
      if (profileRes.ok) {
        profile = await profileRes.json();
      }
    } catch {
      // Inline passenger sources remain available when profile loading fails.
    }

  }

  if (!flight) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <main className="mx-auto w-full max-w-3xl py-12 px-4">
          <div role="alert" className="card text-text-cancelled bg-bg-cancelled p-6">
            <h1 className="text-xl font-bold">Service Error</h1>
            <p className="mt-2 text-sm text-text-secondary">Failed to retrieve flight offer details.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto w-full max-w-3xl space-y-6 py-12 px-4">
        {safeReturnTarget && safeReturnTarget !== '/' ? (
          <div>
            <a
              className="inline-flex items-center gap-1 text-sm font-semibold text-text-link hover:underline"
              href={safeReturnTarget}
            >
              &larr; Back to previous workspace
            </a>
          </div>
        ) : null}
        <h1 className="text-3xl font-bold text-text-primary">Passenger Details</h1>
        <p className="text-text-secondary">Please enter the details for all passengers. Fields marked with * are required.</p>
        
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-text-primary">Flight Selected</h2>
          <div className="flex flex-wrap gap-6 text-sm text-text-secondary">
            <div>
              <span className="font-semibold text-text-primary">Carrier:</span> {flight.airline} (Flight {flight.flightNumber})
            </div>
            <div>
              <span className="font-semibold text-text-primary">Route:</span> {flight.departureAirport} to {flight.arrivalAirport}
            </div>
            <div>
              <span className="font-semibold text-text-primary">Date:</span> {new Date(flight.departureTime).toLocaleDateString()}
            </div>
            <div>
              <span className="font-semibold text-text-primary">Class:</span> {flight.fareClass || flight.requestedCabinClass}
            </div>
            <div>
              <span className="font-semibold text-text-primary">Price:</span> {flight.confirmedPrice} {flight.currency}
            </div>
          </div>
        </div>

        <PassengerFormClient
          flight={flight}
          profile={profile}
          offerPassengers={flight.passengers}
          accessToken={accessToken}
          offerId={offerId}
        />
      </main>
    </div>
  );
}
