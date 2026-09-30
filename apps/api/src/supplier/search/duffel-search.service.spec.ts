import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  HttpException,
  HttpStatus,
  NotFoundException,
  GoneException,
} from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import { DuffelRateBudgetService } from '../core/duffel-rate-budget.service';
import { DuffelSearchService } from './duffel-search.service';
import { DuffelSearchAdapter } from './duffel-search.adapter';
import {
  FlightSearchCriteria,
  FlightSearchResult,
} from './flight-search.port';
import { generateDeterministicUUID } from '@/flights/flight-offer-normalizer';

describe('DuffelSearchService Contract Tests (TDD RED)', () => {
  let service: DuffelSearchService;
  let cacheService: jest.Mocked<Pick<CacheService, 'get' | 'set'>>;
  let rateBudgetService: jest.Mocked<Pick<DuffelRateBudgetService, 'reserveAttempt'>>;
  let searchAdapter: jest.Mocked<Pick<DuffelSearchAdapter, 'searchOffers' | 'getOffer'>>;

  const fixedNow = new Date('2026-09-29T12:00:00.000Z');

  const defaultCriteria: FlightSearchCriteria = {
    origin: 'SFO',
    destination: 'JFK',
    departureDate: '2026-10-01',
    returnDate: '2026-10-10',
    adults: 1,
    children: 0,
    infants: 0,
    cabinClass: 'economy',
  };

  const computeExpectedHash = (criteria: FlightSearchCriteria): string => {
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
  };

  const createMockRawOffer = (id: string) => ({
    id,
    total_amount: '350.00',
    total_currency: 'USD',
    passenger_identity_documents_required: false,
    passengers: [
      { id: 'pas_supplier_1', type: 'adult' },
    ],
    slices: [
      {
        id: `sli_out_${id}`,
        duration: 'PT5H30M',
        origin: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
        destination: { id: 'plc_jfk', name: 'New York', iata_code: 'JFK', type: 'airport' },
        segments: [
          {
            id: `seg_out_1_${id}`,
            duration: 'PT2H30M',
            departing_at: '2026-10-01T08:00:00',
            arriving_at: '2026-10-01T10:30:00',
            origin: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_ord', name: 'Chicago', iata_code: 'ORD', type: 'airport' },
            marketing_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
            operating_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
            marketing_carrier_flight_number: '101',
            passengers: [
              {
                passenger_id: 'pas_supplier_1',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
            ],
          },
          {
            id: `seg_out_2_${id}`,
            duration: 'PT2H15M',
            departing_at: '2026-10-01T12:00:00',
            arriving_at: '2026-10-01T15:15:00',
            origin: { id: 'plc_ord', name: 'Chicago', iata_code: 'ORD', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'New York', iata_code: 'JFK', type: 'airport' },
            marketing_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
            operating_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
            marketing_carrier_flight_number: '202',
            passengers: [
              {
                passenger_id: 'pas_supplier_1',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
            ],
          },
        ],
      },
      {
        id: `sli_ret_${id}`,
        duration: 'PT6H00M',
        origin: { id: 'plc_jfk', name: 'New York', iata_code: 'JFK', type: 'airport' },
        destination: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
        segments: [
          {
            id: `seg_ret_1_${id}`,
            duration: 'PT6H00M',
            departing_at: '2026-10-10T10:00:00',
            arriving_at: '2026-10-10T13:00:00',
            origin: { id: 'plc_jfk', name: 'New York', iata_code: 'JFK', type: 'airport' },
            destination: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
            marketing_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
            operating_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
            marketing_carrier_flight_number: '303',
            passengers: [
              {
                passenger_id: 'pas_supplier_1',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
            ],
          },
        ],
      },
    ],
  });

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(fixedNow);

    cacheService = {
      get: jest.fn(),
      set: jest.fn(),
    };

    rateBudgetService = {
      reserveAttempt: jest.fn().mockResolvedValue({ ok: true }),
    };

    searchAdapter = {
      searchOffers: jest.fn(),
      getOffer: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DuffelSearchService,
        { provide: CacheService, useValue: cacheService },
        { provide: DuffelRateBudgetService, useValue: rateBudgetService },
        { provide: DuffelSearchAdapter, useValue: searchAdapter },
      ],
    }).compile();

    service = module.get<DuffelSearchService>(DuffelSearchService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Search Port Contract & Criteria Mapping', () => {
    it('normalizes criteria and queries Redis with flight:search:${searchHash}', async () => {
      const criteria: FlightSearchCriteria = {
        origin: 'sfo',
        destination: 'jfk',
        departureDate: '2026-10-01',
        adults: 1,
      };

      const expectedHash = computeExpectedHash(criteria);
      const expectedKey = `flight:search:${expectedHash}`;

      cacheService.get.mockResolvedValueOnce(null);
      searchAdapter.searchOffers.mockResolvedValueOnce({ offers: [] });

      await service.search(criteria, 'user');

      expect(cacheService.get).toHaveBeenCalledWith(expectedKey);
    });

    it('produces identical searchHash for criteria variations with whitespace or case differences', async () => {
      const criteria1: FlightSearchCriteria = {
        origin: '  sfo  ',
        destination: '  jfk  ',
        departureDate: '2026-10-01',
        adults: 1,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
      };
      const criteria2: FlightSearchCriteria = {
        origin: 'SFO',
        destination: 'JFK',
        departureDate: '2026-10-01',
        adults: 1,
      };

      cacheService.get.mockResolvedValue(null);
      searchAdapter.searchOffers.mockResolvedValue({ offers: [] });

      await service.search(criteria1, 'user');
      await service.search(criteria2, 'user');

      expect(cacheService.get).toHaveBeenCalledTimes(2);
      const firstKey = cacheService.get.mock.calls[0][0];
      expect(firstKey).toMatch(/^flight:search:[a-f0-9]{64}$/);
      expect(cacheService.get).toHaveBeenNthCalledWith(2, firstKey);
    });

    it('maps one-way search criteria (origin, destination, departureDate, cabinClass, adults) to Duffel query format', async () => {
      const criteria: FlightSearchCriteria = {
        origin: 'sfo',
        destination: 'jfk',
        departureDate: '2026-10-01',
        adults: 2,
        cabinClass: 'economy',
      };

      cacheService.get.mockResolvedValueOnce(null);
      searchAdapter.searchOffers.mockResolvedValueOnce({ offers: [] });

      await service.search(criteria, 'user');

      expect(searchAdapter.searchOffers).toHaveBeenCalledWith({
        slices: [
          {
            origin: 'SFO',
            destination: 'JFK',
            departure_date: '2026-10-01',
            arrival_time: null,
            departure_time: null,
          },
        ],
        passengers: [{ type: 'adult' }, { type: 'adult' }],
        cabin_class: 'economy',
      });
    });

    it('maps round-trip search criteria with multi-passenger (adults, children, infants) and cabinClass to Duffel query format', async () => {
      const criteria: FlightSearchCriteria = {
        origin: 'sfo',
        destination: 'jfk',
        departureDate: '2026-10-01',
        returnDate: '2026-10-10',
        adults: 1,
        children: 2,
        infants: 1,
        cabinClass: 'business',
      };

      cacheService.get.mockResolvedValueOnce(null);
      searchAdapter.searchOffers.mockResolvedValueOnce({ offers: [] });

      await service.search(criteria, 'agent');

      expect(searchAdapter.searchOffers).toHaveBeenCalledWith({
        slices: [
          {
            origin: 'SFO',
            destination: 'JFK',
            departure_date: '2026-10-01',
            arrival_time: null,
            departure_time: null,
          },
          {
            origin: 'JFK',
            destination: 'SFO',
            departure_date: '2026-10-10',
            arrival_time: null,
            departure_time: null,
          },
        ],
        passengers: [
          { type: 'adult' },
          { type: 'child' },
          { type: 'child' },
          { type: 'infant_without_seat' },
        ],
        cabin_class: 'business',
      });
    });
  });

  describe('Cache Hit Contract', () => {
    it('returns cached: true with ZERO upstream adapter calls and ZERO rate budget reservations', async () => {
      const expectedHash = computeExpectedHash(defaultCriteria);
      const cachedResult: FlightSearchResult = {
        offers: [
          {
            id: generateDeterministicUUID('off_cached_1'),
            supplierOfferId: 'off_cached_1',
            totalAmount: '250.00',
            price: 250.0,
            currency: 'USD',
            offerExpiresAt: null,
            passengers: [{ supplierPassengerId: 'pas_1', type: 'ADULT' }],
            airline: 'United Airlines',
            flightNumber: 'UA101',
            departureAirport: 'SFO',
            arrivalAirport: 'JFK',
            departureTime: '2026-10-01T08:00:00',
            arrivalTime: '2026-10-01T16:00:00',
            duration: 300,
            stops: 0,
            fareClass: 'Economy',
            baggageAllowance: '1 checked bag(s)',
            segments: [],
            returnSegments: null,
            conditions: {
              refundable: false,
              changeable: true,
              changeBeforeDeparture: null,
            },
            matchInput: {
              id: generateDeterministicUUID('off_cached_1'),
              price: 250.0,
              currency: 'USD',
              stops: 0,
              duration: 300,
              outboundDepartureHour: 8,
              outboundArrivalHour: 16,
              carrierCodes: ['UA'],
              cabinClass: 'economy',
              hasCheckedBaggage: true,
              originalIndex: 0,
            },
            rawSupplierPayload: {},
          },
        ],
        searchHash: expectedHash,
        cached: true,
      };

      cacheService.get.mockResolvedValueOnce(JSON.stringify(cachedResult));

      const result = await service.search(defaultCriteria, 'user');

      expect(result.cached).toBe(true);
      expect(result.searchHash).toBe(expectedHash);
      expect(result.offers).toHaveLength(1);
      expect(result.offers[0].supplierOfferId).toBe('off_cached_1');

      // Invariants: ZERO upstream attempts and ZERO budget calls on cache hit
      expect(searchAdapter.searchOffers).not.toHaveBeenCalled();
      expect(rateBudgetService.reserveAttempt).not.toHaveBeenCalled();
    });
  });

  describe('Caller Sub-Allocation Limits & Budget Enforcement', () => {
    it('reserves user sub-allocation with limit 1,000 and budget:duffel:daily:user:YYYY-MM-DD', async () => {
      cacheService.get.mockResolvedValueOnce(null);
      searchAdapter.searchOffers.mockResolvedValueOnce({ offers: [] });

      await service.search(defaultCriteria, 'user');

      expect(rateBudgetService.reserveAttempt).toHaveBeenCalledWith({
        key: 'budget:duffel:daily:user:2026-09-29',
        limit: 1000,
      });
      expect(searchAdapter.searchOffers).toHaveBeenCalledTimes(1);
    });

    it('reserves agent sub-allocation with limit 500 and budget:duffel:daily:agent:YYYY-MM-DD', async () => {
      cacheService.get.mockResolvedValueOnce(null);
      searchAdapter.searchOffers.mockResolvedValueOnce({ offers: [] });

      await service.search(defaultCriteria, 'agent');

      expect(rateBudgetService.reserveAttempt).toHaveBeenCalledWith({
        key: 'budget:duffel:daily:agent:2026-09-29',
        limit: 500,
      });
      expect(searchAdapter.searchOffers).toHaveBeenCalledTimes(1);
    });

    it('throws HttpException 429 RATE_LIMIT_EXCEEDED when daily budget is exhausted without calling upstream', async () => {
      cacheService.get.mockResolvedValueOnce(null);
      rateBudgetService.reserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 43200,
        resetAt: '2026-09-30T00:00:00.000Z',
      });

      const searchPromise = service.search(defaultCriteria, 'user');

      await expect(searchPromise).rejects.toThrow(HttpException);
      await expect(searchPromise).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: expect.objectContaining({
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: 43200,
          resetAt: '2026-09-30T00:00:00.000Z',
        }),
      });

      expect(rateBudgetService.reserveAttempt).toHaveBeenCalledWith({
        key: 'budget:duffel:daily:user:2026-09-29',
        limit: 1000,
      });
      expect(searchAdapter.searchOffers).not.toHaveBeenCalled();
    });

    it('throws HttpException 429 RATE_LIMIT_EXCEEDED when global 1,500 daily budget cap is exhausted and passes caller sub-allocation constraint', async () => {
      cacheService.get.mockResolvedValueOnce(null);
      // When global 1,500 daily cap is reached, core rate budget service returns { ok: false, error: 'EXHAUSTED' }
      rateBudgetService.reserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 43200,
        resetAt: '2026-09-30T00:00:00.000Z',
      });

      const searchPromise = service.search(defaultCriteria, 'user');

      await expect(searchPromise).rejects.toThrow(HttpException);
      await expect(searchPromise).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: expect.objectContaining({
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: 43200,
          resetAt: '2026-09-30T00:00:00.000Z',
        }),
      });

      // Asserts that search caller sub-allocation constraint is passed into reserveAttempt
      expect(rateBudgetService.reserveAttempt).toHaveBeenCalledWith({
        key: 'budget:duffel:daily:user:2026-09-29',
        limit: 1000,
      });
      expect(searchAdapter.searchOffers).not.toHaveBeenCalled();
    });

    it('passes agent caller sub-allocation constraint and throws 429 RATE_LIMIT_EXCEEDED on budget exhaustion', async () => {
      cacheService.get.mockResolvedValueOnce(null);
      rateBudgetService.reserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 21600,
        resetAt: '2026-09-30T00:00:00.000Z',
      });

      const searchPromise = service.search(defaultCriteria, 'agent');

      await expect(searchPromise).rejects.toThrow(HttpException);
      await expect(searchPromise).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: expect.objectContaining({
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: 21600,
          resetAt: '2026-09-30T00:00:00.000Z',
        }),
      });

      expect(rateBudgetService.reserveAttempt).toHaveBeenCalledWith({
        key: 'budget:duffel:daily:agent:2026-09-29',
        limit: 500,
      });
      expect(searchAdapter.searchOffers).not.toHaveBeenCalled();
    });

    it('throws HttpException 429 BUDGET_UNAVAILABLE when budget store encounters an error', async () => {
      cacheService.get.mockResolvedValueOnce(null);
      rateBudgetService.reserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'UNAVAILABLE',
        retryAfterSeconds: 60,
      });

      const searchPromise = service.search(defaultCriteria, 'agent');

      await expect(searchPromise).rejects.toThrow(HttpException);
      await expect(searchPromise).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: expect.objectContaining({
          code: 'BUDGET_UNAVAILABLE',
          retryAfterSeconds: 60,
        }),
      });

      expect(rateBudgetService.reserveAttempt).toHaveBeenCalledWith({
        key: 'budget:duffel:daily:agent:2026-09-29',
        limit: 500,
      });
      expect(searchAdapter.searchOffers).not.toHaveBeenCalled();
    });
  });

  describe('Deterministic UUID & Slice/Segment Ordering', () => {
    it('generates deterministic UUID matching SHA-256 v4 format and preserves slice/segment order', async () => {
      const rawOffer = createMockRawOffer('off_supplier_test_789');
      const expectedUUID = generateDeterministicUUID('off_supplier_test_789');

      cacheService.get.mockResolvedValueOnce(null);
      searchAdapter.searchOffers.mockResolvedValueOnce({
        offers: [rawOffer],
      });

      const result = await service.search(defaultCriteria, 'user');

      expect(result.offers).toHaveLength(1);
      const offer = result.offers[0];

      // Invariants
      expect(offer.id).toBe(expectedUUID);
      expect(offer.supplierOfferId).toBe('off_supplier_test_789');

      // Slice & segment ordering
      expect(offer.segments).toHaveLength(2);
      expect(offer.segments[0].supplierSegmentId).toBe('seg_out_1_off_supplier_test_789');
      expect(offer.segments[0].departureAirport).toBe('SFO');
      expect(offer.segments[0].arrivalAirport).toBe('ORD');
      expect(offer.segments[1].supplierSegmentId).toBe('seg_out_2_off_supplier_test_789');
      expect(offer.segments[1].departureAirport).toBe('ORD');
      expect(offer.segments[1].arrivalAirport).toBe('JFK');

      // Return slice ordering
      expect(offer.returnSegments).not.toBeNull();
      expect(offer.returnSegments).toHaveLength(1);
      expect(offer.returnSegments![0].supplierSegmentId).toBe('seg_ret_1_off_supplier_test_789');
      expect(offer.returnSegments![0].departureAirport).toBe('JFK');
      expect(offer.returnSegments![0].arrivalAirport).toBe('SFO');

      // MatchInput association
      expect(offer.matchInput.id).toBe(expectedUUID);
      expect(offer.matchInput.originalIndex).toBe(0);
      expect(offer.matchInput.stops).toBe(1); // 2 outbound segments = 1 stop

      // Raw supplier payload preserved verbatim
      expect(offer.rawSupplierPayload).toEqual(rawOffer);
    });
  });

  describe('getOfferById Contract', () => {
    it('retrieves live offer and maps to normalized FlightOffer', async () => {
      const rawOffer = createMockRawOffer('off_live_999');
      const expectedUUID = generateDeterministicUUID('off_live_999');

      searchAdapter.getOffer.mockResolvedValueOnce(rawOffer);

      const offer = await service.getOfferById('off_live_999', 5000);

      expect(searchAdapter.getOffer).toHaveBeenCalledWith('off_live_999', 5000);
      expect(offer.id).toBe(expectedUUID);
      expect(offer.supplierOfferId).toBe('off_live_999');
      expect(offer.totalAmount).toBe('350.00');
      expect(offer.currency).toBe('USD');
    });

    it('maps upstream 404 to NotFoundException', async () => {
      searchAdapter.getOffer.mockRejectedValueOnce(
        new NotFoundException('Duffel offer off_missing_404 was not found'),
      );

      await expect(service.getOfferById('off_missing_404')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('maps upstream 410 to GoneException', async () => {
      searchAdapter.getOffer.mockRejectedValueOnce(
        new GoneException('Duffel offer off_expired_410 has expired'),
      );

      await expect(service.getOfferById('off_expired_410')).rejects.toThrow(
        GoneException,
      );
    });
  });

  describe('normalizeStoredOffer Contract', () => {
    it('normalizes valid stored raw offer into neutral FlightOffer', () => {
      const rawOffer = createMockRawOffer('off_stored_valid');
      const expectedUUID = generateDeterministicUUID('off_stored_valid');

      const normalized = service.normalizeStoredOffer(rawOffer);

      expect(normalized).not.toBeNull();
      expect(normalized!.id).toBe(expectedUUID);
      expect(normalized!.supplierOfferId).toBe('off_stored_valid');
      expect(normalized!.passengers).toEqual([
        { supplierPassengerId: 'pas_supplier_1', type: 'ADULT' },
      ]);
    });

    it('returns null fail-closed when stored offer is malformed or invalid', () => {
      const malformedOffer = { id: 'off_corrupt', slices: [] };
      const normalized = service.normalizeStoredOffer(malformedOffer);

      expect(normalized).toBeNull();
    });
  });
});
