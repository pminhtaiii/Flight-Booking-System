import { protectCheckoutRoute, fetchBookingIntent } from '@/lib/checkout';
import { Header } from '@/components/layout/Header';
import Link from 'next/link';

type Props = {
  params: {
    intentId: string;
  };
};

export default async function ReviewPage({ params }: Props) {
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
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">Step 3 of 4</span>
          <h1 className="text-3xl font-bold text-text-primary">Review Booking</h1>
          <p className="text-text-secondary">Verify flight information and traveler details before making payment.</p>
        </div>

        {/* Flight Details Card */}
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-text-primary">Flight Overview</h2>
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
              <p className="font-semibold text-text-primary">Passengers</p>
              <p>{intent.flight.adults} Adult(s){intent.flight.children ? ` | ${intent.flight.children} Child(ren)` : ''}{intent.flight.infants ? ` | ${intent.flight.infants} Infant(s)` : ''}</p>
            </div>
          </div>
        </div>

        {/* Read-Only Passenger Details Card */}
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-text-primary">Passenger Information</h2>
          <div className="divide-y divide-card-border">
            {intent.passengers.map((p, idx) => (
              <div key={p.id || idx} className="py-4 space-y-2 text-sm">
                <div className="flex justify-between items-center">
                  <p className="font-bold text-text-primary">
                    {p.passengerOrdinal || idx + 1}. {p.nameSummary}
                  </p>
                  <span className="bg-secondary text-secondary-foreground text-xs px-2 py-0.5 rounded font-medium capitalize">
                    {p.passengerType.toLowerCase()}
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs text-text-secondary">
                  <div><span className="font-semibold text-text-primary">Document:</span><p>{p.documentSummary.documentType || 'Not provided'}{p.documentSummary.issuingCountry ? ` · ${p.documentSummary.issuingCountry}` : ''}{p.documentSummary.hasPassport ? ' · masked' : ''}</p></div>
                  <div><span className="font-semibold text-text-primary">Contact:</span><p>{p.contactSummary.email || 'Not provided'}{p.contactSummary.phone ? ` · ${p.contactSummary.phone}` : ''}</p></div>
                  <div><span className="font-semibold text-text-primary">Source:</span><p>{p.preFilledFromProfile ? 'Traveler profile' : 'Entered for this booking'}</p></div>
                </div>
                {p.preFilledFromProfile && <Link href={`/profile?returnTo=/checkout/${intentId}/review`} className="inline-block text-sm text-text-link underline">Edit traveler profile securely</Link>}
              </div>
            ))}
          </div>
        </div>

        {/* Pricing Summary Card */}
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-text-primary">Fare Summary</h2>
          <div className="flex justify-between items-center text-sm border-t border-card-border pt-4">
            <span className="font-semibold text-text-primary">Total Price (incl. taxes & fees)</span>
            <span className="text-2xl font-bold text-text-primary">
              {intent.confirmedPrice} {intent.currency}
            </span>
          </div>
        </div>

        {/* Navigation CTAs */}
        <div className="flex justify-between items-center pt-4">
          <Link href={`/checkout/${intentId}/ancillaries`} className="btn-secondary px-6 py-2.5">
            Back to Ancillaries
          </Link>
          <Link href={`/checkout/${intentId}/payment`} className="btn-primary px-8 py-3">
            Proceed to Payment
          </Link>
        </div>
      </main>
    </div>
  );
}
