import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import { Duffel } from '@duffel/api';
import { DuffelOfferRequest } from './duffel.types';
import * as crypto from 'crypto';

export class DuffelTimeoutError extends Error {
  readonly code = 'DUFFEL_TIMEOUT';
  constructor(message = 'Duffel offer lookup timed out.') {
    super(message);
    this.name = 'DuffelTimeoutError';
    Object.setPrototypeOf(this, DuffelTimeoutError.prototype);
  }
}

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

  mapPassengersToDuffel(adults: number, children = 0, infants = 0): Array<{ type: 'adult' | 'child' | 'infant_without_seat' }> {
    const passengers: Array<{ type: 'adult' | 'child' | 'infant_without_seat' }> = [];
    for (let i = 0; i < adults; i++) {
      passengers.push({ type: 'adult' });
    }
    for (let i = 0; i < children; i++) {
      passengers.push({ type: 'child' });
    }
    for (let i = 0; i < infants; i++) {
      passengers.push({ type: 'infant_without_seat' });
    }
    return passengers;
  }

  async searchFlights(
    query: {
      origin: string;
      destination: string;
      departureDate: string;
      returnDate?: string;
      adults: number;
      children?: number;
      infants?: number;
      cabinClass?: string;
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
        adults: Number(query.adults),
        children: Number(query.children || 0),
        infants: Number(query.infants || 0),
        cabinClass: query.cabinClass || 'economy',
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
        
        const mockPassengers: Array<{ id: string; type: 'adult' | 'child' | 'infant_without_seat' }> = [];
        for (let i = 0; i < normalizedQuery.adults; i++) {
          mockPassengers.push({ id: `pas_mock_${mockPassengers.length + 1}`, type: 'adult' });
        }
        for (let i = 0; i < normalizedQuery.children; i++) {
          mockPassengers.push({ id: `pas_mock_${mockPassengers.length + 1}`, type: 'child' });
        }
        for (let i = 0; i < normalizedQuery.infants; i++) {
          mockPassengers.push({ id: `pas_mock_${mockPassengers.length + 1}`, type: 'infant_without_seat' });
        }

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
                passengers: mockPassengers.map((p) => ({
                  passenger_id: p.id,
                  cabin_class: normalizedQuery.cabinClass,
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
                passengers: mockPassengers.map((p) => ({
                  passenger_id: p.id,
                  cabin_class: normalizedQuery.cabinClass,
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
            passengers: mockPassengers,
            passenger_identity_documents_required: false
          }
        ];

        const offerRequest = {
          id: 'or_mock_123',
          slices,
          passengers: mockPassengers,
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

      const passengers = this.mapPassengersToDuffel(
        normalizedQuery.adults,
        normalizedQuery.children,
        normalizedQuery.infants,
      );

      this.logger.log(`Calling Duffel API to create offer request. Slices: ${slices.length}, Passengers: ${passengers.length}`);
      const duffelResponse = await this.duffel.offerRequests.create({
        slices,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        passengers: passengers as any,
        cabin_class: normalizedQuery.cabinClass as 'first' | 'business' | 'premium_economy' | 'economy',
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

  async getOfferById(duffelOfferId: string, timeoutMs = 4500): Promise<unknown> {
    const timeoutError = new DuffelTimeoutError();
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(timeoutError), timeoutMs);
    });

    try {
      const offerPromise = this.duffel.offers.get(duffelOfferId);
      const result = await Promise.race([offerPromise, timeoutPromise]);
      return (result as { data: unknown }).data;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async createOrder(params: {
    duffelOfferId: string;
    passengers: any[];
    userEmail: string;
    rawOfferSnapshot?: any;
  }): Promise<{ id: string; booking_reference: string }> {
    // Map database passengers to Duffel formats
    const duffelPassengers = params.passengers.map((p, idx) => {
      const dob = p.dateOfBirth instanceof Date
        ? p.dateOfBirth.toISOString().slice(0, 10)
        : String(p.dateOfBirth).slice(0, 10);

      const genderMap: Record<string, 'm' | 'f'> = {
        male: 'm',
        female: 'f',
        m: 'm',
        f: 'f',
      };
      const gender = genderMap[p.gender.toLowerCase()] || 'm';

      let passengerId = `pas_mock_${idx + 1}`;
      if (params.rawOfferSnapshot && typeof params.rawOfferSnapshot === 'object') {
        const snapshot = params.rawOfferSnapshot;
        const offerData = snapshot.data ? snapshot.data : snapshot;
        const duffelPassengersList = offerData.passengers;
        if (Array.isArray(duffelPassengersList) && duffelPassengersList[idx]) {
          passengerId = duffelPassengersList[idx].id;
        }
      }

      const dp: any = {
        id: passengerId,
        given_name: p.givenName,
        family_name: p.familyName,
        gender: gender,
        date_of_birth: dob,
      };

      if (p.passportNumber && p.passportExpiry && p.nationality) {
        dp.identity_documents = [
          {
            unique_identifier: p.passportNumber,
            expires_on: p.passportExpiry,
            issuing_country_code: p.nationality.toUpperCase(),
            type: 'passport',
          },
        ];
      }

      if (idx === 0) {
        dp.email = params.userEmail;
      }

      return dp;
    });

    try {
      this.logger.log(`Calling Duffel API to create order. Offer: ${params.duffelOfferId}`);
      const duffelResponse = await this.duffel.orders.create({
        selected_offers: [params.duffelOfferId],
        passengers: duffelPassengers,
        type: 'instant',
      });
      return {
        id: duffelResponse.data.id,
        booking_reference: duffelResponse.data.booking_reference,
      };
    } catch (err: any) {
      this.logger.error(`Error in Duffel createOrder: ${err.message}`, err.stack);
      throw err;
    }
  }
}
