'use client';

import { AlertTriangle, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import {
  DisruptionStatus,
  MaterialDisruptionReason,
  DisruptionResolvedReason,
} from '@shared/disruption-types';

type DisruptionAlertProps = {
  status: DisruptionStatus;
  isMaterial: boolean;
  materialReasons: MaterialDisruptionReason[];
  stabilizationWarning?: boolean;
  resolvedReason?: DisruptionResolvedReason | null;
};

export const REASON_LABELS: Record<MaterialDisruptionReason, string> = {
  [MaterialDisruptionReason.SEGMENT_REMOVED]: 'A flight segment was removed',
  [MaterialDisruptionReason.SEGMENT_ADDED]: 'A flight segment was added',
  [MaterialDisruptionReason.DEPARTURE_AIRPORT_CHANGED]: 'Departure airport changed',
  [MaterialDisruptionReason.ARRIVAL_AIRPORT_CHANGED]: 'Arrival airport changed',
  [MaterialDisruptionReason.DEPARTURE_LOCAL_DATE_CHANGED]: 'Departure date changed',
  [MaterialDisruptionReason.ARRIVAL_LOCAL_DATE_CHANGED]: 'Arrival date changed',
  [MaterialDisruptionReason.DEPARTURE_MOVED_EARLIER]:
    'Departure time moved earlier by more than 1 hour',
  [MaterialDisruptionReason.DEPARTURE_MOVED_LATER]:
    'Departure time moved later by more than 2 hours',
  [MaterialDisruptionReason.FINAL_ARRIVAL_MOVED_EARLIER]:
    'Arrival time moved earlier by more than 1 hour',
  [MaterialDisruptionReason.FINAL_ARRIVAL_MOVED_LATER]:
    'Arrival time moved later by more than 2 hours',
  [MaterialDisruptionReason.OVERNIGHT_CONNECTION_INTRODUCED]:
    'An overnight connection was introduced',
  [MaterialDisruptionReason.CONNECTION_BELOW_MCT]: 'Connection time is below the minimum required',
  [MaterialDisruptionReason.INVALID_CONNECTION_OVERLAP]: 'Invalid flight connection overlap',
};

export const RESOLVED_REASON_LABELS: Record<DisruptionResolvedReason, string> = {
  [DisruptionResolvedReason.TRAVELLER_ACCEPTED]: 'You accepted the revised itinerary.',
  [DisruptionResolvedReason.DEPARTURE_PASSED]: 'Flight departure time has passed.',
  [DisruptionResolvedReason.ADMIN_RESOLVED]: 'Resolved by support administration.',
  [DisruptionResolvedReason.BOOKING_CANCELLED]: 'Booking was cancelled.',
};

export function DisruptionAlert({
  status,
  isMaterial,
  materialReasons,
  stabilizationWarning,
  resolvedReason,
}: DisruptionAlertProps) {
  if (status === DisruptionStatus.NONE) {
    return null;
  }

  // Define alert themes based on status
  let containerClass = '';
  let iconClass = '';
  let titleClass = '';
  let titleText = '';
  let statusIcon = null;

  if (status === DisruptionStatus.DETECTED) {
    containerClass = 'bg-bg-pending border-color-text-pending/30 text-color-text-pending';
    iconClass = 'text-text-pending';
    titleClass = 'text-text-pending font-bold';
    titleText = isMaterial ? 'Flight Disruption Detected' : 'Minor Flight Change Detected';
    statusIcon = <AlertTriangle className={`h-5 w-5 ${iconClass}`} />;
  } else if (status === DisruptionStatus.ACKNOWLEDGED) {
    containerClass = 'bg-bg-match-fair border-color-text-match-fair/30 text-color-text-fair';
    iconClass = 'text-text-match-fair';
    titleClass = 'text-text-match-fair font-bold';
    titleText = 'Flight Changes Under Review';
    statusIcon = <Clock className={`h-5 w-5 ${iconClass}`} />;
  } else if (status === DisruptionStatus.RESOLVED) {
    containerClass = 'bg-bg-confirmed border-color-text-confirmed/30 text-color-text-confirmed';
    iconClass = 'text-text-confirmed';
    titleClass = 'text-text-confirmed font-bold';
    titleText = 'Flight Disruption Resolved';
    statusIcon = <CheckCircle className={`h-5 w-5 ${iconClass}`} />;
  }

  return (
    <div className="space-y-3">
      <div
        role="alert"
        aria-live="polite"
        className={`flex gap-3 p-4 rounded-xl border ${containerClass}`}
      >
        <div className="flex-shrink-0 mt-0.5">{statusIcon}</div>
        <div className="space-y-2 flex-1">
          <h3 className={`text-base ${titleClass}`}>{titleText}</h3>

          <div className="text-sm space-y-1">
            {status === DisruptionStatus.DETECTED && (
              <p>
                The airline has updated the schedule. Please review the changes below and take
                action.
              </p>
            )}
            {status === DisruptionStatus.ACKNOWLEDGED && (
              <p>
                You have acknowledged the changes. Please confirm whether you accept the updated
                itinerary.
              </p>
            )}
            {status === DisruptionStatus.RESOLVED && (
              <p>
                {resolvedReason
                  ? RESOLVED_REASON_LABELS[resolvedReason]
                  : 'This flight disruption has been resolved.'}
              </p>
            )}
          </div>

          {materialReasons && materialReasons.length > 0 && (
            <div className="mt-3 pt-3 border-t border-current/10">
              <h4 className="text-xs font-semibold uppercase tracking-wider opacity-90 mb-1.5">
                Reasons for change:
              </h4>
              <ul className="text-sm list-disc pl-4 space-y-1 opacity-95">
                {materialReasons.map((reason) => (
                  <li key={reason}>{REASON_LABELS[reason] || reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {stabilizationWarning && (
        <div
          role="alert"
          aria-live="polite"
          className="flex gap-3 p-4 rounded-xl border bg-bg-cancelled border-color-text-cancelled/30 text-color-text-cancelled"
        >
          <div className="flex-shrink-0 mt-0.5">
            <AlertCircle className="h-5 w-5 text-text-cancelled" />
          </div>
          <div>
            <h3 className="text-base font-bold text-text-cancelled">Schedule Instability Alert</h3>
            <p className="text-sm mt-1">
              Airline schedules are currently volatile. This itinerary may undergo further
              revisions.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
