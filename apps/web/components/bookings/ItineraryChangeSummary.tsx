'use client';

import { ArrowRight, Info, AlertTriangle, RefreshCw } from 'lucide-react';

type SliceSummary = {
  sliceOrder: number;
  originIata: string;
  destinationIata: string;
  finalArrivalShiftMinutes: number | null;
};

type PresentationSummary = {
  isRoutingChanged?: boolean;
  hasStopsChanged?: boolean;
  addedSegmentsCount?: number;
  removedSegmentsCount?: number;
  sliceSummaries?: SliceSummary[];
};

type ItineraryChangeSummaryProps = {
  incrementalSummary: Record<string, unknown> | null;
  cumulativeSummary: Record<string, unknown> | null;
};

const formatShiftMinutes = (minutes: number | null): string => {
  if (minutes === null || minutes === 0) return 'No change';
  const sign = minutes > 0 ? '+' : '';
  const absMinutes = Math.abs(minutes);
  const hrs = Math.floor(absMinutes / 60);
  const mins = absMinutes % 60;

  const parts = [];
  if (hrs > 0) parts.push(`${hrs}h`);
  if (mins > 0 || hrs === 0) parts.push(`${mins}m`);

  return `${sign}${minutes > 0 ? '' : '-'}${parts.join(' ')}`;
};

export function ItineraryChangeSummary({
  incrementalSummary,
  cumulativeSummary,
}: ItineraryChangeSummaryProps) {
  const inc = incrementalSummary as PresentationSummary | null;
  const cum = cumulativeSummary as PresentationSummary | null;

  const hasIncChanges =
    inc &&
    (inc.isRoutingChanged ||
      inc.hasStopsChanged ||
      (inc.addedSegmentsCount ?? 0) > 0 ||
      (inc.removedSegmentsCount ?? 0) > 0 ||
      inc.sliceSummaries?.some((s) => s.finalArrivalShiftMinutes !== 0));

  const hasCumChanges =
    cum &&
    (cum.isRoutingChanged ||
      cum.hasStopsChanged ||
      (cum.addedSegmentsCount ?? 0) > 0 ||
      (cum.removedSegmentsCount ?? 0) > 0 ||
      cum.sliceSummaries?.some((s) => s.finalArrivalShiftMinutes !== 0));

  if (!hasIncChanges && !hasCumChanges) {
    return null;
  }

  return (
    <div className="bg-bg-secondary p-5 rounded-xl border border-card-border space-y-6">
      <div className="flex items-center gap-2 pb-3 border-b border-card-border">
        <RefreshCw className="h-5 w-5 text-accent" />
        <h3 className="font-bold text-text-primary text-base">Itinerary Change Summary</h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Incremental changes (Latest revision vs Previous) */}
        {hasIncChanges && (
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
              <Info className="h-4 w-4 text-accent" />
              Latest Changes (This Update)
            </h4>
            <div className="bg-card p-4 rounded-lg border border-card-border space-y-3">
              {inc.isRoutingChanged && (
                <div className="flex items-center gap-2 text-sm text-text-cancelled font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  <span>Route has been changed.</span>
                </div>
              )}
              {inc.hasStopsChanged && (
                <p className="text-sm text-text-secondary">
                  Number of connection stops changed (
                  {inc.removedSegmentsCount ? `-${inc.removedSegmentsCount}` : ''}{' '}
                  {inc.addedSegmentsCount ? `+${inc.addedSegmentsCount}` : ''}).
                </p>
              )}
              {inc.sliceSummaries && inc.sliceSummaries.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Arrival Time Shift:
                  </p>
                  <ul className="space-y-1.5">
                    {inc.sliceSummaries.map((slice) => (
                      <li
                        key={slice.sliceOrder}
                        className="flex justify-between text-sm items-center"
                      >
                        <span className="text-text-secondary flex items-center gap-1">
                          {slice.originIata} <ArrowRight className="h-3 w-3 text-text-muted" />{' '}
                          {slice.destinationIata}
                        </span>
                        <span
                          className={`font-semibold ${
                            (slice.finalArrivalShiftMinutes ?? 0) === 0
                              ? 'text-text-secondary'
                              : Math.abs(slice.finalArrivalShiftMinutes ?? 0) > 120
                                ? 'text-text-cancelled'
                                : 'text-text-pending'
                          }`}
                        >
                          {formatShiftMinutes(slice.finalArrivalShiftMinutes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Cumulative drift (Proposed vs Original Booking) */}
        {hasCumChanges && (
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 text-text-pending" />
              Cumulative Drift (Since Original Booking)
            </h4>
            <div className="bg-card p-4 rounded-lg border border-card-border space-y-3">
              {cum.isRoutingChanged && (
                <div className="flex items-center gap-2 text-sm text-text-cancelled font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  <span>Proposed route differs from original booking.</span>
                </div>
              )}
              {cum.hasStopsChanged && (
                <p className="text-sm text-text-secondary">
                  Stops change relative to original booking.
                </p>
              )}
              {cum.sliceSummaries && cum.sliceSummaries.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Cumulative Shift:
                  </p>
                  <ul className="space-y-1.5">
                    {cum.sliceSummaries.map((slice) => (
                      <li
                        key={slice.sliceOrder}
                        className="flex justify-between text-sm items-center"
                      >
                        <span className="text-text-secondary flex items-center gap-1">
                          {slice.originIata} <ArrowRight className="h-3 w-3 text-text-muted" />{' '}
                          {slice.destinationIata}
                        </span>
                        <span
                          className={`font-semibold ${
                            (slice.finalArrivalShiftMinutes ?? 0) === 0
                              ? 'text-text-secondary'
                              : Math.abs(slice.finalArrivalShiftMinutes ?? 0) > 120
                                ? 'text-text-cancelled'
                                : 'text-text-pending'
                          }`}
                        >
                          {formatShiftMinutes(slice.finalArrivalShiftMinutes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="text-xs text-text-muted border-t border-card-border pt-3">
        <p>
          Original booking schedule is preserved for comparison. All times display in local time
          zones.
        </p>
      </div>
    </div>
  );
}
