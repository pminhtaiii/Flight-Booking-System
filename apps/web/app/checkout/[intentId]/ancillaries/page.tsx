import { protectCheckoutRoute, fetchBookingIntent } from '@/lib/checkout';
import { Header } from '@/components/layout/Header';
import Link from 'next/link';

type Props = {
  params: {
    intentId: string;
  };
};

export default async function AncillariesPage({ params }: Props) {
  const { accessToken } = await protectCheckoutRoute();
  const { intentId } = params;

  const { intent, errorStatus } = await fetchBookingIntent(intentId, accessToken);

  if (errorStatus === 404) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <main className="mx-auto w-full max-w-3xl py-12 px-4">
          <div role="alert" className="card text-text-cancelled bg-bg-cancelled p-6">
            <h1 className="text-xl font-bold">Booking Intent Not Found</h1>
            <p className="mt-2 text-sm text-text-secondary">We could not find the requested booking intent.</p>
          </div>
        </main>
      </div>
    );
  }

  if (errorStatus === 403) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <main className="mx-auto w-full max-w-3xl py-12 px-4">
          <div role="alert" className="card text-text-cancelled bg-bg-cancelled p-6">
            <h1 className="text-xl font-bold">Forbidden</h1>
            <p className="mt-2 text-sm text-text-secondary">You do not have access to this booking intent.</p>
          </div>
        </main>
      </div>
    );
  }

  if (errorStatus === 410) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <main className="mx-auto w-full max-w-3xl py-12 px-4">
          <div role="alert" className="card text-text-pending bg-bg-pending p-6 space-y-4">
            <h1 className="text-xl font-bold">Booking Intent Expired</h1>
            <p className="text-sm text-text-secondary">This booking session has expired. Please search and select a new flight.</p>
            <div>
              <Link href="/search" className="btn-primary">
                Return to Search
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (errorStatus || !intent) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <main className="mx-auto w-full max-w-3xl py-12 px-4">
          <div role="alert" className="card text-text-cancelled bg-bg-cancelled p-6">
            <h1 className="text-xl font-bold">Service Unavailable</h1>
            <p className="mt-2 text-sm text-text-secondary">A server error occurred. Please try again later.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto w-full max-w-3xl space-y-6 py-12 px-4">
        {/* Step Indicator / Title */}
        <div className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">Step 2 of 4</span>
          <h1 className="text-3xl font-bold text-text-primary">Ancillary Services</h1>
          <p className="text-text-secondary">Customize your flight with seats, baggage, and add-ons.</p>
        </div>

        {/* Flight Context Card */}
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-text-primary">Flight Details</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm text-text-secondary">
            <div>
              <p className="font-semibold text-text-primary">Route</p>
              <p>{intent.flight.origin} to {intent.flight.destination}</p>
            </div>
            <div>
              <p className="font-semibold text-text-primary">Departure Date</p>
              <p>{new Date(intent.flight.departureDate).toLocaleDateString()}</p>
            </div>
            <div>
              <p className="font-semibold text-text-primary">Cabin Class</p>
              <p className="capitalize">{intent.flight.cabinClass}</p>
            </div>
            <div>
              <p className="font-semibold text-text-primary">Price</p>
              <p className="font-bold text-text-primary">{intent.confirmedPrice} {intent.currency}</p>
            </div>
          </div>
        </div>

        {/* Passenger List Card */}
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-text-primary">Travelers</h2>
          <div className="divide-y divide-card-border">
            {intent.passengers.map((p, idx) => (
              <div key={p.id || idx} className="py-3 flex justify-between items-center text-sm">
                <div>
                  <p className="font-medium text-text-primary">
                    {p.givenName} {p.familyName}
                  </p>
                  <p className="text-xs text-text-muted">
                    DOB: {p.dateOfBirth} | Gender: {p.gender}
                  </p>
                </div>
                <span className="bg-secondary text-secondary-foreground text-xs px-2.5 py-1 rounded font-medium capitalize">
                  {p.type.toLowerCase()}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Placeholder Seat Selection Card */}
        <div className="card border-dashed border-card-border space-y-4">
          <div className="flex justify-between items-start">
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Seat Selection</h3>
              <p className="text-sm text-text-secondary mt-1">
                Choose your preferred seat on the plane.
              </p>
            </div>
            <span className="bg-bg-pending text-text-pending text-xs px-2.5 py-1 rounded font-medium">
              Coming Soon
            </span>
          </div>
          <p className="text-xs text-text-muted">
            Interactive seat map selection is currently being integrated. Seats will be automatically assigned at check-in, or you can select them directly with the airline after confirmation.
          </p>
        </div>

        {/* Placeholder Baggage Selection Card */}
        <div className="card border-dashed border-card-border space-y-4">
          <div className="flex justify-between items-start">
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Baggage Options</h3>
              <p className="text-sm text-text-secondary mt-1">
                Add extra cabin or checked baggage to your booking.
              </p>
            </div>
            <span className="bg-bg-pending text-text-pending text-xs px-2.5 py-1 rounded font-medium">
              Coming Soon
            </span>
          </div>
          <p className="text-xs text-text-muted">
            Additional baggage purchasing options will be available shortly. Standard flight baggage allowance rules remain applicable to your ticket class.
          </p>
        </div>

        {/* Navigation CTA */}
        <div className="flex justify-end pt-4">
          <Link href={`/checkout/${intentId}/review`} className="btn-primary px-8 py-3">
            Continue to Review
          </Link>
        </div>
      </main>
    </div>
  );
}
