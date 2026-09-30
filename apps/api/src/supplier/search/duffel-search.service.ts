import * as crypto from 'crypto';
import { Injectable, Optional, HttpException, HttpStatus } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import { DuffelRateBudgetService } from '../core/duffel-rate-budget.service';
import { DuffelSearchAdapter } from './duffel-search.adapter';
import {
  generateDeterministicUUID,
  parseISO8601Duration,
} from '@/flights/flight-offer-normalizer';
import {
  FlightOffer,
  FlightOfferPassenger,
  FlightSearchCriteria,
  FlightSearchPort,
  FlightSearchResult,
  FlightSegment,
} from './flight-search.port';

@Injectable()
export class DuffelSearchService implements FlightSearchPort {
  constructor(
    @Optional() private readonly cacheService?: CacheService,
    @Optional() private readonly rateBudgetService?: DuffelRateBudgetService,
    @Optional() private readonly searchAdapter?: DuffelSearchAdapter,
  ) {}

  private computeSearchHash(criteria: FlightSearchCriteria): string {
    const normalized = {
      origin: criteria.origin.trim().toUpperCase(),
      destination: criteria.destination.trim().toUpperCase(),
      departureDate: criteria.departureDate,
      returnDate: criteria.returnDate || null,
      adults: Number(criteria.adults),
      children: Number(criteria.children || 0),
      infants: Number(criteria.infants || 0),
      cabinClass: criteria.cabinClass || 'economy',
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  private mapPassengerType(type: unknown): FlightOfferPassenger['type'] {
    switch (type) {
      case 'adult':
        return 'ADULT';
      case 'child':
        return 'CHILD';
      case 'infant':
      case 'infant_without_seat':
        return 'INFANT';
      default:
        return 'ADULT';
    }
  }

  private mapRawSegment(rawSeg: any): FlightSegment {
    return {
      supplierSegmentId: rawSeg.id || null,
      carrierCode:
        rawSeg.marketing_carrier?.iata_code || rawSeg.operating_carrier?.iata_code || '',
      flightNumber: rawSeg.marketing_carrier_flight_number || '',
      operatingCarrier:
        rawSeg.operating_carrier?.name || rawSeg.marketing_carrier?.name || '',
      departureAirport: rawSeg.origin?.iata_code || '',
      departureTerminal: rawSeg.origin_terminal || null,
      departureTime: rawSeg.departing_at || '',
      arrivalAirport: rawSeg.destination?.iata_code || '',
      arrivalTerminal: rawSeg.destination_terminal || null,
      arrivalTime: rawSeg.arriving_at || '',
      duration: parseISO8601Duration(rawSeg.duration),
      aircraft: rawSeg.aircraft?.name || null,
      cabinClass: rawSeg.passengers?.[0]?.cabin_class || 'economy',
    };
  }

  private mapRawOfferToFlightOffer(
    rawOffer: any,
    originalIndex: number = 0,
  ): FlightOffer | null {
    if (!rawOffer || typeof rawOffer !== 'object') return null;
    if (!rawOffer.id || !Array.isArray(rawOffer.slices) || rawOffer.slices.length === 0) {
      return null;
    }

    const id = generateDeterministicUUID(rawOffer.id);
    const outboundSlice = rawOffer.slices[0];
    const returnSlice = rawOffer.slices[1] || null;

    if (!Array.isArray(outboundSlice.segments) || outboundSlice.segments.length === 0) {
      return null;
    }

    const segments: FlightSegment[] = outboundSlice.segments.map((s: any) =>
      this.mapRawSegment(s),
    );
    const returnSegments: FlightSegment[] | null = returnSlice?.segments
      ? returnSlice.segments.map((s: any) => this.mapRawSegment(s))
      : null;

    const firstOutbound = outboundSlice.segments[0];
    const lastOutbound = outboundSlice.segments[outboundSlice.segments.length - 1];

    const price = parseFloat(rawOffer.total_amount) || 0;
    const currency = rawOffer.total_currency || 'USD';
    const stops = outboundSlice.segments.length - 1;
    const duration = parseISO8601Duration(outboundSlice.duration);

    const outboundDepartureHour = firstOutbound?.departing_at
      ? parseInt(firstOutbound.departing_at.slice(11, 13), 10) || 0
      : 0;
    const outboundArrivalHour = lastOutbound?.arriving_at
      ? parseInt(lastOutbound.arriving_at.slice(11, 13), 10) || 0
      : 0;

    const carrierCodes = Array.from(
      new Set(
        segments
          .map((s) => s.carrierCode)
          .concat(returnSegments ? returnSegments.map((s) => s.carrierCode) : [])
          .filter(Boolean),
      ),
    );

    const hasCheckedBaggage = (firstOutbound?.passengers?.[0]?.baggages || []).some(
      (b: any) => b.type === 'checked' && Number(b.quantity) > 0,
    );

    const passengers: FlightOfferPassenger[] = Array.isArray(rawOffer.passengers)
      ? rawOffer.passengers.map((p: any) => ({
          supplierPassengerId: p.id,
          type: this.mapPassengerType(p.type),
        }))
      : [];

    return {
      id,
      supplierOfferId: rawOffer.id,
      totalAmount: rawOffer.total_amount || '0.00',
      price,
      currency,
      offerExpiresAt: rawOffer.expires_at || null,
      passengers,
      airline:
        firstOutbound.marketing_carrier?.name ||
        firstOutbound.operating_carrier?.name ||
        '',
      flightNumber: `${firstOutbound.marketing_carrier?.iata_code || ''}${firstOutbound.marketing_carrier_flight_number || ''}`,
      departureAirport: firstOutbound.origin?.iata_code || '',
      arrivalAirport: lastOutbound.destination?.iata_code || '',
      departureTime: firstOutbound.departing_at || '',
      arrivalTime: lastOutbound.arriving_at || '',
      duration,
      stops,
      fareClass: firstOutbound.passengers?.[0]?.cabin_class || 'Economy',
      baggageAllowance: hasCheckedBaggage ? '1 checked bag(s)' : null,
      segments,
      returnSegments,
      conditions: {
        refundable: rawOffer.conditions?.refund_before_departure?.allowed ?? false,
        changeable: rawOffer.conditions?.change_before_departure?.allowed ?? true,
        changeBeforeDeparture: rawOffer.conditions?.change_before_departure
          ? {
              allowed: Boolean(rawOffer.conditions.change_before_departure.allowed),
              penaltyAmount: rawOffer.conditions.change_before_departure.penalty_amount || null,
              penaltyCurrency:
                rawOffer.conditions.change_before_departure.penalty_currency || null,
            }
          : null,
      },
      matchInput: {
        id,
        price,
        currency,
        stops,
        duration,
        outboundDepartureHour,
        outboundArrivalHour,
        carrierCodes,
        cabinClass: segments[0]?.cabinClass || 'economy',
        hasCheckedBaggage,
        originalIndex,
      },
      rawSupplierPayload: rawOffer,
    };
  }

  async search(
    criteria: FlightSearchCriteria,
    caller: 'user' | 'agent',
  ): Promise<FlightSearchResult> {
    const searchHash = this.computeSearchHash(criteria);
    const cacheKey = `flight:search:${searchHash}`;

    if (this.cacheService) {
      const cachedData = await this.cacheService.get(cacheKey);
      if (cachedData) {
        const parsed = JSON.parse(cachedData) as FlightSearchResult;
        return {
          ...parsed,
          searchHash,
          cached: true,
        };
      }
    }

    if (!this.searchAdapter) {
      throw new Error('Search adapter unavailable');
    }

    if (this.rateBudgetService) {
      const today = new Date().toISOString().split('T')[0];
      const limit = caller === 'user' ? 1000 : 500;
      const key = `budget:duffel:daily:${caller}:${today}`;
      const reservation = await this.rateBudgetService.reserveAttempt({ key, limit });
      if (!reservation.ok) {
        if (reservation.error === 'EXHAUSTED') {
          throw new HttpException(
            {
              code: 'RATE_LIMIT_EXCEEDED',
              retryAfterSeconds: reservation.retryAfterSeconds,
              resetAt: reservation.resetAt,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        throw new HttpException(
          {
            code: 'BUDGET_UNAVAILABLE',
            retryAfterSeconds: reservation.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const adapterResponse = (await this.searchAdapter.searchOffers(criteria)) as
      | { offers?: unknown[] }
      | undefined;
    const rawOffers = adapterResponse?.offers || [];
    const offers: FlightOffer[] = [];

    for (let i = 0; i < rawOffers.length; i++) {
      const normalized = this.mapRawOfferToFlightOffer(rawOffers[i], i);
      if (normalized) {
        offers.push(normalized);
      }
    }

    const result: FlightSearchResult = {
      offers,
      searchHash,
      cached: false,
    };

    if (this.cacheService) {
      await this.cacheService.set(cacheKey, JSON.stringify(result), 900);
    }

    return result;
  }

  async getOfferById(
    supplierOfferId: string,
    timeoutMs?: number,
  ): Promise<FlightOffer> {
    if (!this.searchAdapter) {
      throw new Error('Search adapter unavailable');
    }
    const rawOffer = await this.searchAdapter.getOffer(supplierOfferId, timeoutMs);
    const offer = this.mapRawOfferToFlightOffer(rawOffer);
    if (!offer) {
      throw new Error(`Failed to normalize offer: ${supplierOfferId}`);
    }
    return offer;
  }

  normalizeStoredOffer(rawOffer: unknown): FlightOffer | null {
    if (!rawOffer || typeof rawOffer !== 'object') return null;
    const raw = rawOffer as Record<string, any>;
    if (!raw.id || !Array.isArray(raw.slices) || raw.slices.length === 0) {
      return null;
    }
    for (const slice of raw.slices) {
      if (!Array.isArray(slice.segments) || slice.segments.length === 0) {
        return null;
      }
    }
    return this.mapRawOfferToFlightOffer(rawOffer);
  }
}
