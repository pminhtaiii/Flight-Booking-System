import { MaterialDisruptionReason, MaterialBaseline } from '@shared/disruption-types';
import { ItineraryDiffResult } from './itinerary-diff';

export interface MaterialityResult {
  isMaterial: boolean;
  reasons: MaterialDisruptionReason[];
  baselines: MaterialBaseline[];
  rulesetVersion: string;
}

function evaluateDiffForReasons(diff: ItineraryDiffResult): MaterialDisruptionReason[] {
  const reasons: MaterialDisruptionReason[] = [];

  // Binary rules
  if (diff.removedSegments.length > 0) {
    reasons.push(MaterialDisruptionReason.SEGMENT_REMOVED);
  }
  if (diff.addedSegments.length > 0) {
    reasons.push(MaterialDisruptionReason.SEGMENT_ADDED);
  }
  if (diff.segmentDiffs.some(d => d.departureAirportChanged)) {
    reasons.push(MaterialDisruptionReason.DEPARTURE_AIRPORT_CHANGED);
  }
  if (diff.segmentDiffs.some(d => d.arrivalAirportChanged)) {
    reasons.push(MaterialDisruptionReason.ARRIVAL_AIRPORT_CHANGED);
  }
  if (diff.sliceDiffs.some(d => d.departureAirportChanged)) {
    if (!reasons.includes(MaterialDisruptionReason.DEPARTURE_AIRPORT_CHANGED)) {
      reasons.push(MaterialDisruptionReason.DEPARTURE_AIRPORT_CHANGED);
    }
  }
  if (diff.sliceDiffs.some(d => d.arrivalAirportChanged)) {
    if (!reasons.includes(MaterialDisruptionReason.ARRIVAL_AIRPORT_CHANGED)) {
      reasons.push(MaterialDisruptionReason.ARRIVAL_AIRPORT_CHANGED);
    }
  }
  if (diff.segmentDiffs.some(d => d.departureLocalDateChanged)) {
    reasons.push(MaterialDisruptionReason.DEPARTURE_LOCAL_DATE_CHANGED);
  }
  if (diff.segmentDiffs.some(d => d.arrivalLocalDateChanged)) {
    reasons.push(MaterialDisruptionReason.ARRIVAL_LOCAL_DATE_CHANGED);
  }
  if (diff.connectionDiffs.some(d => d.isOvernightIntroduced)) {
    reasons.push(MaterialDisruptionReason.OVERNIGHT_CONNECTION_INTRODUCED);
  }
  if (diff.connectionDiffs.some(d => d.isBelowMct)) {
    reasons.push(MaterialDisruptionReason.CONNECTION_BELOW_MCT);
  }
  if (diff.connectionDiffs.some(d => d.isOverlapping)) {
    reasons.push(MaterialDisruptionReason.INVALID_CONNECTION_OVERLAP);
  }

  // Threshold rules
  if (diff.segmentDiffs.some(d => d.departureTimeShiftMinutes < -60)) {
    reasons.push(MaterialDisruptionReason.DEPARTURE_MOVED_EARLIER);
  }
  if (diff.segmentDiffs.some(d => d.departureTimeShiftMinutes > 120)) {
    reasons.push(MaterialDisruptionReason.DEPARTURE_MOVED_LATER);
  }
  if (diff.sliceDiffs.some(d => d.finalArrivalShiftMinutes !== null && d.finalArrivalShiftMinutes < -60)) {
    reasons.push(MaterialDisruptionReason.FINAL_ARRIVAL_MOVED_EARLIER);
  }
  if (diff.sliceDiffs.some(d => d.finalArrivalShiftMinutes !== null && d.finalArrivalShiftMinutes > 120)) {
    reasons.push(MaterialDisruptionReason.FINAL_ARRIVAL_MOVED_LATER);
  }

  return reasons;
}

export function classifyMateriality(
  incrementalDiff: ItineraryDiffResult,
  cumulativeDiff: ItineraryDiffResult
): MaterialityResult {
  const incReasons = evaluateDiffForReasons(incrementalDiff);
  const cumReasons = evaluateDiffForReasons(cumulativeDiff);

  const baselines: MaterialBaseline[] = [];
  if (incReasons.length > 0) {
    baselines.push(MaterialBaseline.INCREMENTAL);
  }
  if (cumReasons.length > 0) {
    baselines.push(MaterialBaseline.CUMULATIVE);
  }

  const combinedReasonsSet = new Set<MaterialDisruptionReason>([...incReasons, ...cumReasons]);
  const reasons = Array.from(combinedReasonsSet);

  return {
    isMaterial: reasons.length > 0,
    reasons,
    baselines,
    rulesetVersion: 'disruption-v1'
  };
}
