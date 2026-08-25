import { protectCheckoutRoute, fetchAncillaryCatalog, fetchBookingIntent } from '@/lib/checkout';
import { Header } from '@/components/layout/Header';
import { AncillarySelectionClient } from '@/components/checkout/AncillarySelectionClient';
import Link from 'next/link';
import styles from './ancillaries.module.css';

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

  const { data: ancillaryCatalog, errorStatus: ancillaryErrorStatus } = await fetchAncillaryCatalog(intentId, accessToken);

  if (ancillaryErrorStatus || !ancillaryCatalog) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <Header />
        <main className="mx-auto w-full max-w-3xl py-12 px-4">
          <div role="alert" className="card text-text-cancelled bg-bg-cancelled p-6">
            <h1 className="text-xl font-bold">Flight extras are unavailable</h1>
            <p className="mt-2 text-sm text-text-secondary">We could not load the airline&apos;s current seat and baggage options. Please return to the previous step or try again shortly.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={`${styles.airlineBlue} flex min-h-screen flex-col bg-background`}>
      <Header />
      <main className="mx-auto w-full max-w-7xl py-12 px-4">
        <AncillarySelectionClient data={ancillaryCatalog} intentId={intentId} accessToken={accessToken} />
      </main>
    </div>
  );
}
