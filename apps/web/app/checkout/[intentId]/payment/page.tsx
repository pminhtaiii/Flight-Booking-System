import { protectCheckoutRoute, fetchBookingIntent } from '@/lib/checkout';
import { Header } from '@/components/layout/Header';
import Link from 'next/link';

type Props = {
  params: {
    intentId: string;
  };
};

export default async function PaymentPage({ params }: Props) {
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
            <p className="mt-2 text-sm text-text-secondary">
              We could not find the requested booking intent.
            </p>
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
            <p className="mt-2 text-sm text-text-secondary">
              You do not have access to this booking intent.
            </p>
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
            <p className="text-sm text-text-secondary">
              This booking session has expired. Please search and select a new flight.
            </p>
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
            <p className="mt-2 text-sm text-text-secondary">
              A server error occurred. Please try again later.
            </p>
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
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Step 4 of 4
          </span>
          <h1 className="text-3xl font-bold text-text-primary">Payment</h1>
          <p className="text-text-secondary">
            Provide payment information to finalize your flight booking.
          </p>
        </div>

        {/* Payment overview */}
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-text-primary">Amount Due</h2>
          <div className="flex justify-between items-center bg-secondary p-4 rounded-lg">
            <span className="text-sm text-text-secondary">
              Flight total ({intent.flight.origin} to {intent.flight.destination})
            </span>
            <span className="text-3xl font-extrabold text-text-primary">
              {intent.confirmedPrice} {intent.currency}
            </span>
          </div>
        </div>

        {/* Placeholder Payment Form */}
        <div className="card space-y-6">
          <h2 className="text-lg font-semibold text-text-primary">
            Credit Card Payment Placeholder
          </h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Cardholder Name
              </label>
              <input
                type="text"
                placeholder="e.g. Jane Doe"
                disabled
                className="form-input w-full bg-secondary cursor-not-allowed opacity-70"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Card Number
              </label>
              <input
                type="text"
                placeholder="•••• •••• •••• ••••"
                disabled
                className="form-input w-full bg-secondary cursor-not-allowed opacity-70"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  Expiration Date
                </label>
                <input
                  type="text"
                  placeholder="MM / YY"
                  disabled
                  className="form-input w-full bg-secondary cursor-not-allowed opacity-70"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">CVV</label>
                <input
                  type="text"
                  placeholder="•••"
                  disabled
                  className="form-input w-full bg-secondary cursor-not-allowed opacity-70"
                />
              </div>
            </div>
          </div>

          <div className="p-4 bg-bg-pending text-text-pending text-xs rounded border border-secondary-border">
            Standard payment gateway integration (Stripe, card tokens) will be wired in Phase 2.
            This step operates as a mock confirmation interface for testing during Phase 0.
          </div>
        </div>

        {/* Navigation CTAs */}
        <div className="flex justify-between items-center pt-4">
          <Link href={`/checkout/${intentId}/review`} className="btn-secondary px-6 py-2.5">
            Back to Review
          </Link>
          <button disabled className="btn-primary px-8 py-3 cursor-not-allowed opacity-50">
            Pay Now (Coming Soon)
          </button>
        </div>
      </main>
    </div>
  );
}
