import * as crypto from 'crypto';
import { DuffelOffer, DuffelSegment } from '@/duffel/duffel.types';
import { FlightMatchInput } from '@/flight-match/flight-match.types';

export type OfferRejectionReason =
  | 'MALFORMED_OFFER'
  | 'MISSING_SLICES_OR_SEGMENTS'
  | 'INVALID_PRICE'
  | 'INVALID_DURATION'
  | 'INVALID_STOPS'
  | 'INVALID_TIMESTAMP'
  | 'MIXED_CURRENCY';

export type NormalizationResult = {
  readonly normalizedOffers: readonly FlightMatchInput[];
  readonly droppedCount: number;
  readonly rejectionCounts: Readonly<Record<string, number>>;
  readonly currency: string | null;
};

/**
 * Parses an ISO8601 duration string (e.g. PT2H30M, P1DT2H) into total minutes.
 */
export function parseISO8601Duration(durationStr: string | null | undefined): number {
  if (!durationStr) return 0;
  const regex = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
  const matches = durationStr.match(regex);
  if (!matches) return 0;
  const days = parseInt(matches[1] || '0', 10);
  const hours = parseInt(matches[2] || '0', 10);
  const minutes = parseInt(matches[3] || '0', 10);
  return days * 1440 + hours * 60 + minutes;
}

/**
 * Generates a deterministic RFC 4122 v4-formatted UUID from an input string using SHA-256.
 */
export function generateDeterministicUUID(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    '8' + hash.substring(17, 20),
    hash.substring(20, 32),
  ].join('-');
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function getDaysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/**
 * Strictly validates an ISO8601 datetime string.
 * Checks valid 4-digit year, 01-12 month, valid day for month/leap year,
 * 00-23 hour, 00-59 minute, 00-59 second, optional milliseconds,
 * and optional timezone offset (Z, +/-HH:mm, +/-HHmm, +/-HH).
 */
export function isValidIsoDateTime(isoDateTime: string | null | undefined): boolean {
  if (!isoDateTime || typeof isoDateTime !== 'string') return false;
  const match = isoDateTime.match(
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3])(?::?[0-5]\d)?|14(?::?00)?))?$/i,
  );
  if (!match) return false;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  const daysInMonth = getDaysInMonth(year, month);
  if (day < 1 || day > daysInMonth) {
    return false;
  }

  return true;
}

/**
 * Extracts the local clock hour (0..23) directly from an ISO datetime string, or null if invalid.
 */
export function extractLocalHour(isoDateTime: string | null | undefined): number | null {
  if (!isValidIsoDateTime(isoDateTime)) return null;
  const match = (isoDateTime as string).match(/T(\d{2}):/i);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  return !isNaN(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

/**
 * Extracts and records unique carrier IATA code and name into accumulator structures.
 */
function extractCarrierInfo(
  carrier: { readonly iata_code?: string | null; readonly name?: string | null } | undefined | null,
  carrierCodesSet: Set<string>,
  carrierCodes: string[],
  carrierNamesByCode: Record<string, string>,
): void {
  if (!carrier?.iata_code) return;
  const code = carrier.iata_code.trim().toUpperCase();
  if (!code) return;

  if (!carrierCodesSet.has(code)) {
    carrierCodesSet.add(code);
    carrierCodes.push(code);
  }
  if (carrier.name && !carrierNamesByCode[code]) {
    carrierNamesByCode[code] = carrier.name.trim();
  }
}

export type OfferValidationResult =
  | { readonly success: true; readonly offer: FlightMatchInput }
  | { readonly success: false; readonly reason: OfferRejectionReason };

/**
 * Validates and normalizes a single DuffelOffer into a pure FlightMatchInput or rejection reason.
 */
export function validateAndNormalizeOffer(
  offer: DuffelOffer,
  originalIndex: number,
): OfferValidationResult {
  if (!offer || typeof offer !== 'object' || !offer.id || typeof offer.id !== 'string' || !offer.id.trim()) {
    return { success: false, reason: 'MALFORMED_OFFER' };
  }

  if (!offer.slices || !Array.isArray(offer.slices) || offer.slices.length === 0) {
    return { success: false, reason: 'MISSING_SLICES_OR_SEGMENTS' };
  }

  for (const slice of offer.slices) {
    if (!slice || !slice.segments || !Array.isArray(slice.segments) || slice.segments.length === 0) {
      return { success: false, reason: 'MISSING_SLICES_OR_SEGMENTS' };
    }
  }

  if (
    !offer.total_amount ||
    typeof offer.total_amount !== 'string' ||
    !offer.total_amount.trim() ||
    !offer.total_currency ||
    typeof offer.total_currency !== 'string' ||
    !offer.total_currency.trim()
  ) {
    return { success: false, reason: 'INVALID_PRICE' };
  }

  const price = parseFloat(offer.total_amount);
  if (isNaN(price) || !Number.isFinite(price) || price <= 0) {
    return { success: false, reason: 'INVALID_PRICE' };
  }

  const outboundSlice = offer.slices[0];
  const outboundSegments = outboundSlice.segments;
  const firstOutboundSegment = outboundSegments[0];
  const lastOutboundSegment = outboundSegments[outboundSegments.length - 1];

  const outboundDepartureHour = extractLocalHour(firstOutboundSegment?.departing_at);
  // Note: outboundArrivalHour represents the local arrival hour of the outbound slice's final leg
  // (the flight arriving at the primary destination), used for arrival schedule scoring.
  const outboundArrivalHour = extractLocalHour(lastOutboundSegment?.arriving_at);

  if (outboundDepartureHour === null || outboundArrivalHour === null) {
    return { success: false, reason: 'INVALID_TIMESTAMP' };
  }

  let duration = 0;
  let stops = 0;
  let maxSegmentDuration = -1;
  let longestCabinClass = 'economy';

  const carrierCodesSet = new Set<string>();
  const carrierCodes: string[] = [];
  const carrierNamesByCode: Record<string, string> = {};

  let hasOmittedBaggageSlice = false;
  let allSlicesHaveChecked = true;

  for (const slice of offer.slices) {
    const sliceDuration = parseISO8601Duration(slice.duration);
    duration += sliceDuration;

    const segCount = slice.segments?.length ?? 0;
    if (segCount > 1) {
      stops += segCount - 1;
    }

    let longestSliceSeg: DuffelSegment | null = null;
    let maxSliceSegDuration = -1;

    for (const segment of slice.segments ?? []) {
      const segDuration = parseISO8601Duration(segment.duration);

      // Track longest segment across entire itinerary for cabin class
      if (segDuration > maxSegmentDuration) {
        maxSegmentDuration = segDuration;
        const cabin = segment.passengers?.[0]?.cabin_class;
        longestCabinClass = cabin ? cabin.trim().toLowerCase() : 'economy';
      }

      // Track longest segment in this slice for baggage
      if (segDuration > maxSliceSegDuration) {
        maxSliceSegDuration = segDuration;
        longestSliceSeg = segment;
      }

      // Carrier codes & names
      extractCarrierInfo(segment.marketing_carrier, carrierCodesSet, carrierCodes, carrierNamesByCode);
      extractCarrierInfo(segment.operating_carrier, carrierCodesSet, carrierCodes, carrierNamesByCode);
    }

    // Checked baggage per slice's longest segment
    const baggages = longestSliceSeg?.passengers?.[0]?.baggages;
    if (baggages !== undefined && baggages !== null) {
      const hasCheckedInSlice = baggages.some(
        (b) =>
          b.type?.toLowerCase() === 'checked' &&
          (b.quantity === undefined || b.quantity > 0),
      );
      if (!hasCheckedInSlice) {
        allSlicesHaveChecked = false;
      }
    } else {
      hasOmittedBaggageSlice = true;
    }
  }

  if (duration <= 0 || !Number.isFinite(duration)) {
    return { success: false, reason: 'INVALID_DURATION' };
  }

  if (stops < 0 || !Number.isInteger(stops) || !Number.isFinite(stops)) {
    return { success: false, reason: 'INVALID_STOPS' };
  }

  const hasCheckedBaggage: boolean | null = hasOmittedBaggageSlice
    ? null
    : allSlicesHaveChecked;

  return {
    success: true,
    offer: {
      id: generateDeterministicUUID(offer.id),
      price,
      currency: offer.total_currency,
      stops,
      duration,
      outboundDepartureHour,
      outboundArrivalHour,
      carrierCodes,
      carrierNamesByCode: Object.keys(carrierNamesByCode).length > 0 ? carrierNamesByCode : undefined,
      cabinClass: longestCabinClass,
      hasCheckedBaggage,
      originalIndex,
    },
  };
}

/**
 * Normalizes a single DuffelOffer into a pure FlightMatchInput (returns null if invalid).
 */
export function normalizeOffer(offer: DuffelOffer, originalIndex: number): FlightMatchInput | null {
  const result = validateAndNormalizeOffer(offer, originalIndex);
  return result.success ? result.offer : null;
}

/**
 * Normalizes a list of raw Duffel offers into pure FlightMatchInput records.
 */
export function normalizeFlightOffers(rawOffers: readonly DuffelOffer[]): NormalizationResult {
  const normalizedOffers: FlightMatchInput[] = [];
  const rejectionCounts: Record<string, number> = {};
  let droppedCount = 0;
  let lockedCurrency: string | null = null;

  for (let i = 0; i < rawOffers.length; i++) {
    const rawOffer = rawOffers[i];
    const validationResult = validateAndNormalizeOffer(rawOffer, i);

    if (!validationResult.success) {
      droppedCount++;
      const reason = validationResult.reason;
      rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
      continue;
    }

    const offer = validationResult.offer;

    if (lockedCurrency === null) {
      lockedCurrency = offer.currency;
    } else if (offer.currency !== lockedCurrency) {
      droppedCount++;
      rejectionCounts['MIXED_CURRENCY'] = (rejectionCounts['MIXED_CURRENCY'] || 0) + 1;
      continue;
    }

    normalizedOffers.push(offer);
  }

  return {
    normalizedOffers,
    droppedCount,
    rejectionCounts,
    currency: lockedCurrency,
  };
}

