import { protectCheckoutRoute } from '@/lib/checkout';
import { Header } from '@/components/layout/Header';
import { SearchFormClient } from '@/components/search/SearchFormClient';

export default async function SearchPage() {
  const { accessToken } = await protectCheckoutRoute();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto w-full max-w-4xl space-y-6 py-12 px-4">
        <h1 className="text-3xl font-bold text-text-primary">Search Flights</h1>
        <p className="text-text-secondary">Find and compare flight offers for your next destination.</p>
        <SearchFormClient accessToken={accessToken} />
      </main>
    </div>
  );
}
