import type { Explanation } from '@shared/types';

const CONSTANT_COPY: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null), {
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
  }),
);

type RuntimeParams = Record<string, unknown>;

function isRuntimeParams(value: unknown): value is RuntimeParams {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isScheduleBound(value: unknown): value is string | number {
  return isNonEmptyString(value) || isFiniteNumber(value);
}

function isStopCount(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatScheduleWindow(
  actionPrefix: 'Arrives' | 'Departs',
  windowStart: unknown,
  windowEnd: unknown,
): string {
  if (isScheduleBound(windowStart) && isScheduleBound(windowEnd)) {
    return `${actionPrefix} within preferred window (${escapeText(String(windowStart))}:00–${escapeText(String(windowEnd))}:00)`;
  }
  return `${actionPrefix} within preferred window`;
}

export function formatExplanation(explanation: Explanation): string {
  const rawParams: unknown = explanation.params;
  const params = isRuntimeParams(rawParams) ? rawParams : {};

  switch (explanation.key) {
    case 'match.price.below_median':
      return isFiniteNumber(params.percentDiff)
        ? `${params.percentDiff}% below median price`
        : 'Below median price';
    case 'match.price.above_median':
      return isFiniteNumber(params.percentDiff)
        ? `${params.percentDiff}% above median price`
        : 'Above median price';
    case 'match.airline.preferred':
      return isNonEmptyString(params.airline)
        ? `Matches preferred airline (${escapeText(params.airline)})`
        : 'Matches preferred airline';
    case 'match.arrival.in_window':
      return formatScheduleWindow('Arrives', params.windowStart, params.windowEnd);
    case 'match.stops.within_preference':
      return isStopCount(params.stops)
        ? `Within preferred stops (${params.stops} stops)`
        : 'Within preferred stops';
    case 'match.stops.exceeds_preference':
      return isStopCount(params.stops) && isStopCount(params.maxStops)
        ? `Exceeds preferred stops (${params.stops} stops, max ${params.maxStops})`
        : 'Exceeds preferred stops';
    case 'match.stops.relative':
      return isStopCount(params.stops)
        ? params.stops === 0
          ? 'Direct flight'
          : `${params.stops} stops`
        : 'Flight with stops';
    case 'match.departure.in_window':
      return formatScheduleWindow('Departs', params.windowStart, params.windowEnd);
    case 'constraint.airline.blacklisted':
      return isNonEmptyString(params.airline)
        ? `Blacklisted airline (${escapeText(params.airline)})`
        : 'Blacklisted airline';
    default:
      return CONSTANT_COPY[explanation.key] ?? 'Match criterion';
  }
}
