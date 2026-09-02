import React from 'react';
import type { DimensionSignal, FlightMatchDimension, FlightMatchResult } from '@shared/types';
import { formatExplanation } from './flight-match-explanations';

export type FlightMatchBreakdownProps = {
  matchResult?: FlightMatchResult | null;
  className?: string;
  summaryLabel?: string;
};

const POLICY_DIMENSION_ORDER: readonly FlightMatchDimension[] = Object.freeze([
  'PRICE',
  'AIRLINE',
  'ARRIVAL_SCHEDULE',
  'STOPS',
  'CABIN',
  'DEPARTURE_SCHEDULE',
  'BAGGAGE',
  'DURATION',
]);

const DIMENSION_LABELS: Readonly<Record<FlightMatchDimension, string>> = Object.freeze({
  PRICE: 'Price',
  AIRLINE: 'Airline',
  ARRIVAL_SCHEDULE: 'Arrival Schedule',
  STOPS: 'Stops',
  CABIN: 'Cabin Class',
  DEPARTURE_SCHEDULE: 'Departure Schedule',
  BAGGAGE: 'Baggage',
  DURATION: 'Duration',
});

const SIGNAL_STYLES: Readonly<
  Record<
    DimensionSignal,
    {
      badge: string;
      label: string;
    }
  >
> = Object.freeze({
  POSITIVE: {
    badge: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    label: 'Positive',
  },
  NEUTRAL: {
    badge: 'text-slate-600 bg-slate-100 border-slate-200',
    label: 'Neutral',
  },
  NEGATIVE: {
    badge: 'text-rose-700 bg-rose-50 border-rose-200',
    label: 'Negative',
  },
});

function SignalIcon({ signal }: { signal: DimensionSignal }): React.JSX.Element {
  if (signal === 'POSITIVE') {
    return (
      <svg
        aria-hidden="true"
        className="h-3 w-3 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
      </svg>
    );
  }

  if (signal === 'NEGATIVE') {
    return (
      <svg
        aria-hidden="true"
        className="h-3 w-3 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3 shrink-0"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14" />
    </svg>
  );
}

export function FlightMatchBreakdown({
  matchResult,
  className,
  summaryLabel,
}: FlightMatchBreakdownProps): React.JSX.Element | null {
  if (!matchResult) {
    return null;
  }

  const defaultSummary = 'Why this flight?';
  const label = summaryLabel ?? defaultSummary;

  const combinedContainerClass = ['group text-xs', className].filter(Boolean).join(' ');

  if (!matchResult.eligibility.eligible) {
    return (
      <details className={combinedContainerClass}>
        <summary className="cursor-pointer select-none font-medium text-rose-700 hover:text-rose-800 focus:outline-none">
          {label}
        </summary>
        <div
          role="region"
          aria-label="Constraint violations"
          className="mt-2 space-y-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-rose-800"
        >
          <div className="font-semibold text-rose-900">Preference constraints not met:</div>
          <ul className="list-inside list-disc space-y-1">
            {matchResult.eligibility.violations.map((violation, index) => (
              <li key={index} className="text-rose-800">
                <span>{formatExplanation(violation.explanation)}</span>
              </li>
            ))}
          </ul>
        </div>
      </details>
    );
  }

  const sortedBreakdown = [...matchResult.breakdown].sort((a, b) => {
    const idxA = POLICY_DIMENSION_ORDER.indexOf(a.dimension);
    const idxB = POLICY_DIMENSION_ORDER.indexOf(b.dimension);
    return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
  });

  return (
    <details className={combinedContainerClass}>
      <summary className="cursor-pointer select-none font-medium text-slate-700 hover:text-slate-900 focus:outline-none">
        {label}
      </summary>
      <div
        role="region"
        aria-label="Flight match breakdown"
        className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
      >
        <div className="flex items-center justify-between border-b border-slate-200 pb-1.5 text-slate-500">
          <span className="font-semibold text-slate-700">Match Dimension</span>
          <span className="font-semibold text-slate-700">Evaluation</span>
        </div>
        <ul className="space-y-1.5">
          {sortedBreakdown.map((item) => {
            const signalConfig = SIGNAL_STYLES[item.signal] ?? SIGNAL_STYLES.NEUTRAL;
            const dimensionTitle = DIMENSION_LABELS[item.dimension] ?? item.dimension;
            const explanationText = formatExplanation(item.explanation);
            const scorePercent = Math.round(item.score * 100);

            return (
              <li
                key={item.dimension}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <div className="flex flex-col">
                  <span className="font-medium text-slate-800">{dimensionTitle}</span>
                  <span className="text-slate-500">{explanationText}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium ${signalConfig.badge}`}
                    aria-label={`Signal: ${signalConfig.label}`}
                  >
                    <SignalIcon signal={item.signal} />
                    <span>{signalConfig.label}</span>
                  </span>
                  <span className="w-8 text-right font-mono text-xs font-semibold text-slate-700">
                    {scorePercent}%
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
