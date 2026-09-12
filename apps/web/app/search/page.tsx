import { protectCheckoutRoute } from '@/lib/checkout';
import { Header } from '@/components/layout/Header';
import { SearchFormClient } from '@/components/search/SearchFormClient';
import { fetchProfileCabinPreference } from '@/lib/profile';
import { getInitialValues, isCabinClass, type SearchPageSearchParams } from '@/lib/search-prefill';

type SearchPageProps = {
  searchParams: SearchPageSearchParams;
};

export default async function SearchPage({ searchParams }: SearchPageProps): Promise<JSX.Element> {
  await protectCheckoutRoute();
  let preferredCabin: string | null = null;
  try {
    preferredCabin = await fetchProfileCabinPreference();
  } catch {
    preferredCabin = null;
  }
  const validPreferredCabin =
    preferredCabin && isCabinClass(preferredCabin) ? preferredCabin : undefined;
  const initialValues = getInitialValues(searchParams, validPreferredCabin);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto w-full max-w-4xl space-y-6 py-12 px-4">
        <h1 className="text-3xl font-bold text-text-primary">Search Flights</h1>
        <p className="text-text-secondary">
          Find and compare flight offers for your next destination.
        </p>
        <SearchFormClient initialValues={initialValues} />
      </main>
    </div>
  );
}


