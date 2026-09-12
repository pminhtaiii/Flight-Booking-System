'use client';

import React from 'react';
import type { FlightSearchOfferView } from '@shared/types';
import { FlightMatchBadge } from './FlightMatchBadge';
import { FlightMatchBreakdown } from './FlightMatchBreakdown';
import { formatDuration, parseDurationMinutes } from '@/lib/search-prefill';

function getLongestSegmentCabin(offer: FlightSearchOfferView): string | undefined {
  let longestDuration = -1;
  let longestCabin: string | undefined = undefined;

  for (const slice of offer.slices ?? []) {
    for (const segment of slice.segments ?? []) {
      const duration = parseDurationMinutes(segment.duration);
      if (duration > longestDuration) {
        longestDuration = duration;
        longestCabin = segment.cabinClass;
      }
    }
  }

  return longestCabin;
}

function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

function formatStops(stops: number): string {
  if (stops === 0) return 'Non-stop';
  if (stops === 1) return '1 stop';
  return `${stops} stops`;
}

function formatCabinClass(cabinClass?: string): string {
  if (!cabinClass) return 'Economy';
  switch (cabinClass.toLowerCase()) {
    case 'economy':
      return 'Economy';
    case 'premium_economy':
      return 'Premium Economy';
    case 'business':
      return 'Business';
    case 'first':
      return 'First';
    default:
      return cabinClass.charAt(0).toUpperCase() + cabinClass.slice(1).replace(/_/g, ' ');
  }
}

function getBaggageAllowance(offer: FlightSearchOfferView): string {
  const baggageScore = offer.matchResult?.breakdown?.find(
    (item) => item.dimension === 'BAGGAGE',
  );
  if (baggageScore) {
    if (baggageScore.explanation.key === 'match.baggage.checked_included') {
      return 'Checked bag included';
    }
    if (baggageScore.explanation.key === 'match.baggage.checked_missing') {
      return 'Checked bag not included';
    }
    if (baggageScore.explanation.key === 'match.baggage.not_required') {
      return 'No baggage requirement';
    }
  }
  return 'Standard baggage';
}

export type FlightResultCardProps = {
  offer: FlightSearchOfferView;
  onSelect: (offerId: string) => void;
  isSelecting?: boolean;
  disabled?: boolean;
  className?: string;
};

export function FlightResultCard({
  offer,
  onSelect,
  isSelecting = false,
  disabled = false,
  className,
}: FlightResultCardProps): React.JSX.Element {
  const cabin = formatCabinClass(getLongestSegmentCabin(offer));
  const baggage = getBaggageAllowance(offer);
  const durationText = formatDuration(offer.duration);
  const stopsText = formatStops(offer.stops);
  const departureTime = formatTime(offer.departureAt);
  const arrivalTime = formatTime(offer.arrivalAt);

  const containerClasses = ['card space-y-4 transition hover:shadow-md', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      data-testid="flight-result-card"
      data-offer-id={offer.id}
      className={containerClasses}
    >
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        {/* Left Column: Airline info & Route */}
        <div className="space-y-3 flex-1">
          {/* Header row: Airline, Flight number, Cabin, Baggage, Badge */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-text-primary text-base">{offer.airline}</span>
            <span className="text-xs text-text-muted font-normal">Flight {offer.flightNumber}</span>
            <span className="inline-flex items-center rounded bg-background px-2 py-0.5 text-xs font-medium text-text-secondary border border-secondary-border">
              {cabin}
            </span>
            <span className="inline-flex items-center rounded bg-background px-2 py-0.5 text-xs font-medium text-text-secondary border border-secondary-border">
              {baggage}
            </span>
            {offer.matchResult && <FlightMatchBadge matchResult={offer.matchResult} />}
          </div>

          {/* Flight Route and Times */}
          <div className="flex items-center gap-6 sm:gap-8 text-sm">
            <div>
              <p className="text-lg font-bold text-text-primary">{departureTime}</p>
              <p className="text-xs font-semibold text-text-secondary">{offer.origin}</p>
            </div>

            <div className="flex flex-col items-center justify-center min-w-[80px] sm:min-w-[100px]">
              <span className="text-xs font-medium text-text-muted">{stopsText}</span>
              <div className="w-full h-0.5 bg-secondary-border my-1 relative">
                {offer.stops > 0 && (
                  <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-text-muted" />
                )}
              </div>
              <span className="text-xs text-text-muted">{durationText}</span>
            </div>

            <div>
              <p className="text-lg font-bold text-text-primary">{arrivalTime}</p>
              <p className="text-xs font-semibold text-text-secondary">{offer.destination}</p>
            </div>
          </div>
        </div>

        {/* Right Column: Price and Action Button */}
        <div className="flex flex-row md:flex-col items-center md:items-end justify-between md:justify-center gap-4 pt-3 md:pt-0 border-t md:border-t-0 border-secondary-border md:min-w-[140px]">
          <div className="text-left md:text-right">
            <span className="text-2xl font-bold text-text-primary">
              {offer.price} {offer.currency}
            </span>
            <p className="text-xs text-text-muted hidden md:block">total per traveler</p>
          </div>

          <button
            type="button"
            data-offer-id={offer.id}
            aria-label={`Select flight ${offer.flightNumber}`}
            onClick={() => onSelect(offer.id)}
            disabled={disabled || isSelecting}
            className="btn-primary w-full md:w-auto min-h-[44px] text-sm px-5 py-2 font-semibold shadow-sm transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSelecting ? 'Loading...' : 'Select flight'}
          </button>
        </div>
      </div>

      {/* Embedded Breakdown if matchResult is present */}
      {offer.matchResult && (
        <div className="pt-2 border-t border-secondary-border">
          <FlightMatchBreakdown matchResult={offer.matchResult} />
        </div>
      )}
    </div>
  );
}
