import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import { Duffel } from '@duffel/api';
import { DuffelOfferRequest } from './duffel.types';
import * as crypto from 'crypto';

@Injectable()
export class DuffelService {
  private readonly logger = new Logger(DuffelService.name);
  private readonly duffel: Duffel;

  constructor(private readonly cacheService: CacheService) {
    const token = process.env.DUFFEL_ACCESS_TOKEN;
    const isJest = process.env.JEST_WORKER_ID !== undefined;
    const isTestEnv = process.env.NODE_ENV === 'test' || isJest;

    if (!isTestEnv && (!token || token === '' || token === 'mock')) {
      this.logger.warn('DUFFEL_ACCESS_TOKEN is missing or invalid in production/development runtime.');
    }

    this.duffel = new Duffel({
      token: token || '',
    });
  }

  async searchFlights(
    query: {
      origin: string;
      destination: string;
      departureDate: string;
      returnDate?: string;
      passengers: number;
    },
    caller: 'user' | 'agent',
  ): Promise<{ offerRequest: DuffelOfferRequest; cached: boolean; searchHash: string }> {
    try {
      const isJest = process.env.JEST_WORKER_ID !== undefined;
      const isTestEnv = process.env.NODE_ENV === 'test' || isJest;
      const token = process.env.DUFFEL_ACCESS_TOKEN;

      // Fail fast in production/development runtime if token is missing
      if (!isTestEnv) {
        if (!token || token === '' || token === 'mock') {
          throw new HttpException(
            {
              message: 'Duffel Access Token is missing or invalid in production/development runtime.',
              code: 'CONFIGURATION_ERROR',
            },
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }
      }

      // 1. Build SHA-256 of normalized query parameters
      const normalizedQuery = {
        origin: query.origin.trim().toUpperCase(),
        destination: query.destination.trim().toUpperCase(),
        departureDate: query.departureDate,
        returnDate: query.returnDate || null,
        passengers: Number(query.passengers),
      };
      const queryStr = JSON.stringify(normalizedQuery);
      const sha256 = crypto.createHash('sha256').update(queryStr).digest('hex');
      const rawCacheKey = `flights:raw:${sha256}`;

      // 2. Check Redis cache key
      const cachedRaw = await this.cacheService.get(rawCacheKey);
      if (cachedRaw) {
        this.logger.log(`Raw flight search cache hit for hash: ${sha256}`);
        return {
          offerRequest: JSON.parse(cachedRaw) as DuffelOfferRequest,
          cached: true,
          searchHash: sha256,
        };
      }

      // 3. On cache miss: Check monthly budget limit in Redis
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const budgetKey = `budget:duffel:${year}-${month}`;

      const userLimit = Number(process.env.DUFFEL_BUDGET_LIMIT_USER || 1800);
      const agentLimit = Number(process.env.DUFFEL_BUDGET_LIMIT_AGENT || 1200);
      const totalLimit = Number(process.env.DUFFEL_BUDGET_LIMIT_TOTAL || 2000);
      const callerLimit = caller === 'user' ? userLimit : agentLimit;

      const currentBudgetStr = await this.cacheService.get(budgetKey);
      const currentBudget = currentBudgetStr ? parseInt(currentBudgetStr, 10) : 0;

      if (currentBudget >= callerLimit || currentBudget >= totalLimit) {
        this.logger.warn(`Duffel search throttled. Budget key: ${budgetKey}, Current: ${currentBudget}, Limits: (Caller: ${callerLimit}, Total: ${totalLimit})`);
        throw new HttpException(
          {
            message: 'Flight search capacity temporarily reached. Please try again later.',
            code: 'RATE_LIMIT_EXCEEDED',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // Calculate TTL to end of month
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      const ttlSeconds = Math.max(0, Math.ceil((endOfMonth.getTime() - Date.now()) / 1000));

      const newBudget = await this.cacheService.incr(budgetKey, ttlSeconds);
      if (newBudget > callerLimit || newBudget > totalLimit) {
        this.logger.warn(`Duffel search throttled after increment. Budget key: ${budgetKey}, New: ${newBudget}, Limits: (Caller: ${callerLimit}, Total: ${totalLimit})`);
        await this.cacheService.decr(budgetKey);
        throw new HttpException(
          {
            message: 'Flight search capacity temporarily reached. Please try again later.',
            code: 'RATE_LIMIT_EXCEEDED',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // 4. Create Duffel offer request
      if (!isJest && (process.env.NODE_ENV === 'test' || token === 'mock')) {
        this.logger.log(`Mocking Duffel API response for test environment. NODE_ENV: ${process.env.NODE_ENV}`);
        
        const slices: Record<string, unknown>[] = [
          {
            id: 'sli_mock_1',
            duration: 'PT2H10M',
            origin: { id: normalizedQuery.origin, name: `${normalizedQuery.origin} Airport`, iata_code: normalizedQuery.origin, type: 'airport' },
            destination: { id: normalizedQuery.destination, name: `${normalizedQuery.destination} Airport`, iata_code: normalizedQuery.destination, type: 'airport' },
            segments: [
              {
                id: 'seg_mock_1',
                duration: 'PT2H10M',
                departing_at: `${normalizedQuery.departureDate}T08:00:00`,
                arriving_at: `${normalizedQuery.departureDate}T10:10:00`,
                origin: { id: normalizedQuery.origin, name: `${normalizedQuery.origin} Airport`, iata_code: normalizedQuery.origin, type: 'airport' },
                destination: { id: normalizedQuery.destination, name: `${normalizedQuery.destination} Airport`, iata_code: normalizedQuery.destination, type: 'airport' },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '123',
                aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
                passengers: Array.from({ length: normalizedQuery.passengers }, (_, i) => ({
                  passenger_id: `pas_mock_${i + 1}`,
                  cabin_class: 'economy',
                  baggages: [
                    { type: 'checked', quantity: 1 }
                  ]
                }))
              }
            ]
          }
        ];

        if (normalizedQuery.returnDate) {
          slices.push({
            id: 'sli_mock_2',
            duration: 'PT2H10M',
            origin: { id: normalizedQuery.destination, name: `${normalizedQuery.destination} Airport`, iata_code: normalizedQuery.destination, type: 'airport' },
            destination: { id: normalizedQuery.origin, name: `${normalizedQuery.origin} Airport`, iata_code: normalizedQuery.origin, type: 'airport' },
            segments: [
              {
                id: 'seg_mock_2',
                duration: 'PT2H10M',
                departing_at: `${normalizedQuery.returnDate}T15:00:00`,
                arriving_at: `${normalizedQuery.returnDate}T17:10:00`,
                origin: { id: normalizedQuery.destination, name: `${normalizedQuery.destination} Airport`, iata_code: normalizedQuery.destination, type: 'airport' },
                destination: { id: normalizedQuery.origin, name: `${normalizedQuery.origin} Airport`, iata_code: normalizedQuery.origin, type: 'airport' },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '124',
                aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
                passengers: Array.from({ length: normalizedQuery.passengers }, (_, i) => ({
                  passenger_id: `pas_mock_${i + 1}`,
                  cabin_class: 'economy',
                  baggages: [
                    { type: 'checked', quantity: 1 }
                  ]
                }))
              }
            ]
          });
        }

        const offers = [
          {
            id: 'off_mock_123',
            total_amount: '125.50',
            total_currency: 'USD',
            slices: slices.map((s) => {
              const segments = (s.segments as Record<string, unknown>[] || []);
              return {
                ...s,
                segments: segments.map((seg) => ({
                  ...seg,
                  passengers: seg.passengers,
                })),
              };
            }),
            passengers: Array.from({ length: normalizedQuery.passengers }, (_, i) => ({
              id: `pas_mock_${i + 1}`,
              type: 'adult'
            })),
            passenger_identity_documents_required: false
          }
        ];

        const offerRequest = {
          id: 'or_mock_123',
          slices,
          passengers: Array.from({ length: normalizedQuery.passengers }, (_, i) => ({
            id: `pas_mock_${i + 1}`,
            type: 'adult'
          })),
          offers
        } as unknown as DuffelOfferRequest;

        // Cache raw response in Redis
        await this.cacheService.set(rawCacheKey, JSON.stringify(offerRequest), 900);

        return {
          offerRequest,
          cached: false,
          searchHash: sha256,
        };
      }

      const slices = [
        {
          origin: normalizedQuery.origin,
          destination: normalizedQuery.destination,
          departure_date: normalizedQuery.departureDate,
          arrival_time: null,
          departure_time: null,
        },
      ];
      if (normalizedQuery.returnDate) {
        slices.push({
          origin: normalizedQuery.destination,
          destination: normalizedQuery.origin,
          departure_date: normalizedQuery.returnDate,
          arrival_time: null,
          departure_time: null,
        });
      }

      const passengers = Array.from({ length: normalizedQuery.passengers }, () => ({
        type: 'adult' as const,
      }));

      this.logger.log(`Calling Duffel API to create offer request. Slices: ${slices.length}, Passengers: ${passengers.length}`);
      const duffelResponse = await this.duffel.offerRequests.create({
        slices,
        passengers,
        cabin_class: 'economy',
      });

      const offerRequest = duffelResponse.data as unknown as DuffelOfferRequest;

      // 5. Cache raw response in Redis
      await this.cacheService.set(rawCacheKey, JSON.stringify(offerRequest), 900);

      return {
        offerRequest,
        cached: false,
        searchHash: sha256,
      };
    } catch (err: unknown) {
      this.logger.error(`Error in searchFlights: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err.stack : undefined);
      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        {
          message: err instanceof Error ? err.message : 'Upstream flight search service is temporarily unavailable',
          code: 'UPSTREAM_UNAVAILABLE',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
