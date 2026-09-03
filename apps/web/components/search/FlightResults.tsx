'use client';

import React from 'react';
import type { FlightSearchMeta, FlightSearchOfferView } from '@shared/types';
import { FlightResultCard } from './FlightResultCard';
import { FlightRankingBanner } from './FlightRankingBanner';
import { parseDurationMinutes } from '@/lib/search-prefill';

export { parseDurationMinutes };

function sortOffers(offers: FlightSearchOfferView[], sortBy?: string): FlightSearchOfferView[] {
  if (!sortBy || sortBy === 'BEST_MATCH' || sortBy === 'RECOMMENDED') {
    return offers;
  }

  const cloned = [...offers];
  switch (sortBy) {
    case 'PRICE':
      return cloned.sort((a, b) => a.price - b.price);
    case 'DURATION':
      return cloned.sort(
        (a, b) => parseDurationMinutes(a.duration) - parseDurationMinutes(b.duration),
      );
    case 'STOPS':
      return cloned.sort((a, b) => a.stops - b.stops);
    case 'DEPARTURE_TIME':
      return cloned.sort(
        (a, b) => new Date(a.departureAt).getTime() - new Date(b.departureAt).getTime(),
      );
    default:
      return cloned;
  }
}

export type FlightResultsProps = {
  offers: FlightSearchOfferView[];
  mode?: 'MATCHED' | 'RANKED';
  meta?: FlightSearchMeta | null;
  sortBy?: string;
  onSelectFlight: (offerId: string) => void;
  bookingOfferId?: string | null;
  className?: string;
};

export function FlightResults({
  offers,
  mode,
  sortBy,
  onSelectFlight,
  bookingOfferId,
  className,
}: FlightResultsProps): React.JSX.Element {
  if (offers.length === 0) {
    return (
      <div className={['card text-center p-8', className].filter(Boolean).join(' ')}>
        <p className="text-text-secondary font-medium">No flight offers found.</p>
      </div>
    );
  }

  const sortedOffers = sortOffers(offers, sortBy);
  const containerClasses = ['space-y-4', className].filter(Boolean).join(' ');

  return (
    <div data-testid="flight-results-container" className={containerClasses}>
      {mode === 'RANKED' && <FlightRankingBanner mode={mode} />}
      <div className="space-y-4">
        {sortedOffers.map((offer) => (
          <FlightResultCard
            key={offer.id}
            offer={offer}
            onSelect={onSelectFlight}
            isSelecting={bookingOfferId === offer.id}
            disabled={Boolean(bookingOfferId)}
          />
        ))}
      </div>
    </div>
  );
}
