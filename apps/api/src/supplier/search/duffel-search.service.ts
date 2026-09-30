import * as crypto from 'crypto';
import {
  Injectable,
  HttpException,
  HttpStatus,
  NotFoundException,
  GoneException,
} from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import { DuffelRateBudgetService } from '../core/duffel-rate-budget.service';
import { DuffelSearchAdapter } from './duffel-search.adapter';
import {
  FlightOffer,
  FlightSearchCriteria,
  FlightSearchPort,
  FlightSearchResult,
} from './flight-search.port';
import {
  normalizeDuffelOffer,
  normalizeFlightOffers,
  normalizeStoredOffer,
} from './flight-offer.normalizer';

@Injectable()
export class DuffelSearchService implements FlightSearchPort {
  constructor(
    private readonly cacheService: CacheService,
    private readonly rateBudgetService: DuffelRateBudgetService,
    private readonly searchAdapter: DuffelSearchAdapter,
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

  async search(
    criteria: FlightSearchCriteria,
    caller: 'user' | 'agent',
  ): Promise<FlightSearchResult> {
    const searchHash = this.computeSearchHash(criteria);
    const cacheKey = `flight:search:${searchHash}`;

    // 1. Cache hit check: ZERO upstream adapter calls and ZERO budget reservations
    const cachedStr = await this.cacheService.get(cacheKey);
    if (cachedStr) {
      const cachedResult = JSON.parse(cachedStr) as FlightSearchResult;
      return {
        ...cachedResult,
        cached: true,
        searchHash,
      };
    }

    // 2. Budget reservation: reserve daily caller sub-allocation
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    const limit = caller === 'agent' ? 500 : 1000;
    const budgetOutcome = await this.rateBudgetService.reserveAttempt({
      key: `budget:duffel:daily:${caller}:${dateStr}`,
      limit,
    });

    if (!budgetOutcome.ok) {
      if (budgetOutcome.error === 'EXHAUSTED') {
        throw new HttpException(
          {
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfterSeconds: budgetOutcome.retryAfterSeconds,
            resetAt: budgetOutcome.resetAt,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new HttpException(
        {
          code: 'BUDGET_UNAVAILABLE',
          retryAfterSeconds: budgetOutcome.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 3. Map criteria to Duffel query format
    const slices = [
      {
        origin: criteria.origin.trim().toUpperCase(),
        destination: criteria.destination.trim().toUpperCase(),
        departure_date: criteria.departureDate,
        arrival_time: null,
        departure_time: null,
      },
    ];

    if (criteria.returnDate) {
      slices.push({
        origin: criteria.destination.trim().toUpperCase(),
        destination: criteria.origin.trim().toUpperCase(),
        departure_date: criteria.returnDate,
        arrival_time: null,
        departure_time: null,
      });
    }

    const passengers: Array<{ type: 'adult' | 'child' | 'infant_without_seat' }> = [];
    const adults = Number(criteria.adults);
    const children = Number(criteria.children || 0);
    const infants = Number(criteria.infants || 0);

    for (let i = 0; i < adults; i++) {
      passengers.push({ type: 'adult' });
    }
    for (let i = 0; i < children; i++) {
      passengers.push({ type: 'child' });
    }
    for (let i = 0; i < infants; i++) {
      passengers.push({ type: 'infant_without_seat' });
    }

    const query = {
      slices,
      passengers,
      cabin_class: criteria.cabinClass || 'economy',
    };

    // 4. Call search adapter
    const adapterResponse = (await this.searchAdapter.searchOffers(query)) as
      | { offers?: unknown[] }
      | unknown[]
      | null;

    const rawOffers = Array.isArray(adapterResponse)
      ? adapterResponse
      : Array.isArray(adapterResponse?.offers)
        ? adapterResponse.offers
        : [];

    // 5. Normalize offers
    const { normalizedOffers } = normalizeFlightOffers(rawOffers);

    const result: FlightSearchResult = {
      offers: normalizedOffers,
      searchHash,
      cached: false,
    };

    // 6. Cache search result
    await this.cacheService.set(cacheKey, JSON.stringify(result), 900);

    return result;
  }

  async getOfferById(
    supplierOfferId: string,
    timeoutMs?: number,
  ): Promise<FlightOffer> {
    let rawOffer: unknown;
    try {
      rawOffer = await this.searchAdapter.getOffer(supplierOfferId, timeoutMs);
    } catch (error: unknown) {
      if (error instanceof NotFoundException || error instanceof GoneException) {
        throw error;
      }
      const status =
        (error as { status?: number; getStatus?: () => number })?.getStatus?.() ??
        (error as { status?: number })?.status;
      if (status === 404) {
        throw new NotFoundException(`Duffel offer ${supplierOfferId} was not found`);
      }
      if (status === 410) {
        throw new GoneException(`Duffel offer ${supplierOfferId} has expired`);
      }
      throw error;
    }

    const offer = normalizeDuffelOffer(rawOffer, 0);
    if (!offer) {
      throw new NotFoundException(`Duffel offer ${supplierOfferId} could not be normalized`);
    }

    return offer;
  }

  normalizeStoredOffer(rawOffer: unknown): FlightOffer | null {
    return normalizeStoredOffer(rawOffer);
  }
}
