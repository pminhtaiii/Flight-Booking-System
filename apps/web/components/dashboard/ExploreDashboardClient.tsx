'use client';

import { useMemo, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { Airport } from '@shared/types';
import { MapContainer } from '@/components/map/MapContainer';

type Props = {
  allAirports: Airport[];
};

export function ExploreDashboardClient({ allAirports }: Props) {
  const router = useRouter();

  const popularAirports = useMemo(() => {
    const popularCodes = ['HAN', 'SGN', 'NRT', 'LHR', 'CDG', 'JFK', 'SIN', 'SYD'];
    return allAirports.filter((ap) => popularCodes.includes(ap.iataCode.toUpperCase()));
  }, [allAirports]);

  const handleSelectPopularDestination = (ap: Airport) => {
    router.push(`/search?to=${ap.iataCode}`);
  };

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-xl font-bold text-text-primary mb-2">
          Explore Popular Destinations
        </h2>
        <p className="text-sm text-text-secondary">
          Click on any popular destination airport on the map to search flights directly!
        </p>
      </div>

      <div className="h-[600px] w-full rounded-2xl overflow-hidden border border-card-border shadow-md">
        <Suspense fallback={<div className="text-text-primary">Loading Explore Map...</div>}>
          <MapContainer
            allAirports={allAirports}
            popularDestinations={popularAirports}
            onSelectPopularDestination={handleSelectPopularDestination}
          />
        </Suspense>
      </div>
    </div>
  );
}
