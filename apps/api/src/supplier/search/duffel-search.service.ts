import * as crypto from 'crypto';
import { Injectable, Optional, HttpException, HttpStatus } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import { DuffelRateBudgetService } from '../core/duffel-rate-budget.service';
import { DuffelSearchAdapter } from './duffel-search.adapter';
import { FlightOfferNormalizer } from './flight-offer.normalizer';
import { DuffelOffer } from '@/duffel/duffel.types';
import {
  FlightOffer,
  FlightSearchCriteria,
  FlightSearchPort,
  FlightSearchResult,
} from './flight-search.port';

@Injectable()
export class DuffelSearchService implements FlightSearchPort {
  private readonly normalizerInstance: FlightOfferNormalizer;

  constructor(
    @Optional() private readonly cacheService?: CacheService,
    @Optional() private readonly rateBudgetService?: DuffelRateBudgetService,
    @Optional() private readonly searchAdapter?: DuffelSearchAdapter,
    @Optional() private readonly normalizer?: FlightOfferNormalizer,
  ) {
    // Injected via SupplierSearchModule. Fallback to new instance allows legacy/unit tests to construct without DI.
    this.normalizerInstance = normalizer ?? new FlightOfferNormalizer();
  }

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
      const raw = rawOffers[i];
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      // Safe cast: raw offer from Duffel search response conforms to partial DuffelOffer structure
      const normalizedOffer = this.normalizerInstance.normalizeOffer(
        raw as unknown as DuffelOffer,
        criteria.cabinClass,
        i,
      );
      if (normalizedOffer) {
        offers.push(normalizedOffer);
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
    try {
      // Safe cast: raw offer from Duffel live lookup conforms to DuffelOffer structure
      const offer = this.normalizerInstance.normalizeOffer(rawOffer as unknown as DuffelOffer);
      if (!offer || !offer.id) {
        throw new Error('Invalid normalized offer structure');
      }
      return offer;
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        {
          code: 'UPSTREAM_UNAVAILABLE',
          message: `Failed to normalize offer: ${supplierOfferId}`,
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  normalizeStoredOffer(rawOffer: unknown): FlightOffer | null {
    return this.normalizerInstance.normalizeStoredOffer(rawOffer);
  }
}
