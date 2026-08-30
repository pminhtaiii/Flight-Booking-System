import { FlightSegmentSnapshot } from '@shared/booking-types';
import { DuffelOrder, DuffelPlace } from '../../duffel/duffel.types';

export interface NormalizedSegment {
  sliceOrder: number;
  segmentOrder: number;
  globalOrder: number;
  duffelSegmentId: string | null;
  marketingCarrierIata: string;
  operatingCarrierIata: string | null;
  airlineName: string;
  flightNumber: string;
  departureAirportIata: string;
  departureAirportName: string;
  departureCity: string;
  departureTerminal: string | null;
  departureAt: string;
  departureLocalDate: string;
  arrivalAirportIata: string;
  arrivalAirportName: string;
  arrivalCity: string;
  arrivalTerminal: string | null;
  arrivalAt: string;
  arrivalLocalDate: string;
  durationMinutes: number;
  aircraftType: string | null;
}

function parseIsoDurationToMinutes(durationStr: string | null | undefined): number {
  if (!durationStr || typeof durationStr !== 'string') return 0;
  const matches = durationStr.match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/);
  if (!matches) return 0;
  const days = parseInt(matches[1] || '0', 10);
  const hours = parseInt(matches[2] || '0', 10);
  const minutes = parseInt(matches[3] || '0', 10);
  return days * 24 * 60 + hours * 60 + minutes;
}

function extractLocalDate(dateTimeStr: string): string {
  if (!dateTimeStr) return '';
  return dateTimeStr.split('T')[0];
}

export function normalizeDuffelOrder(order: DuffelOrder): NormalizedSegment[] {
  const result: NormalizedSegment[] = [];
  if (!order || !order.slices || !Array.isArray(order.slices)) {
    return result;
  }
  let globalOrder = 0;
  for (let sliceOrder = 0; sliceOrder < order.slices.length; sliceOrder++) {
    const slice = order.slices[sliceOrder];
    if (!slice || !slice.segments || !Array.isArray(slice.segments)) {
      continue;
    }
    for (let segmentOrder = 0; segmentOrder < slice.segments.length; segmentOrder++) {
      const seg = slice.segments[segmentOrder];
      if (!seg) continue;

      const operatingIata =
        seg.operating_carrier?.iata_code || seg.marketing_carrier?.iata_code || 'XX';
      const marketingIata = seg.marketing_carrier?.iata_code || 'XX';
      const airlineName = seg.operating_carrier?.name || seg.marketing_carrier?.name || 'Unknown';
      const flightNum = seg.marketing_carrier_flight_number || '0000';

      const origin = seg.origin as DuffelPlace & { city_name?: string; city?: { name?: string } };
      const destination = seg.destination as DuffelPlace & {
        city_name?: string;
        city?: { name?: string };
      };

      result.push({
        sliceOrder,
        segmentOrder,
        globalOrder: globalOrder++,
        duffelSegmentId: seg.id || null,
        marketingCarrierIata: marketingIata,
        operatingCarrierIata: operatingIata,
        airlineName,
        flightNumber: flightNum,
        departureAirportIata: seg.origin?.iata_code || '',
        departureAirportName: seg.origin?.name || '',
        departureCity: origin?.city_name || origin?.city?.name || origin?.name || '',
        departureTerminal: seg.origin_terminal || null,
        departureAt: seg.departing_at,
        departureLocalDate: extractLocalDate(seg.departing_at),
        arrivalAirportIata: seg.destination?.iata_code || '',
        arrivalAirportName: seg.destination?.name || '',
        arrivalCity: destination?.city_name || destination?.city?.name || destination?.name || '',
        arrivalTerminal: seg.destination_terminal || null,
        arrivalAt: seg.arriving_at,
        arrivalLocalDate: extractLocalDate(seg.arriving_at),
        durationMinutes: parseIsoDurationToMinutes(seg.duration),
        aircraftType: seg.aircraft?.name || null,
      });
    }
  }
  return result;
}

export function normalizeFlightSegments(segments: FlightSegmentSnapshot[]): NormalizedSegment[] {
  if (!segments || !Array.isArray(segments)) {
    return [];
  }
  return segments.map((seg, index) => {
    const sliceOrder = seg.sliceOrder ?? 0;
    const segmentOrder = seg.segmentOrder ?? index;
    const globalOrder = seg.globalOrder ?? index;

    return {
      sliceOrder,
      segmentOrder,
      globalOrder,
      duffelSegmentId: seg.duffelSegmentId || null,
      marketingCarrierIata: seg.airline.iataCode,
      operatingCarrierIata: seg.airline.iataCode,
      airlineName: seg.airline.name,
      flightNumber: seg.flightNumber,
      departureAirportIata: seg.departureAirport.iataCode,
      departureAirportName: seg.departureAirport.name,
      departureCity: seg.departureAirport.city,
      departureTerminal: seg.departureAirport.terminal || null,
      departureAt: seg.departureAt,
      departureLocalDate: extractLocalDate(seg.departureAt),
      arrivalAirportIata: seg.arrivalAirport.iataCode,
      arrivalAirportName: seg.arrivalAirport.name,
      arrivalCity: seg.arrivalAirport.city,
      arrivalTerminal: seg.arrivalAirport.terminal || null,
      arrivalAt: seg.arrivalAt,
      arrivalLocalDate: extractLocalDate(seg.arrivalAt),
      durationMinutes: parseIsoDurationToMinutes(seg.duration),
      aircraftType: seg.aircraftType || null,
    };
  });
}
