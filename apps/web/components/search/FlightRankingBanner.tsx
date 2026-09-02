import React from 'react';
import Link from 'next/link';

export type FlightRankingBannerProps = {
  mode: 'MATCHED' | 'RANKED';
  className?: string;
};

export function FlightRankingBanner({
  mode,
  className,
}: FlightRankingBannerProps): React.JSX.Element | null {
  if (mode !== 'RANKED') {
    return null;
  }

  const containerClasses = [
    'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs sm:text-sm text-slate-700',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div role="status" aria-label="Flight ranking notice" className={containerClasses}>
      <div className="flex items-start sm:items-center gap-2.5">
        <svg
          aria-hidden="true"
          className="h-5 w-5 shrink-0 text-slate-500 mt-0.5 sm:mt-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>
          Showing standard category ranking (stops, price, duration). Customize your flight
          preferences in your traveler profile.
        </span>
      </div>
      <Link
        href="/profile"
        className="inline-flex items-center self-start sm:self-auto shrink-0 font-semibold text-sky-700 underline underline-offset-2 hover:text-sky-800 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-1 rounded"
      >
        Update Preferences
      </Link>
    </div>
  );
}
