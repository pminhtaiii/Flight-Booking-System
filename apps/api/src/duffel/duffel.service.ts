import { Injectable, HttpException, HttpStatus, Logger, Optional, Inject } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import { DUFFEL_SDK, DuffelRateBudgetService } from '@/supplier/core/duffel-core.module';
import { mapDuffelOrderToSnapshots } from '@/supplier/order/order-snapshot.normalizer';
import { Duffel } from '@duffel/api';
import {
  DuffelOfferRequest,
  DuffelOrder,
  DuffelSeatMap,
  DuffelOfferWithServices,
  DuffelPricedOffer,
} from './duffel.types';
import * as crypto from 'crypto';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import {
  AncillaryCatalog,
  AncillarySegment,
  AncillarySeatMap,
  AncillaryRowElement,
  AncillarySeatService,
  AncillaryBaggageService,
  AncillaryRepriceOutput,
} from '@shared/types';

export type DuffelRecoveredOrder = {
  id: string;
  order_id: string;
  status: 'ACTIVE' | 'CANCELLED';
  cancelled_at: string | null;
  cancellation_id: string | null;
};

export type DuffelConfirmedCancellation = {
  id: string;
  order_id: string;
  status: 'PENDING' | 'CONFIRMED';
  refund_amount: string | null;
  refund_currency: string | null;
  refundable: boolean;
  confirmed_at: string | null;
};

export type DuffelCancellationQuote = {
  id: string;
  order_id: string;
  refund_amount?: string | null;
  total_refund_amount?: string | null;
  refund_currency?: string | null;
  currency?: string | null;
  expires_at?: string | null;
  expiresAt?: string | null;
  refundable?: boolean;
  refund_to?: string | null;
  non_refundable_ancillary_amount?: string | null;
  non_refundable_ancillary_currency?: string | null;
  [key: string]: unknown;
};

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
  private readonly duffelRateBudgetService: DuffelRateBudgetService;
  private readonly duffelToken: string;
  private readonly apiVersion = 'v2';
  private readonly basePath: string;

  constructor(
    private readonly cacheService: CacheService,
    @Optional() duffelRateBudgetService?: DuffelRateBudgetService,
    @Optional() @Inject(DUFFEL_SDK) injectedDuffel?: Duffel,
  ) {
    // Fallback stub for legacy unit tests that instantiate DuffelService directly with only CacheService
    this.duffelRateBudgetService =
      duffelRateBudgetService ??
      ({
        reserveAttempt: async () => ({ ok: true }),
      } as DuffelRateBudgetService);

    const token = process.env.DUFFEL_ACCESS_TOKEN;
    const isJest = process.env.JEST_WORKER_ID !== undefined;
    const isTestEnv = process.env.NODE_ENV === 'test' || isJest;

    if (!isTestEnv && (!token || token === '' || token === 'mock')) {
      this.logger.warn(
        'DUFFEL_ACCESS_TOKEN is missing or invalid in production/development runtime.',
      );
    }

    const rawApiUrl = process.env.DUFFEL_API_URL;
    if (rawApiUrl && rawApiUrl.trim() !== '') {
      const parsed = new URL(rawApiUrl.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(
          `Unsupported DUFFEL_API_URL protocol: ${parsed.protocol}. Only http: and https: are allowed.`,
        );
      }
      this.basePath = `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(
        /\/+$/,
        '',
      );
    } else {
      this.basePath = 'https://api.duffel.com';
    }

    this.duffelToken = token || '';
    this.duffel =
      injectedDuffel ??
      new Duffel({
        token: this.duffelToken,
        basePath: this.basePath,
      });
  }

  private async reserveBudgetAttempt(extraConstraint?: {
    key: string;
    limit: number;
  }): Promise<void> {
    const reservation = await this.duffelRateBudgetService.reserveAttempt(extraConstraint);
    if (!reservation.ok) {
      if (reservation.error === 'UNAVAILABLE') {
        throw new HttpException(
          {
            message: 'Duffel rate budget store temporarily unavailable',
            code: 'BUDGET_UNAVAILABLE',
            retryAfterSeconds: reservation.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new HttpException(
        {
          message: 'Daily Duffel API rate limit exceeded',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: reservation.retryAfterSeconds,
          resetAt: reservation.resetAt,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  mapPassengersToDuffel(
    adults: number,
    children = 0,
    infants = 0,
  ): Array<{ type: 'adult' | 'child' | 'infant_without_seat' }> {
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
              message:
                'Duffel Access Token is missing or invalid in production/development runtime.',
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

      // 3. On cache miss: Reserve daily budget via DuffelRateBudgetService
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(now.getUTCDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;

      const extraConstraint =
        caller === 'agent'
          ? { key: `budget:duffel:daily:agent:${dateStr}`, limit: 500 }
          : { key: `budget:duffel:daily:user:${dateStr}`, limit: 1000 };

      await this.reserveBudgetAttempt(extraConstraint);

      // 4. Create Duffel offer request
      const hasDuffelApiUrl = Boolean(
        process.env.DUFFEL_API_URL && process.env.DUFFEL_API_URL.trim() !== '',
      );
      if (!isJest && !hasDuffelApiUrl && (process.env.NODE_ENV === 'test' || token === 'mock')) {
        this.logger.log(
          `Mocking Duffel API response for test environment. NODE_ENV: ${process.env.NODE_ENV}`,
        );

        const mockPassengers: Array<{
          id: string;
          type: 'adult' | 'child' | 'infant_without_seat';
        }> = [];
        for (let i = 0; i < normalizedQuery.adults; i++) {
          mockPassengers.push({ id: `pas_mock_${mockPassengers.length + 1}`, type: 'adult' });
        }
        for (let i = 0; i < normalizedQuery.children; i++) {
          mockPassengers.push({ id: `pas_mock_${mockPassengers.length + 1}`, type: 'child' });
        }
        for (let i = 0; i < normalizedQuery.infants; i++) {
          mockPassengers.push({
            id: `pas_mock_${mockPassengers.length + 1}`,
            type: 'infant_without_seat',
          });
        }

        const slices: Record<string, unknown>[] = [
          {
            id: 'sli_mock_1',
            duration: 'PT2H10M',
            origin: {
              id: normalizedQuery.origin,
              name: `${normalizedQuery.origin} Airport`,
              iata_code: normalizedQuery.origin,
              type: 'airport',
            },
            destination: {
              id: normalizedQuery.destination,
              name: `${normalizedQuery.destination} Airport`,
              iata_code: normalizedQuery.destination,
              type: 'airport',
            },
            segments: [
              {
                id: 'seg_mock_1',
                duration: 'PT2H10M',
                departing_at: `${normalizedQuery.departureDate}T08:00:00`,
                arriving_at: `${normalizedQuery.departureDate}T10:10:00`,
                origin: {
                  id: normalizedQuery.origin,
                  name: `${normalizedQuery.origin} Airport`,
                  iata_code: normalizedQuery.origin,
                  type: 'airport',
                },
                destination: {
                  id: normalizedQuery.destination,
                  name: `${normalizedQuery.destination} Airport`,
                  iata_code: normalizedQuery.destination,
                  type: 'airport',
                },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '123',
                aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
                passengers: mockPassengers.map((p) => ({
                  passenger_id: p.id,
                  cabin_class: normalizedQuery.cabinClass,
                  baggages: [{ type: 'checked', quantity: 1 }],
                })),
              },
            ],
          },
        ];

        if (normalizedQuery.returnDate) {
          slices.push({
            id: 'sli_mock_2',
            duration: 'PT2H10M',
            origin: {
              id: normalizedQuery.destination,
              name: `${normalizedQuery.destination} Airport`,
              iata_code: normalizedQuery.destination,
              type: 'airport',
            },
            destination: {
              id: normalizedQuery.origin,
              name: `${normalizedQuery.origin} Airport`,
              iata_code: normalizedQuery.origin,
              type: 'airport',
            },
            segments: [
              {
                id: 'seg_mock_2',
                duration: 'PT2H10M',
                departing_at: `${normalizedQuery.returnDate}T15:00:00`,
                arriving_at: `${normalizedQuery.returnDate}T17:10:00`,
                origin: {
                  id: normalizedQuery.destination,
                  name: `${normalizedQuery.destination} Airport`,
                  iata_code: normalizedQuery.destination,
                  type: 'airport',
                },
                destination: {
                  id: normalizedQuery.origin,
                  name: `${normalizedQuery.origin} Airport`,
                  iata_code: normalizedQuery.origin,
                  type: 'airport',
                },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '124',
                aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
                passengers: mockPassengers.map((p) => ({
                  passenger_id: p.id,
                  cabin_class: normalizedQuery.cabinClass,
                  baggages: [{ type: 'checked', quantity: 1 }],
                })),
              },
            ],
          });
        }

        const offers = [
          {
            id: 'off_mock_123',
            total_amount: '125.50',
            total_currency: 'USD',
            slices: slices.map((s) => {
              const segments = (s.segments as Record<string, unknown>[]) || [];
              return {
                ...s,
                segments: segments.map((seg) => ({
                  ...seg,
                  passengers: seg.passengers,
                })),
              };
            }),
            passengers: mockPassengers,
            passenger_identity_documents_required: false,
          },
        ];

        const offerRequest = {
          id: 'or_mock_123',
          slices,
          passengers: mockPassengers,
          offers,
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

      this.logger.log(
        `Calling Duffel API to create offer request. Slices: ${slices.length}, Passengers: ${passengers.length}`,
      );
      const duffelResponse = await this.duffel.offerRequests.create({
        slices,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        passengers: passengers as any,
        cabin_class: normalizedQuery.cabinClass as
          | 'first'
          | 'business'
          | 'premium_economy'
          | 'economy',
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
      this.logger.error(
        `Error in searchFlights: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        {
          message:
            err instanceof Error
              ? err.message
              : 'Upstream flight search service is temporarily unavailable',
          code: 'UPSTREAM_UNAVAILABLE',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async getSeatMapsAndServices(offerId: string, forceRefresh = false): Promise<AncillaryCatalog> {
    const startTime = Date.now();
    const cacheKey = `seatmap:${offerId}`;

    if (!forceRefresh) {
      try {
        const ttl = await this.cacheService.getTtl(cacheKey);
        if (ttl > 3) {
          const cachedVal = await this.cacheService.get(cacheKey);
          if (cachedVal) {
            const catalog = JSON.parse(cachedVal) as AncillaryCatalog;
            catalog.cache = {
              status: 'HIT',
              ttlSeconds: ttl,
            };
            this.logger.log(`Ancillary catalog cache HIT for offer ${offerId} (TTL: ${ttl}s)`);
            return catalog;
          }
        } else {
          this.logger.log(`Ancillary catalog cache MISS/STALE for offer ${offerId} (TTL: ${ttl}s)`);
        }
      } catch (cacheErr: unknown) {
        this.logger.warn(
          `Failed to read cache for offer ${offerId}: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}. Falling back to supplier fetch.`,
        );
      }
    } else {
      this.logger.log(`Ancillary catalog force refresh requested for offer ${offerId}`);
    }

    const isJest = process.env.JEST_WORKER_ID !== undefined;
    const token = this.duffelToken;

    let catalog: AncillaryCatalog;

    if (!isJest && (process.env.NODE_ENV === 'test' || token === 'mock')) {
      this.logger.log(`Mocking Duffel Seatmaps/Services for test environment. Offer: ${offerId}`);
      catalog = {
        fetchedAt: new Date().toISOString(),
        cache: {
          status: 'MISS',
          ttlSeconds: 60,
        },
        segments: [
          {
            segmentId: 'seg_mock_1',
            origin: 'SGN',
            destination: 'SIN',
            seatMapAvailable: true,
            seatMap: {
              cabins: [
                {
                  cabinClass: 'economy',
                  rows: [
                    {
                      rowNumber: 1,
                      elements: [
                        {
                          type: 'seat',
                          designator: '1A',
                          availableServices: [
                            {
                              serviceId: 'ase_mock_seat_1',
                              passengerId: 'pas_mock_1',
                              amount: '15.00',
                              currency: 'USD',
                            },
                          ],
                          restricted: false,
                        },
                        {
                          type: 'aisle',
                        },
                        {
                          type: 'seat',
                          designator: '1B',
                          availableServices: [
                            {
                              serviceId: 'ase_mock_seat_2',
                              passengerId: 'pas_mock_1',
                              amount: '15.00',
                              currency: 'USD',
                            },
                          ],
                          restricted: false,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
        baggageServices: [
          {
            serviceId: 'ase_mock_bag_1',
            passengerId: 'pas_mock_1',
            segmentIds: ['seg_mock_1'],
            type: 'checked',
            weightValue: 23,
            weightUnit: 'kg',
            maxQuantity: 2,
            amount: '30.00',
            currency: 'USD',
          },
        ],
      };
    } else {
      const timeoutMs = 4500;
      const timeoutError = new DuffelTimeoutError();
      let timeoutHandle: NodeJS.Timeout | undefined;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(timeoutError), timeoutMs);
      });

      try {
        await this.reserveBudgetAttempt();
        await this.reserveBudgetAttempt();

        const seatMapsPromise = this.duffel.seatMaps
          .get({ offer_id: offerId })
          .catch((error: unknown) => {
            const status =
              error instanceof HttpException
                ? error.getStatus()
                : error && typeof error === 'object' && 'status' in error
                  ? error.status
                  : error && typeof error === 'object' && 'statusCode' in error
                    ? error.statusCode
                    : error &&
                        typeof error === 'object' &&
                        'meta' in error &&
                        error.meta &&
                        typeof error.meta === 'object' &&
                        'status' in error.meta
                      ? error.meta.status
                    : undefined;
            if (status === 404) return { data: [] };
            throw error;
          });
        const offerPromise = this.duffel.offers.get(offerId, { return_available_services: true });

        const [seatMapsRes, offerRes] = await Promise.race([
          Promise.all([seatMapsPromise, offerPromise]),
          timeoutPromise,
        ]);

        const rawSeatMaps = (seatMapsRes.data || []) as unknown as DuffelSeatMap[];
        const rawOffer = offerRes.data as unknown as DuffelOfferWithServices;

        const segments: AncillarySegment[] = [];
        if (rawOffer.slices) {
          for (const slice of rawOffer.slices) {
            if (slice.segments) {
              for (const segment of slice.segments) {
                const rawMap = rawSeatMaps.find((m) => m.segment_id === segment.id);
                segments.push({
                  segmentId: segment.id,
                  origin: segment.origin.iata_code,
                  destination: segment.destination.iata_code,
                  seatMapAvailable: !!rawMap,
                  seatMap: rawMap ? this.normalizeSeatMap(rawMap) : null,
                });
              }
            }
          }
        }

        const baggageServices: AncillaryBaggageService[] = [];
        if (rawOffer.available_services) {
          for (const service of rawOffer.available_services) {
            if (service.type === 'baggage') {
              if (
                !service.id ||
                !service.total_amount ||
                !service.total_currency ||
                !service.passenger_ids ||
                service.passenger_ids.length === 0 ||
                !service.segment_ids ||
                service.segment_ids.length === 0 ||
                !service.metadata ||
                !service.metadata.type
              ) {
                this.logger.warn(
                  `Quarantined incomplete baggage service: ${service.id || 'missing-id'}`,
                );
                continue;
              }

              for (const passengerId of service.passenger_ids) {
                baggageServices.push({
                  serviceId: service.id,
                  passengerId,
                  segmentIds: service.segment_ids,
                  type: service.metadata.type,
                  weightValue: service.metadata.weight ?? null,
                  weightUnit: service.metadata.weight_unit ?? null,
                  maxQuantity: service.metadata.maximum_quantity ?? 1,
                  amount: service.total_amount,
                  currency: service.total_currency,
                });
              }
            }
          }
        }

        catalog = {
          fetchedAt: new Date().toISOString(),
          cache: {
            status: 'MISS',
            ttlSeconds: 60,
          },
          segments,
          baggageServices,
        };

        const latency = Date.now() - startTime;
        this.logger.log(
          `Successfully fetched seatmaps/services for offer ${offerId} from supplier. Latency: ${latency}ms`,
        );
      } catch (err: unknown) {
        if (err instanceof DuffelTimeoutError) {
          this.logger.error(`Fetch timed out for offer ${offerId} (timeout: ${timeoutMs}ms)`);
          throw new HttpException(
            {
              code: 'UPSTREAM_UNAVAILABLE',
              message: 'Duffel seatmaps lookup timed out.',
            },
            HttpStatus.GATEWAY_TIMEOUT,
          );
        }

        if (err instanceof HttpException) {
          throw err;
        }

        const error = err as unknown as { message?: string; status?: number; stack?: string };
        this.logger.error(
          `Failed to fetch seatmaps/services for offer ${offerId}: ${error.message || String(error)}`,
          error.stack,
        );

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
            message: error.message || 'Failed to fetch seatmaps/services',
          },
          HttpStatus.BAD_GATEWAY,
        );
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    try {
      await this.cacheService.set(cacheKey, JSON.stringify(catalog), 60);
    } catch (cacheErr: unknown) {
      this.logger.warn(
        `Failed to write cache for offer ${offerId}: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
      );
    }

    return catalog;
  }

  private normalizeSeatMap(rawMap: DuffelSeatMap): AncillarySeatMap {
    return {
      cabins: (rawMap.cabins || []).map((cabin) => ({
        cabinClass: cabin.cabin_class,
        rows: (cabin.rows || []).map((row) => ({
          rowNumber: row.row_number,
          elements: (row.sections || []).flatMap((section) =>
            (section.elements || []).map((element) => {
              const normalizedElement: AncillaryRowElement = {
                type: element.type,
              };
              if (element.type === 'seat') {
                normalizedElement.designator = element.designator;
                normalizedElement.restricted = element.disclosures?.includes('restricted') || false;

                const rawServices = element.available_services || [];
                const validServices: AncillarySeatService[] = [];
                for (const srv of rawServices) {
                  if (srv.id && srv.passenger_id && srv.total_amount && srv.total_currency) {
                    validServices.push({
                      serviceId: srv.id,
                      passengerId: srv.passenger_id,
                      amount: srv.total_amount,
                      currency: srv.total_currency,
                    });
                  } else {
                    this.logger.warn(
                      `Quarantined incomplete seat service: ${srv.id || 'missing-id'} in seat ${element.designator}`,
                    );
                  }
                }
                normalizedElement.availableServices = validServices;
              }
              return normalizedElement;
            }),
          ),
        })),
      })),
    };
  }

  async repriceOffer(
    offerId: string,
    intendedServices: { serviceId: string; quantity: number }[],
  ): Promise<AncillaryRepriceOutput> {
    const isJest = process.env.JEST_WORKER_ID !== undefined;
    const token = this.duffelToken;

    const serviceMap = new Map<string, number>();
    for (const service of intendedServices) {
      const currentQty = serviceMap.get(service.serviceId) || 0;
      serviceMap.set(service.serviceId, currentQty + service.quantity);
    }
    const deduplicatedServices = Array.from(serviceMap.entries()).map(([serviceId, quantity]) => ({
      id: serviceId,
      quantity,
    }));

    try {
      if (!isJest && (process.env.NODE_ENV === 'test' || token === 'mock')) {
        const invalidServiceIdentities = deduplicatedServices
          .filter((s) => s.id.toLowerCase().includes('invalid'))
          .map((s) => s.id);

        if (invalidServiceIdentities.length > 0) {
          return {
            totalAmount: '0.00',
            baseAmount: '0.00',
            serviceLines: [],
            currency: 'USD',
            invalidServiceIdentities,
          };
        }

        let servicesTotal = 0;
        const serviceLines = deduplicatedServices.map((s) => {
          const price = s.id.includes('bag') ? 35 : 18;
          servicesTotal += price * s.quantity;
          return {
            serviceId: s.id,
            amount: price.toFixed(2),
            quantity: s.quantity,
          };
        });

        const base = 420.0;
        const grand = base + servicesTotal;

        return {
          totalAmount: grand.toFixed(2),
          baseAmount: base.toFixed(2),
          serviceLines,
          currency: 'USD',
          invalidServiceIdentities: [],
        };
      }

      await this.reserveBudgetAttempt();
      const response = await this.duffel.offers.getPriced(offerId, {
        intended_payment_methods: [{ type: 'card', card_id: 'mock_card' }],
        intended_services: deduplicatedServices,
      } as any);

      const pricedOffer = response.data as unknown as DuffelPricedOffer;

      const delta = Number(pricedOffer.total_amount) - Number(pricedOffer.base_amount);
      this.logger.log(
        `Priced offer ${offerId} successfully. Base: ${pricedOffer.base_amount}, Grand: ${pricedOffer.total_amount}, Currency: ${pricedOffer.total_currency}, Service line delta: ${delta.toFixed(2)}`,
      );

      return {
        totalAmount: pricedOffer.total_amount,
        baseAmount: pricedOffer.base_amount,
        serviceLines: (pricedOffer.service_lines || []).map((line) => ({
          serviceId: line.service_id,
          amount: line.total_amount,
          quantity: line.quantity,
        })),
        currency: pricedOffer.total_currency,
        invalidServiceIdentities: [],
      };
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        throw err;
      }
      const error = err as unknown as {
        message?: string;
        status?: number;
        statusCode?: number;
        stack?: string;
        errors?: Array<{ message?: string; detail?: string }>;
      };
      this.logger.error(
        `Error repricing offer ${offerId}: ${error.message || String(error)}`,
        error.stack,
      );

      if (error.status === 400 || error.statusCode === 400 || error.message?.includes('400')) {
        const errorMsg = error.message || '';
        const errorsList = error.errors || [];

        const invalidServiceIdentities: string[] = [];
        const allIntendedIds = deduplicatedServices.map((s) => s.id);

        for (const serviceId of allIntendedIds) {
          if (errorMsg.includes(serviceId)) {
            invalidServiceIdentities.push(serviceId);
          }
        }

        for (const errObj of errorsList) {
          const detail = errObj.message || errObj.detail || '';
          for (const serviceId of allIntendedIds) {
            if (detail.includes(serviceId) && !invalidServiceIdentities.includes(serviceId)) {
              invalidServiceIdentities.push(serviceId);
            }
          }
        }

        if (invalidServiceIdentities.length === 0) {
          invalidServiceIdentities.push(...allIntendedIds);
        }

        this.logger.warn(
          `Repricing failed for offer ${offerId} with invalid services: ${invalidServiceIdentities.join(', ')}`,
        );

        return {
          totalAmount: '0.00',
          baseAmount: '0.00',
          serviceLines: [],
          currency: 'USD',
          invalidServiceIdentities,
        };
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
          message: error.message || 'Failed to reprice Duffel offer',
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
      await this.reserveBudgetAttempt();
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
      born_on?: string;
      bornOn?: string | Date;
      givenName?: string;
      given_name?: string;
      familyName?: string;
      family_name?: string;
      phoneNumber?: string;
      phone_number?: string;
      email?: string;
      identity_documents?: unknown[];
    }[],
    services?: { id: string; quantity: number }[] | Record<string, unknown>,
    metadata?: Record<string, unknown> | string,
    idempotencyKey?: string,
  ): Promise<unknown> {
    let finalServices: { id: string; quantity: number }[] | undefined = undefined;
    let finalMetadata: Record<string, unknown> | undefined = undefined;
    let finalIdempotencyKey: string | undefined = undefined;

    if (Array.isArray(services)) {
      finalServices = services;
      finalMetadata = metadata as Record<string, unknown> | undefined;
      finalIdempotencyKey = idempotencyKey;
    } else if (services && typeof services === 'object') {
      finalMetadata = services as Record<string, unknown>;
      finalIdempotencyKey = metadata as string | undefined;
    } else {
      finalIdempotencyKey = idempotencyKey;
    }

    try {
      const rawOffer = await this.getOfferById(duffelOfferId);
      const offer = rawOffer as {
        passengers: Array<{
          id: string;
          type: string;
        }>;
      };

      if (!offer || !offer.passengers) {
        throw new HttpException('Duffel offer or passenger list not found.', HttpStatus.NOT_FOUND);
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
          throw new HttpException('Given name is required for passenger.', HttpStatus.BAD_REQUEST);
        }

        if (!familyName) {
          throw new HttpException('Family name is required for passenger.', HttpStatus.BAD_REQUEST);
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
        const rawDob = p.born_on || p.bornOn || p.dateOfBirth;
        if (rawDob) {
          if (rawDob instanceof Date) {
            born_on = rawDob.toISOString().split('T')[0];
          } else if (typeof rawDob === 'string') {
            born_on = rawDob.split('T')[0];
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

        const duffelPassenger: Record<string, unknown> = {
          id: matchedOfferPassenger.id,
          given_name: givenName,
          family_name: familyName,
          born_on,
          gender,
          title,
          phone_number,
          email,
        };

        if (
          p.identity_documents &&
          Array.isArray(p.identity_documents) &&
          p.identity_documents.length > 0
        ) {
          duffelPassenger.identity_documents = p.identity_documents;
        }

        return duffelPassenger;
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
        const key = finalIdempotencyKey || crypto.randomUUID();

        this.logger.log(
          `Creating Duffel order with ${finalServices?.length || 0} services, offer ID ${duffelOfferId}`,
        );

        const orderPromise = (async () => {
          await this.reserveBudgetAttempt();
          const res = await fetch(`${basePath}/air/orders`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              'Duffel-Version': apiVersion,
              'Content-Type': 'application/json',
              'Idempotency-Key': `${key}-duffel-order`,
            },
            body: JSON.stringify({
              data: {
                type: 'instant',
                selected_offers: [duffelOfferId],
                passengers: duffelPassengers,
                services: finalServices && finalServices.length > 0 ? finalServices : undefined,
                metadata: finalMetadata,
              },
            }),
          });

          const body = (await res.json()) as any;
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

  async createCancellationQuote(duffelOrderId: string): Promise<DuffelCancellationQuote> {
    try {
      const isJest = process.env.JEST_WORKER_ID !== undefined;
      const isTestEnv = process.env.NODE_ENV === 'test' || isJest;
      const token = process.env.DUFFEL_ACCESS_TOKEN;

      if (!isTestEnv) {
        if (!token || token === '' || token === 'mock') {
          throw new HttpException(
            {
              message:
                'Duffel Access Token is missing or invalid in production/development runtime.',
              code: 'CONFIGURATION_ERROR',
            },
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }
      }

      if (isTestEnv || token === 'mock') {
        this.logger.log(
          `Mocking Duffel cancellation quote for test environment. OrderId: ${duffelOrderId}`,
        );
        return {
          id: `oc_mock_${duffelOrderId}`,
          order_id: duffelOrderId,
          refund_amount: '100.00',
          refund_currency: 'GBP',
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          refundable: true,
        };
      }

      await this.reserveBudgetAttempt();
      const quote = await this.duffel.orderCancellations.create({
        order_id: duffelOrderId,
      });
      // Upstream Duffel SDK returns untyped response payload; cast to domain DuffelCancellationQuote
      return quote.data as unknown as DuffelCancellationQuote;
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        throw err;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(
        `Failed to create cancellation quote for Duffel order ${duffelOrderId}: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        {
          code: 'UPSTREAM_CANCELLATION_QUOTE_FAILED',
          message: error.message || 'Failed to create cancellation quote',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async retrieveOrder(duffelOrderId: string): Promise<DuffelRecoveredOrder> {
    try {
      await this.reserveBudgetAttempt();
      const order = (await this.duffel.orders.get(duffelOrderId)).data;
      const cancellation = order.cancellation ?? null;
      const isCancelled = order.cancelled_at != null || cancellation?.confirmed_at != null;

      return {
        id: order.id,
        order_id: order.id,
        status: isCancelled ? 'CANCELLED' : 'ACTIVE',
        cancelled_at: order.cancelled_at ?? null,
        cancellation_id: cancellation?.id ?? null,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to retrieve Duffel order ${duffelOrderId}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        {
          code: 'UPSTREAM_ORDER_RETRIEVAL_FAILED',
          message: 'Failed to retrieve Duffel order',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async retrieveCompleteOrder(duffelOrderId: string): Promise<DuffelOrder> {
    try {
      await this.reserveBudgetAttempt();
      const order = (await this.duffel.orders.get(duffelOrderId)).data as unknown as DuffelOrder;
      return order;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to retrieve complete Duffel order ${duffelOrderId}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        {
          code: 'UPSTREAM_ORDER_RETRIEVAL_FAILED',
          message: 'Failed to retrieve Duffel order',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async confirmCancellationQuote(quoteId: string): Promise<DuffelConfirmedCancellation> {
    try {
      await this.reserveBudgetAttempt();
      const cancellation = (await this.duffel.orderCancellations.confirm(quoteId)).data;
      const refundAmount = cancellation.refund_amount;

      return {
        id: cancellation.id,
        order_id: cancellation.order_id,
        status: cancellation.confirmed_at ? 'CONFIRMED' : 'PENDING',
        refund_amount: refundAmount,
        refund_currency: cancellation.refund_currency,
        refundable: refundAmount !== null && Number(refundAmount) > 0,
        confirmed_at: cancellation.confirmed_at ?? null,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to confirm Duffel cancellation quote ${quoteId}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        {
          code: 'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
          message: 'Failed to confirm Duffel cancellation quote',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async cancelOrder(duffelOrderId: string): Promise<unknown> {
    try {
      await this.reserveBudgetAttempt();
      const quote = await this.duffel.orderCancellations.create({
        order_id: duffelOrderId,
      });
      await this.reserveBudgetAttempt();
      const confirmed = await this.duffel.orderCancellations.confirm(quote.data.id);
      return confirmed.data;
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        throw err;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(
        `Failed to cancel Duffel order ${duffelOrderId}: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        {
          code: 'UPSTREAM_CANCEL_FAILED',
          message: error.message || 'Failed to cancel Duffel order',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  mapDuffelOrderToSnapshots(duffelOrder: unknown): {
    flightSnapshot: FlightSnapshot;
    passengerSnapshot: PassengerSnapshot;
  } {
    return mapDuffelOrderToSnapshots(duffelOrder);
  }
}
