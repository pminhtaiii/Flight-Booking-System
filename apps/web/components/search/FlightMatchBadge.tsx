import React from 'react';
import type { FlightMatchResult, MatchLevel } from '@shared/types';
import { formatExplanation } from './flight-match-explanations';

export type FlightMatchBadgeProps = {
  matchResult?: FlightMatchResult | null;
  className?: string;
};

const LEVEL_STYLES: Readonly<Record<MatchLevel, string>> = Object.freeze({
  STRONG: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  GOOD: 'text-sky-700 bg-sky-50 border-sky-200',
  FAIR: 'text-amber-700 bg-amber-50 border-amber-200',
  WEAK: 'text-slate-600 bg-slate-100 border-slate-200',
});

const LEVEL_LABELS: Readonly<Record<MatchLevel, string>> = Object.freeze({
  STRONG: 'Strong Match',
  GOOD: 'Good Match',
  FAIR: 'Fair Match',
  WEAK: 'Weak Match',
});

const INELIGIBLE_STYLES = 'text-rose-700 bg-rose-50 border-rose-200';
const BASE_BADGE_STYLES = 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium';

export function FlightMatchBadge({ matchResult, className }: FlightMatchBadgeProps): React.JSX.Element | null {
  if (!matchResult) {
    return null;
  }

  if (!matchResult.eligibility.eligible) {
    const violation = matchResult.eligibility.violations[0];
    const violationReason = violation ? formatExplanation(violation.explanation) : 'Preference violation';
    const ariaLabel = `Flight violates preference: ${violationReason}`;

    const combinedClasses = [
      BASE_BADGE_STYLES,
      INELIGIBLE_STYLES,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <span role="status" aria-label={ariaLabel} className={combinedClasses}>
        <svg
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <span>{violationReason}</span>
      </span>
    );
  }

  const { score, matchLevel } = matchResult;
  if (score === null || matchLevel === null) {
    return null;
  }

  const levelStyle = LEVEL_STYLES[matchLevel] ?? LEVEL_STYLES.WEAK;
  const levelLabel = LEVEL_LABELS[matchLevel] ?? 'Match';
  const ariaLabel = `${score}% match - ${levelLabel}`;

  const combinedClasses = [
    BASE_BADGE_STYLES,
    levelStyle,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span role="status" aria-label={ariaLabel} className={combinedClasses}>
      <span className="font-semibold">{score}%</span>
      <span className="font-medium">{levelLabel}</span>
    </span>
  );
}
