import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import { Duffel } from '@duffel/api';
import { DuffelOfferRequest } from './duffel.types';
import * as crypto from 'crypto';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';

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
  private readonly duffelToken: string;
  private readonly apiVersion = 'v2';
  private readonly basePath = 'https://api.duffel.com';

  constructor(private readonly cacheService: CacheService) {
    const token = process.env.DUFFEL_ACCESS_TOKEN;
    const isJest = process.env.JEST_WORKER_ID !== undefined;
    const isTestEnv = process.env.NODE_ENV === 'test' || isJest;

    if (!isTestEnv && (!token || token === '' || token === 'mock')) {
      this.logger.warn('DUFFEL_ACCESS_TOKEN is missing or invalid in production/development runtime.');
    }

    this.duffelToken = token || '';
    this.duffel = new Duffel({
      token: this.duffelToken,
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

  async createOrder(
    duffelOfferId: string,
    passengers: {
      type: string;
      gender?: string;
      title?: string;
      dateOfBirth?: string | Date;
      givenName?: string;
      given_name?: string;
      familyName?: string;
      family_name?: string;
      phoneNumber?: string;
      phone_number?: string;
      email?: string;
    }[],
    metadata?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown> {
    try {
      const rawOffer = await this.getOfferById(duffelOfferId);
      const offer = rawOffer as {
        passengers: Array<{
          id: string;
          type: string;
        }>;
      };

      if (!offer || !offer.passengers) {
        throw new HttpException(
          'Duffel offer or passenger list not found.',
          HttpStatus.NOT_FOUND,
        );
      }

      const mapType = (t: string) => {
        const normalized = t.toLowerCase();
        if (normalized === 'adult') return 'adult';
        if (normalized === 'child') return 'child';
        if (normalized === 'infant') return 'infant_without_seat';
        return normalized;
      };

      const offerPassengersByType: Record<string, Array<{ id: string; type: string }>> = {};
      for (const p of offer.passengers) {
        const t = p.type;
        if (!offerPassengersByType[t]) {
          offerPassengersByType[t] = [];
        }
        offerPassengersByType[t].push(p);
      }

      const typeCounters: Record<string, number> = {};
      const duffelPassengers = passengers.map((p) => {
        const duffelType = mapType(p.type);
        if (!typeCounters[duffelType]) {
          typeCounters[duffelType] = 0;
        }
        const matchedOfferPassenger = offerPassengersByType[duffelType]?.[typeCounters[duffelType]];
        if (!matchedOfferPassenger) {
          throw new HttpException(
            `Could not match passenger of type ${p.type} at index ${typeCounters[duffelType]} with offer passengers`,
            HttpStatus.BAD_REQUEST,
          );
        }
        typeCounters[duffelType]++;

        const givenName = p.givenName || p.given_name;
        const familyName = p.familyName || p.family_name;

        if (!givenName) {
          throw new HttpException(
            'Given name is required for passenger.',
            HttpStatus.BAD_REQUEST,
          );
        }

        if (!familyName) {
          throw new HttpException(
            'Family name is required for passenger.',
            HttpStatus.BAD_REQUEST,
          );
        }

        let gender: 'm' | 'f' | 'u' = 'u';
        if (p.gender) {
          const firstChar = p.gender.trim().toLowerCase()[0];
          if (firstChar === 'm') gender = 'm';
          else if (firstChar === 'f') gender = 'f';
        }

        let title = p.title;
        if (!title) {
          title = gender === 'm' ? 'mr' : gender === 'f' ? 'ms' : 'mr';
        } else {
          title = title.toLowerCase().trim();
        }

        let born_on = '';
        if (p.dateOfBirth) {
          if (p.dateOfBirth instanceof Date) {
            born_on = p.dateOfBirth.toISOString().split('T')[0];
          } else if (typeof p.dateOfBirth === 'string') {
            born_on = p.dateOfBirth.split('T')[0];
          }
        }
        const phone_number = p.phoneNumber || p.phone_number;
        const email = p.email;

        if (!born_on) {
          throw new HttpException(
            `Date of birth is required for passenger ${givenName} ${familyName}`,
            HttpStatus.BAD_REQUEST,
          );
        }

        if (!phone_number) {
          throw new HttpException(
            `Phone number is required for passenger ${givenName} ${familyName}`,
            HttpStatus.BAD_REQUEST,
          );
        }

        if (!email) {
          throw new HttpException(
            `Email address is required for passenger ${givenName} ${familyName}`,
            HttpStatus.BAD_REQUEST,
          );
        }

        return {
          id: matchedOfferPassenger.id,
          given_name: givenName,
          family_name: familyName,
          born_on,
          gender,
          title,
          phone_number,
          email,
        };
      });

      const timeoutMs = 30000;
      const timeoutError = new HttpException(
        'Duffel order creation timed out.',
        HttpStatus.GATEWAY_TIMEOUT,
      );
      let timeoutHandle: NodeJS.Timeout | undefined;
      const controller = new AbortController();

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(timeoutError);
        }, timeoutMs);
      });

      try {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const token = this.duffelToken;
        const apiVersion = this.apiVersion;
        const basePath = this.basePath;
        const key = idempotencyKey || crypto.randomUUID();

        const orderPromise = (async () => {
          const res = await fetch(`${basePath}/air/orders`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Authorization': `Bearer ${token}`,
              'Duffel-Version': apiVersion,
              'Content-Type': 'application/json',
              'Idempotency-Key': `${key}-duffel-order`,
            },
            body: JSON.stringify({
              data: {
                type: 'instant',
                selected_offers: [duffelOfferId],
                passengers: duffelPassengers,
                metadata,
              },
            }),
          });

          const body = await res.json() as any;
          if (!res.ok || (body && body.errors)) {
            const err = new Error(body?.errors?.[0]?.message || 'Failed to create Duffel order');
            (err as any).status = res.status;
            throw err;
          }
          return body.data;
        })();

        orderPromise.catch(() => {});

        const result = await Promise.race([orderPromise, timeoutPromise]);
        return result;
        /* eslint-enable @typescript-eslint/no-explicit-any */
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    } catch (err: unknown) {
      const error = err as Error & { status?: number };
      this.logger.error(`Error in createOrder: ${error.message}`, error.stack);
      if (err instanceof HttpException) {
        throw err;
      }
      if (error.status === 429) {
        throw new HttpException(
          {
            code: 'UPSTREAM_RATE_LIMITED',
            message: 'Duffel API rate limit exceeded',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new HttpException(
        {
          code: 'UPSTREAM_UNAVAILABLE',
          message: error.message || 'Failed to create Duffel order',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async createCancellationQuote(duffelOrderId: string): Promise<any> {
    try {
      const isJest = process.env.JEST_WORKER_ID !== undefined;
      const isTestEnv = process.env.NODE_ENV === 'test' || isJest;
      const token = process.env.DUFFEL_ACCESS_TOKEN;

      if (isTestEnv || token === 'mock' || !token) {
        this.logger.log(`Mocking Duffel cancellation quote for test environment. OrderId: ${duffelOrderId}`);
        return {
          id: `oc_mock_${duffelOrderId}`,
          order_id: duffelOrderId,
          refund_amount: '100.00',
          refund_currency: 'GBP',
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          refundable: true,
        };
      }

      const quote = await this.duffel.orderCancellations.create({
        order_id: duffelOrderId,
      });
      return quote.data;
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`Failed to create cancellation quote for Duffel order ${duffelOrderId}: ${error.message}`, error.stack);
      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        {
          code: 'UPSTREAM_CANCELLATION_QUOTE_FAILED',
          message: error.message || 'Failed to create cancellation quote',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async cancelOrder(duffelOrderId: string): Promise<unknown> {
    try {
      const quote = await this.duffel.orderCancellations.create({
        order_id: duffelOrderId,
      });
      const confirmed = await this.duffel.orderCancellations.confirm(quote.data.id);
      return confirmed.data;
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`Failed to cancel Duffel order ${duffelOrderId}: ${error.message}`, error.stack);
      throw new HttpException(
        {
          code: 'UPSTREAM_CANCEL_FAILED',
          message: error.message || 'Failed to cancel Duffel order',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private parseIsoDurationToMinutes(durationStr: string): number {
    if (!durationStr || typeof durationStr !== 'string') return 0;
    const matches = durationStr.match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/);
    if (!matches) return 0;
    const days = parseInt(matches[1] || '0', 10);
    const hours = parseInt(matches[2] || '0', 10);
    const minutes = parseInt(matches[3] || '0', 10);
    return days * 24 * 60 + hours * 60 + minutes;
  }

  private formatMinutesToIsoDuration(totalMinutes: number): string {
    if (totalMinutes <= 0) return 'PT0H';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    let result = 'PT';
    if (hours > 0) result += `${hours}H`;
    if (minutes > 0) result += `${minutes}M`;
    return result;
  }

  mapDuffelOrderToSnapshots(duffelOrder: any): { flightSnapshot: FlightSnapshot; passengerSnapshot: PassengerSnapshot } {
    let totalDuration = 'PT0H';
    let stops = 0;
    let cabinClass = 'economy';
    const segments: any[] = [];
    
    if (duffelOrder.slices && Array.isArray(duffelOrder.slices)) {
      let totalMinutes = 0;
      for (const slice of duffelOrder.slices) {
        if (slice?.duration) {
          totalMinutes += this.parseIsoDurationToMinutes(slice.duration);
        }
        if (slice.segments && Array.isArray(slice.segments)) {
          stops += Math.max(0, slice.segments.length - 1);
          for (const seg of slice.segments) {
             cabinClass = seg.passengers?.[0]?.cabin_class || cabinClass;
             segments.push({
               airline: {
                 name: seg.operating_carrier?.name || seg.marketing_carrier?.name || 'Unknown',
                 iataCode: seg.operating_carrier?.iata_code || seg.marketing_carrier?.iata_code || 'XX',
               },
               flightNumber: seg.marketing_carrier_flight_number || '0000',
               departureAirport: {
                 iataCode: seg.origin?.iata_code || '',
                 name: seg.origin?.name || '',
                 city: seg.origin?.city_name || seg.origin?.city?.name || seg.origin?.name || '',
                 terminal: seg.origin_terminal,
               },
               arrivalAirport: {
                 iataCode: seg.destination?.iata_code || '',
                 name: seg.destination?.name || '',
                 city: seg.destination?.city_name || seg.destination?.city?.name || seg.destination?.name || '',
                 terminal: seg.destination_terminal,
               },
               departureAt: seg.departing_at,
               arrivalAt: seg.arriving_at,
               duration: seg.duration,
               aircraftType: seg.aircraft?.name,
             });
          }
        }
      }
      totalDuration = this.formatMinutesToIsoDuration(totalMinutes);
    }

    const flightSnapshot: FlightSnapshot = {
      segments,
      totalDuration,
      stops,
      cabinClass,
    };

    const passengers = [];
    if (duffelOrder.passengers && Array.isArray(duffelOrder.passengers)) {
      for (const p of duffelOrder.passengers) {
        passengers.push({
          type: (p.type === 'infant_without_seat' ? 'infant' : p.type || 'adult') as any,
          title: p.title,
          firstName: p.given_name || 'Unknown',
          lastName: p.family_name || 'Unknown',
          dateOfBirth: p.born_on,
        });
      }
    }
    
    const firstPassenger = duffelOrder.passengers?.[0];
    const passengerSnapshot: PassengerSnapshot = {
      passengers,
      contactEmail: firstPassenger?.email || null,
      contactPhone: firstPassenger?.phone_number || null,
    };

    return { flightSnapshot, passengerSnapshot };
  }
}
