import { protectCheckoutRoute } from '@/lib/checkout';
import { Header } from '@/components/layout/Header';
import { SearchFormClient } from '@/components/search/SearchFormClient';
import type { FlightSearchQuery } from '@shared/types';

type SearchPageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

const IATA_CODE_PATTERN = /^[A-Z]{3}$/;

const isExactCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};

const isCabinClass = (value: string): value is FlightSearchQuery['cabinClass'] =>
  value === 'economy' || value === 'premium_economy' || value === 'business' || value === 'first';

const getSingleValue = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const getInitialValues = (searchParams: SearchPageProps['searchParams']): Partial<FlightSearchQuery> => {
  const origin = getSingleValue(searchParams.origin);
  const destination = getSingleValue(searchParams.destination);
  const departureDate = getSingleValue(searchParams.departureDate);
  const adults = Number(getSingleValue(searchParams.adults));
  const cabinClass = getSingleValue(searchParams.cabinClass);

  return {
    ...(origin && IATA_CODE_PATTERN.test(origin) ? { origin } : {}),
    ...(destination && IATA_CODE_PATTERN.test(destination) ? { destination } : {}),
    ...(departureDate && isExactCalendarDate(departureDate) ? { departureDate } : {}),
    ...(Number.isInteger(adults) && adults >= 1 && adults <= 9 ? { adults } : {}),
    ...(cabinClass && isCabinClass(cabinClass) ? { cabinClass } : {}),
  };
};

export default async function SearchPage({ searchParams }: SearchPageProps): Promise<JSX.Element> {
  await protectCheckoutRoute();
  const initialValues = getInitialValues(searchParams);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto w-full max-w-4xl space-y-6 py-12 px-4">
        <h1 className="text-3xl font-bold text-text-primary">Search Flights</h1>
        <p className="text-text-secondary">Find and compare flight offers for your next destination.</p>
        <SearchFormClient initialValues={initialValues} />
      </main>
    </div>
  );
}
