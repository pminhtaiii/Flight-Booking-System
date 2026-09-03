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

const FORBIDDEN_PRIVACY_PATTERNS: readonly RegExp[] = Object.freeze([
  /off_[a-zA-Z0-9_-]+|ord_[a-zA-Z0-9_-]+|duffel_[a-zA-Z0-9_-]+/i,
  /bearer\s+[-a-zA-Z0-9._~+/]+=*|eyJ[a-zA-Z0-9_-]{10,}/i,
  /\b[A-Z]{1,2}\d{6,9}\b/,
  /\b(?:19\d\d|20[0-2]\d)-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/,
  /\b\d+\s+[A-Za-z0-9\s,.]+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Terrace|Way)\b/i,
]);

function containsForbiddenPrivacyPattern(value: string): boolean {
  return FORBIDDEN_PRIVACY_PATTERNS.some((pattern) => pattern.test(value));
}

function isSafeAirlineName(value: unknown): value is string {
  return isNonEmptyString(value) && !containsForbiddenPrivacyPattern(value);
}

function isScheduleBound(value: unknown): value is string | number {
  if (isFiniteNumber(value)) {
    return value >= 0 && value <= 24;
  }
  if (isNonEmptyString(value)) {
    return !containsForbiddenPrivacyPattern(value);
  }
  return false;
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
    const start = escapeText(String(windowStart));
    const end = escapeText(String(windowEnd));
    if (start.length > 0 && end.length > 0) {
      return `${actionPrefix} within preferred window (${start}:00–${end}:00)`;
    }
  }
  return `${actionPrefix} within preferred window`;
}

export function formatExplanation(explanation: Explanation): string {
  const candidateParams: unknown = explanation.params;
  const params = isRuntimeParams(candidateParams) ? candidateParams : {};

  switch (explanation.key) {
    case 'match.price.below_median':
      return isFiniteNumber(params.percentDiff)
        ? `${params.percentDiff}% below median price`
        : 'Below median price';
    case 'match.price.above_median':
      return isFiniteNumber(params.percentDiff)
        ? `${params.percentDiff}% above median price`
        : 'Above median price';
    case 'match.airline.preferred': {
      if (isSafeAirlineName(params.airline)) {
        const airline = escapeText(params.airline);
        return airline.length > 0
          ? `Matches preferred airline (${airline})`
          : 'Matches preferred airline';
      }
      return 'Matches preferred airline';
    }
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
    case 'constraint.airline.blacklisted': {
      if (isSafeAirlineName(params.airline)) {
        const airline = escapeText(params.airline);
        return airline.length > 0
          ? `Blacklisted airline (${airline})`
          : 'Blacklisted airline';
      }
      return 'Blacklisted airline';
    }
    default:
      return CONSTANT_COPY[explanation.key] ?? 'Match criterion';
  }
}
