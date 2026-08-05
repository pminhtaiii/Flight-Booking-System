import { createHash } from 'crypto';
import { NormalizedSegment } from './itinerary-normalizer';

function serializeSegmentCanonical(seg: NormalizedSegment): string {
  const canonicalObj = {
    aircraftType: seg.aircraftType || null,
    arrivalAirportIata: seg.arrivalAirportIata,
    arrivalAt: seg.arrivalAt,
    arrivalTerminal: seg.arrivalTerminal || null,
    departureAirportIata: seg.departureAirportIata,
    departureAt: seg.departureAt,
    departureTerminal: seg.departureTerminal || null,
    durationMinutes: seg.durationMinutes,
    flightNumber: seg.flightNumber,
    globalOrder: seg.globalOrder,
    marketingCarrierIata: seg.marketingCarrierIata,
    operatingCarrierIata: seg.operatingCarrierIata || null,
    segmentOrder: seg.segmentOrder,
    sliceOrder: seg.sliceOrder,
  };
  return JSON.stringify(canonicalObj);
}

export function generateItineraryFingerprint(segments: NormalizedSegment[]): string {
  const canonicalStrings = segments.map(serializeSegmentCanonical);
  const serialized = JSON.stringify(canonicalStrings);
  const hash = createHash('sha256').update(serialized).digest('hex');
  return `v1_${hash}`;
}
