import * as crypto from 'crypto';
import {
  FlightOffer,
  FlightSegment,
  FlightOfferPassenger,
  FlightOfferConditions,
} from './flight-search.port';
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
  readonly normalizedOffers: readonly FlightOffer[];
  readonly droppedCount: number;
  readonly rejectionCounts: Readonly<Record<string, number>>;
  readonly currency: string | null;
};

type RawPlace = {
  iata_code?: string | null;
  name?: string | null;
};

type RawCarrier = {
  iata_code?: string | null;
  name?: string | null;
};

type RawAircraft = {
  iata_code?: string | null;
  name?: string | null;
};

type RawBaggage = {
  type?: string;
  quantity?: number;
  weight?: number;
  weight_unit?: string;
};

type RawSegmentPassenger = {
  passenger_id?: string;
  cabin_class?: string;
  baggages?: RawBaggage[];
};

type RawSegment = {
  id?: string;
  duration?: string;
  departing_at?: string;
  arriving_at?: string;
  origin?: RawPlace;
  origin_terminal?: string | null;
  destination?: RawPlace;
  destination_terminal?: string | null;
  marketing_carrier?: RawCarrier;
  operating_carrier?: RawCarrier;
  marketing_carrier_flight_number?: string;
  aircraft?: RawAircraft | null;
  passengers?: RawSegmentPassenger[];
};

type RawSlice = {
  id?: string;
  duration?: string;
  origin?: RawPlace;
  destination?: RawPlace;
  segments?: RawSegment[];
};

type RawPassenger = {
  id?: string;
  type?: string;
};

type RawConditions = {
  refund_before_departure?: {
    allowed?: boolean;
    penalty_amount?: string | null;
    penalty_currency?: string | null;
  } | null;
  change_before_departure?: {
    allowed?: boolean;
    penalty_amount?: string | null;
    penalty_currency?: string | null;
  } | null;
};

type RawOffer = {
  id?: string;
  total_amount?: string;
  total_currency?: string;
  expires_at?: string | null;
  passengers?: RawPassenger[];
  slices?: RawSlice[];
  conditions?: RawConditions | null;
};

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

export function extractLocalHour(isoDateTime: string | null | undefined): number | null {
  if (!isValidIsoDateTime(isoDateTime)) return null;
  const match = (isoDateTime as string).match(/T(\d{2}):/i);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  return !isNaN(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

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

function capitalize(str: string | null | undefined): string | null {
  if (!str) return null;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function mapPassengerType(type: string | undefined | null): 'ADULT' | 'CHILD' | 'INFANT' {
  if (!type) return 'ADULT';
  const t = type.toLowerCase();
  if (t.includes('infant')) return 'INFANT';
  if (t.includes('child')) return 'CHILD';
  return 'ADULT';
}

function mapCabinClass(
  cabin: string | undefined | null,
): 'economy' | 'premium_economy' | 'business' | 'first' {
  const c = cabin?.toLowerCase()?.trim();
  if (c === 'premium_economy' || c === 'business' || c === 'first') {
    return c;
  }
  return 'economy';
}

function mapAircraft(aircraft: RawAircraft | null | undefined): string | null {
  if (!aircraft) return null;
  const name = aircraft.name?.trim() || '';
  const code = aircraft.iata_code?.trim() || '';
  if (name.includes('Airbus')) {
    return name.replace('Airbus ', '').trim() || null;
  }
  return name || code || null;
}

function mapBaggageAllowance(baggages: RawBaggage[] | null | undefined): string | null {
  if (!baggages || baggages.length === 0) return null;
  const bag = baggages[0];
  if (!bag || !bag.type) return null;
  if (bag.quantity === undefined && bag.weight !== undefined) {
    return `${bag.weight}${(bag.weight_unit || 'kg').toLowerCase()} ${bag.type}`;
  }
  return `${bag.quantity ?? 0} ${bag.type} bag(s)`;
}

function extractCarrierInfo(
  carrier: RawCarrier | undefined | null,
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

function mapSegment(segment: RawSegment): FlightSegment {
  return {
    supplierSegmentId: segment.id || null,
    carrierCode: segment.marketing_carrier?.iata_code || '',
    flightNumber: segment.marketing_carrier_flight_number || '',
    operatingCarrier:
      segment.operating_carrier?.name ||
      segment.marketing_carrier?.name ||
      '',
    departureAirport: segment.origin?.iata_code || '',
    departureTerminal: segment.origin_terminal ?? null,
    departureTime: segment.departing_at || '',
    arrivalAirport: segment.destination?.iata_code || '',
    arrivalTerminal: segment.destination_terminal ?? null,
    arrivalTime: segment.arriving_at || '',
    duration: parseISO8601Duration(segment.duration),
    aircraft: mapAircraft(segment.aircraft),
    cabinClass: mapCabinClass(segment.passengers?.[0]?.cabin_class),
  };
}

export type OfferValidationResult =
  | { readonly success: true; readonly offer: FlightOffer }
  | { readonly success: false; readonly reason: OfferRejectionReason };

export function validateAndNormalizeDuffelOffer(
  rawOffer: unknown,
  originalIndex = 0,
): OfferValidationResult {
  if (
    !rawOffer ||
    typeof rawOffer !== 'object' ||
    Array.isArray(rawOffer)
  ) {
    return { success: false, reason: 'MALFORMED_OFFER' };
  }

  const offer = rawOffer as RawOffer;
  if (!offer.id || typeof offer.id !== 'string' || !offer.id.trim()) {
    return { success: false, reason: 'MALFORMED_OFFER' };
  }

  if (!offer.slices || !Array.isArray(offer.slices) || offer.slices.length === 0) {
    return { success: false, reason: 'MISSING_SLICES_OR_SEGMENTS' };
  }

  for (const slice of offer.slices) {
    if (
      !slice ||
      typeof slice !== 'object' ||
      Array.isArray(slice) ||
      !slice.segments ||
      !Array.isArray(slice.segments) ||
      slice.segments.length === 0
    ) {
      return { success: false, reason: 'MISSING_SLICES_OR_SEGMENTS' };
    }
    for (const segment of slice.segments) {
      if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
        return { success: false, reason: 'MISSING_SLICES_OR_SEGMENTS' };
      }
      if (
        !segment.departing_at ||
        !isValidIsoDateTime(segment.departing_at) ||
        !segment.arriving_at ||
        !isValidIsoDateTime(segment.arriving_at)
      ) {
        return { success: false, reason: 'INVALID_TIMESTAMP' };
      }
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
  const outboundSegments = outboundSlice.segments!;
  const firstOutboundSegment = outboundSegments[0];
  const lastOutboundSegment = outboundSegments[outboundSegments.length - 1];

  const outboundDepartureHour = extractLocalHour(firstOutboundSegment?.departing_at);
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

    let longestSliceSeg: RawSegment | null = null;
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

  const id = generateDeterministicUUID(offer.id);

  const passengers: FlightOfferPassenger[] = (offer.passengers || []).map((p) => ({
    supplierPassengerId: p.id || '',
    type: mapPassengerType(p.type),
  }));

  const airline =
    firstOutboundSegment?.operating_carrier?.name ||
    firstOutboundSegment?.marketing_carrier?.name ||
    'Unknown Airline';

  const flightNumber =
    (firstOutboundSegment?.marketing_carrier?.iata_code || '') +
    (firstOutboundSegment?.marketing_carrier_flight_number || '');

  const departureAirport = firstOutboundSegment?.origin?.iata_code || '';
  const arrivalAirport = lastOutboundSegment?.destination?.iata_code || '';
  const departureTime = firstOutboundSegment?.departing_at || '';
  const arrivalTime = lastOutboundSegment?.arriving_at || '';
  const outboundDuration = parseISO8601Duration(outboundSlice.duration);
  const outboundStops = outboundSegments.length - 1;

  const fareClass = capitalize(firstOutboundSegment?.passengers?.[0]?.cabin_class) || null;
  const baggageAllowance = mapBaggageAllowance(firstOutboundSegment?.passengers?.[0]?.baggages);

  const segments: FlightSegment[] = outboundSegments.map(mapSegment);
  const returnSlice = offer.slices.length > 1 ? offer.slices[1] : null;
  const returnSegments: FlightSegment[] | null = returnSlice
    ? returnSlice.segments!.map(mapSegment)
    : null;

  const conditions: FlightOfferConditions = {
    refundable: Boolean(offer.conditions?.refund_before_departure?.allowed),
    changeable: Boolean(offer.conditions?.change_before_departure?.allowed),
    changeBeforeDeparture: offer.conditions?.change_before_departure
      ? {
          allowed: Boolean(offer.conditions.change_before_departure.allowed),
          penaltyAmount: offer.conditions.change_before_departure.penalty_amount ?? null,
          penaltyCurrency: offer.conditions.change_before_departure.penalty_currency ?? null,
        }
      : null,
  };

  const matchInput: FlightMatchInput = {
    id,
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
  };

  const flightOffer: FlightOffer = {
    id,
    supplierOfferId: offer.id,
    totalAmount: offer.total_amount,
    price,
    currency: offer.total_currency,
    offerExpiresAt: offer.expires_at ?? null,
    passengers,
    airline,
    flightNumber,
    departureAirport,
    arrivalAirport,
    departureTime,
    arrivalTime,
    duration: outboundDuration,
    stops: outboundStops,
    fareClass,
    baggageAllowance,
    segments,
    returnSegments,
    conditions,
    matchInput,
    rawSupplierPayload: rawOffer,
  };

  return { success: true, offer: flightOffer };
}

/**
 * Normalizes a live Duffel offer into a neutral FlightOffer domain model.
 */
export function normalizeDuffelOffer(
  rawOffer: unknown,
  originalIndex = 0,
): FlightOffer | null {
  const result = validateAndNormalizeDuffelOffer(rawOffer, originalIndex);
  return result.success ? result.offer : null;
}

/**
 * Decodes a legacy stored JSON snapshot into a neutral FlightOffer domain model.
 * Enforces fail-closed behavior, returning null for malformed or invalid inputs.
 */
export function normalizeStoredOffer(rawOffer: unknown): FlightOffer | null {
  return normalizeDuffelOffer(rawOffer, 0);
}

/**
 * Normalizes a batch of raw Duffel offers with canonical ordering, originalIndex preservation,
 * and mixed currency rejection.
 */
export function normalizeFlightOffers(
  rawOffers: readonly unknown[],
): NormalizationResult {
  const normalizedOffers: FlightOffer[] = [];
  const rejectionCounts: Record<string, number> = {};
  let droppedCount = 0;
  let lockedCurrency: string | null = null;

  for (let i = 0; i < rawOffers.length; i++) {
    const rawOffer = rawOffers[i];
    const validationResult = validateAndNormalizeDuffelOffer(rawOffer, i);

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
