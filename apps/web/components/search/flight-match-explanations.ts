import type { Explanation } from '@shared/types';

const CONSTANT_COPY: Partial<Record<Explanation['key'], string>> = {
  'match.price.at_median': 'At median price',
  'match.airline.neutral': 'Standard airline match',
  'match.arrival.near_window': 'Arrives near preferred window',
  'match.arrival.outside_window': 'Arrives outside preferred window',
  'match.cabin.exact': 'Matches requested cabin',
  'match.cabin.adjacent': 'Adjacent cabin class',
  'match.cabin.mismatch': 'Cabin mismatch',
  'match.departure.near_window': 'Departs near preferred window',
  'match.departure.outside_window': 'Departs outside preferred window',
  'match.baggage.checked_included': 'Checked bag included',
  'match.baggage.checked_missing': 'Checked bag not included',
  'match.baggage.not_required': 'No baggage requirement',
  'match.duration.below_median': 'Shorter than median duration',
  'match.duration.at_median': 'Median duration',
  'match.duration.above_median': 'Longer than median duration',
};

export function formatExplanation(explanation: Explanation): string {
  switch (explanation.key) {
    case 'match.price.below_median':
      return `${explanation.params.percentDiff}% below median price`;
    case 'match.price.above_median':
      return `${explanation.params.percentDiff}% above median price`;
    case 'match.airline.preferred':
      return `Matches preferred airline (${explanation.params.airline})`;
    case 'match.arrival.in_window':
      return `Arrives within preferred window (${explanation.params.windowStart}:00–${explanation.params.windowEnd}:00)`;
    case 'match.stops.within_preference':
      return `Within preferred stops (${explanation.params.stops} stops)`;
    case 'match.stops.exceeds_preference':
      return `Exceeds preferred stops (${explanation.params.stops} stops, max ${explanation.params.maxStops})`;
    case 'match.stops.relative':
      return explanation.params.stops === 0 ? 'Direct flight' : `${explanation.params.stops} stops`;
    case 'match.departure.in_window':
      return `Departs within preferred window (${explanation.params.windowStart}:00–${explanation.params.windowEnd}:00)`;
    case 'constraint.airline.blacklisted':
      return `Blacklisted airline (${explanation.params.airline})`;
    default:
      return CONSTANT_COPY[explanation.key] ?? 'Match criterion';
  }
}
