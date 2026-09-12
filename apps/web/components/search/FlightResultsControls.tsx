'use client';

import React from 'react';

export type FlightSortOption =
  | 'BEST_MATCH'
  | 'RECOMMENDED'
  | 'PRICE'
  | 'DURATION'
  | 'STOPS'
  | 'DEPARTURE_TIME';

export type FlightResultsControlsProps = {
  mode: 'MATCHED' | 'RANKED';
  sortBy?: FlightSortOption;
  onSortChange?: (option: FlightSortOption) => void;
  className?: string;
  totalResults?: number;
};

type SortConfig = {
  value: FlightSortOption;
  label: string;
};

const OBJECTIVE_SORT_OPTIONS: readonly SortConfig[] = [
  { value: 'PRICE', label: 'Cheapest (Price)' },
  { value: 'DURATION', label: 'Fastest (Duration)' },
  { value: 'STOPS', label: 'Fewest Stops' },
  { value: 'DEPARTURE_TIME', label: 'Departure Time' },
];

export function FlightResultsControls({
  mode,
  sortBy,
  onSortChange,
  className,
  totalResults,
}: FlightResultsControlsProps): React.JSX.Element {
  const defaultSort = mode === 'MATCHED' ? 'BEST_MATCH' : 'RECOMMENDED';
  const activeSort = sortBy ?? defaultSort;

  const primaryOption: SortConfig =
    mode === 'MATCHED'
      ? { value: 'BEST_MATCH', label: 'Best Match' }
      : { value: 'RECOMMENDED', label: 'Recommended (Category Rank)' };

  const options: SortConfig[] = [primaryOption, ...OBJECTIVE_SORT_OPTIONS];

  const containerClasses = [
    'flex flex-col md:flex-row md:items-center md:justify-between gap-4 py-2',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClasses}>
      <div className="text-sm font-medium text-text-secondary">
        {typeof totalResults === 'number' && (
          <span>
            {totalResults} {totalResults === 1 ? 'flight found' : 'flights found'}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 self-start md:self-auto">
        <label htmlFor="flight-sort-select" className="text-xs font-medium text-text-secondary">
          Sort by
        </label>
        <select
          id="flight-sort-select"
          aria-label="Sort flight results"
          value={activeSort}
          onChange={(event) => {
            onSortChange?.(event.target.value as FlightSortOption);
          }}
          className="min-h-[44px] rounded-md border border-secondary-border bg-card px-3 py-1.5 text-xs font-medium text-text-primary shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
