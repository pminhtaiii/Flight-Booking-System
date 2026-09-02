import React from 'react';
import type { FlightMatchDimension, FlightMatchResult } from '@shared/types';
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

const SIGNAL_STYLES = Object.freeze({
  POSITIVE: {
    badge: 'text-text-match-strong bg-bg-match-strong border-text-match-strong/30',
    label: 'Positive',
    path: 'M5 13l4 4L19 7',
  },
  NEUTRAL: {
    badge: 'text-text-secondary bg-background border-card-border',
    label: 'Neutral',
    path: 'M5 12h14',
  },
  NEGATIVE: {
    badge: 'text-text-cancelled bg-bg-cancelled border-danger-border/30',
    label: 'Negative',
    path: 'M6 18L18 6M6 6l12 12',
  },
});

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
        <summary className="cursor-pointer select-none font-medium text-text-cancelled hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 rounded">
          {label}
        </summary>
        <div
          role="region"
          aria-label="Constraint violations"
          className="mt-2 space-y-2 rounded-md border border-danger-border bg-bg-cancelled p-3 text-text-cancelled"
        >
          <div className="font-semibold text-text-cancelled">Preference constraints not met:</div>
          <ul className="list-inside list-disc space-y-1">
            {matchResult.eligibility.violations.map((violation, index) => (
              <li key={index} className="text-text-cancelled">
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
      <summary className="cursor-pointer select-none font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 rounded">
        {label}
      </summary>
      <div
        role="region"
        aria-label="Flight match breakdown"
        className="mt-2 space-y-2 rounded-md border border-card-border bg-card p-3"
      >
        <div className="flex items-center justify-between border-b border-card-border pb-1.5 text-text-muted">
          <span className="font-semibold text-text-secondary">Match Dimension</span>
          <span className="font-semibold text-text-secondary">Evaluation</span>
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
                  <span className="font-medium text-text-primary">{dimensionTitle}</span>
                  <span className="text-text-muted">{explanationText}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${signalConfig.badge}`}
                    aria-label={`Signal: ${signalConfig.label}`}
                  >
                    <svg
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2.5}
                        d={signalConfig.path}
                      />
                    </svg>
                    <span>{signalConfig.label}</span>
                  </span>
                  <span className="w-8 text-right font-mono text-xs font-semibold text-text-secondary">
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
