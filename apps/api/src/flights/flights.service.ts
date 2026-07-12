import { Injectable, BadRequestException, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelService } from '@/duffel/duffel.service';
import { AuditService } from '@/audit/audit.service';
import { FlightSearchRequestDto, FlightSearchResponseDto, FlightOfferDto, FlightSegmentDto, CabinMismatchDetail } from './dto/search-flight.dto';
import { FlightDetailResponseDto } from './dto/detail-flight.dto';
import { DuffelOffer, DuffelSegment } from '@/duffel/duffel.types';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';

export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';

function parseISO8601Duration(durationStr: string): number {
  const regex = /P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/;
  const matches = durationStr.match(regex);
  if (!matches) return 0;
  const days = parseInt(matches[1] || '0', 10);
  const hours = parseInt(matches[2] || '0', 10);
  const minutes = parseInt(matches[3] || '0', 10);
  return days * 1440 + hours * 60 + minutes;
}

function generateDeterministicUUID(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    '8' + hash.substring(17, 20),
    hash.substring(20, 32)
  ].join('-');
}

function capitalize(str: string | null | undefined): string | null {
  if (!str) return null;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function mapSegment(segment: DuffelSegment): FlightSegmentDto {
  const aircraftName = segment.aircraft?.name || '';
  const aircraftCode = segment.aircraft?.iata_code || '';
  const aircraft = aircraftName.includes('Airbus')
    ? aircraftName.replace('Airbus ', '')
    : aircraftName || aircraftCode || null;

  return {
    carrierCode: segment.marketing_carrier?.iata_code || '',
    flightNumber: segment.marketing_carrier_flight_number || '',
    operatingCarrier: segment.operating_carrier?.name || '',
    departureAirport: segment.origin?.iata_code || '',
    departureTerminal: segment.origin_terminal || null,
    departureTime: segment.departing_at,
    arrivalAirport: segment.destination?.iata_code || '',
    arrivalTerminal: segment.destination_terminal || null,
    arrivalTime: segment.arriving_at,
    duration: parseISO8601Duration(segment.duration),
    aircraft,
    cabinClass: (segment.passengers?.[0]?.cabin_class || 'economy') as CabinClass,
  };
}

const CABIN_RANK: Record<CabinClass, number> = {
  economy: 0,
  premium_economy: 1,
  business: 2,
  first: 3
};

function computeCabinMatch(
  requestedCabinClass: CabinClass,
  segments: FlightSegmentDto[],
  returnSegments: FlightSegmentDto[] | null
): { cabinClassMatch: 'full' | 'mixed' | 'downgraded'; cabinMismatchDetails: CabinMismatchDetail[] | null } {
  const allSegments = [...segments, ...(returnSegments || [])];
  if (allSegments.length === 0) {
    return { cabinClassMatch: 'full', cabinMismatchDetails: null };
  }

  let longestSegment = allSegments[0];
  for (const seg of allSegments) {
    if (seg.duration > longestSegment.duration) {
      longestSegment = seg;
    }
  }

  const requestedRank = CABIN_RANK[requestedCabinClass] ?? 0;
  const longestRank = CABIN_RANK[longestSegment.cabinClass] ?? 0;

  let cabinClassMatch: 'full' | 'mixed' | 'downgraded' = 'full';
  if (longestRank < requestedRank) {
    cabinClassMatch = 'downgraded';
  } else if (allSegments.some(seg => seg.cabinClass !== requestedCabinClass)) {
    cabinClassMatch = 'mixed';
  }

  const mismatchDetailsList: CabinMismatchDetail[] = [];
  segments.forEach((seg, idx) => {
    if (seg.cabinClass !== requestedCabinClass) {
      mismatchDetailsList.push({
        segmentIndex: idx,
        leg: 'outbound',
        expected: requestedCabinClass,
        actual: seg.cabinClass,
        route: `${seg.departureAirport} → ${seg.arrivalAirport}`
      });
    }
  });

  if (returnSegments) {
    returnSegments.forEach((seg, idx) => {
      if (seg.cabinClass !== requestedCabinClass) {
        mismatchDetailsList.push({
          segmentIndex: idx,
          leg: 'return',
          expected: requestedCabinClass,
          actual: seg.cabinClass,
          route: `${seg.departureAirport} → ${seg.arrivalAirport}`
        });
      }
    });
  }

  return {
    cabinClassMatch,
    cabinMismatchDetails: cabinClassMatch === 'full' ? null : mismatchDetailsList
  };
}

function mapOffer(offer: DuffelOffer, id: string, requestedCabinClass: CabinClass): FlightOfferDto {
  const outboundSlice = offer.slices[0];
  const firstSegment = outboundSlice?.segments[0];
  const lastSegment = outboundSlice?.segments[outboundSlice.segments.length - 1];

  const airline = firstSegment?.operating_carrier?.name || firstSegment?.marketing_carrier?.name || 'Unknown Airline';
  const flightNumber = (firstSegment?.marketing_carrier?.iata_code || '') + (firstSegment?.marketing_carrier_flight_number || '');

  const segmentBaggage = firstSegment?.passengers?.[0]?.baggages;
  let baggageAllowance: string | null = null;
  if (segmentBaggage && segmentBaggage.length > 0) {
    const bag = segmentBaggage[0];
    baggageAllowance = `${bag.quantity || 0} ${bag.type} bag(s)`;
  }

  const cabinClass = firstSegment?.passengers?.[0]?.cabin_class || null;

  const returnSlice = offer.slices[1];

  const segments = outboundSlice?.segments.map(mapSegment) || [];
  const returnSegments = returnSlice ? returnSlice.segments.map(mapSegment) : null;

  const { cabinClassMatch, cabinMismatchDetails } = computeCabinMatch(
    requestedCabinClass,
    segments,
    returnSegments
  );

  return {
    id,
    duffelOfferId: offer.id,
    airline,
    flightNumber,
    departureAirport: firstSegment?.origin?.iata_code || '',
    arrivalAirport: lastSegment?.destination?.iata_code || '',
    departureTime: firstSegment?.departing_at || '',
    arrivalTime: lastSegment?.arriving_at || '',
    duration: parseISO8601Duration(outboundSlice?.duration || 'PT0H0M'),
    stops: outboundSlice ? outboundSlice.segments.length - 1 : 0,
    price: parseFloat(offer.total_amount),
    currency: offer.total_currency,
    fareClass: capitalize(cabinClass),
    baggageAllowance,
    requestedCabinClass,
    cabinClassMatch,
    cabinMismatchDetails,
    segments,
    returnSegments,
  };
}

@Injectable()
export class FlightsService {
  private readonly logger = new Logger(FlightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
    private readonly duffelService: DuffelService,
    private readonly auditService: AuditService,
  ) {}

  async search(
    userId: string,
    query: FlightSearchRequestDto,
    traceId?: string,
    correlationId?: string,
  ): Promise<FlightSearchResponseDto> {
    const startTime = Date.now();
    const origin = query.origin.trim().toUpperCase();
    const destination = query.destination.trim().toUpperCase();
    
    if (origin === destination) {
      throw new BadRequestException('Origin and destination must be different');
    }

    if (query.returnDate) {
      const depDate = new Date(query.departureDate);
      const retDate = new Date(query.returnDate);
      if (retDate < depDate) {
        throw new BadRequestException('Return date must be on or after departure date');
      }
    }

    // Validate that origin and destination airports exist in the Airport table
    const [originAirport, destAirport] = await Promise.all([
      this.prisma.airport.findUnique({ where: { iataCode: origin } }),
      this.prisma.airport.findUnique({ where: { iataCode: destination } }),
    ]);

    if (!originAirport) {
      throw new BadRequestException(`Origin airport with code ${origin} does not exist`);
    }
    if (!destAirport) {
      throw new BadRequestException(`Destination airport with code ${destination} does not exist`);
    }

    const passengersInfo = {
      adults: Number(query.adults),
      children: Number(query.children || 0),
      infants: Number(query.infants || 0),
      cabinClass: (query.cabinClass || 'economy') as CabinClass,
    };

    const forSearch = {
      origin,
      destination,
      departureDate: query.departureDate,
      returnDate: query.returnDate || undefined,
      ...passengersInfo,
    };

    const searchResult = await this.duffelService.searchFlights(forSearch, 'user');
    const rawResult = searchResult.offerRequest;
    const cached = searchResult.cached;
    const sha256 = searchResult.searchHash;

    // Map raw offers to FlightOfferDto capping at 20 results using deterministic UUIDs
    const results: FlightOfferDto[] = (rawResult.offers || [])
      .slice(0, 20)
      .map((offer) => {
        const id = generateDeterministicUUID(`${sha256}:${offer.id}`);
        return mapOffer(offer, id, passengersInfo.cabinClass);
      });

    // Write async write-behind persistence
    setImmediate(async () => {
      try {
        const prices = results.map(r => r.price);
        const minPrice = prices.length > 0 ? Math.min(...prices) : null;
        const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
        const currency = results.length > 0 ? results[0].currency : 'USD';

        await this.prisma.$transaction(async (tx) => {
          await tx.searchHistory.create({
            data: {
              userId,
              origin,
              destination,
              departureDate: new Date(query.departureDate),
              returnDate: query.returnDate ? new Date(query.returnDate) : null,
              ...passengersInfo,
              resultCount: results.length,
              minPrice,
              maxPrice,
              currency,
              searchHash: sha256,
            },
          });

          if (!cached) {
            const flightOffersData = results.map((offerDto) => {
              const rawOffer = rawResult.offers.find(o => o.id === offerDto.duffelOfferId);
              return {
                id: offerDto.id,
                searchHash: sha256,
                duffelOfferId: offerDto.duffelOfferId,
                rawOffer: rawOffer ? (rawOffer as unknown as Prisma.InputJsonValue) : {},
                origin,
                destination,
                departureDate: new Date(query.departureDate),
                returnDate: query.returnDate ? new Date(query.returnDate) : null,
                ...passengersInfo,
                price: new Prisma.Decimal(offerDto.price),
                currency: offerDto.currency,
              };
            });

            const offerRecoveriesData = results.map((offerDto) => ({
              id: offerDto.id,
              searchHash: sha256,
            }));

            if (flightOffersData.length > 0) {
              await tx.flightOffer.createMany({
                data: flightOffersData,
                skipDuplicates: true,
              });
              await tx.offerRecovery.createMany({
                data: offerRecoveriesData,
                skipDuplicates: true,
              });
            }
          }
        });
      } catch (error) {
        this.logger.error('Failed to save search history and offers atomically', error);
      }
    });

    const responseTime = Date.now() - startTime;

    // Create audit log entry (synchronous so test can immediately assert it)
    await this.auditService.createLog(this.prisma, {
      userId,
      action: 'flight_search',
      resourceType: 'Flight',
      metadata: {
        origin,
        destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate || null,
        ...passengersInfo,
        searchHash: sha256,
        resultCount: results.length,
        responseTime,
      },
      traceId,
      correlationId,
    });

    return {
      results,
      meta: {
        totalResults: results.length,
        searchHash: sha256,
        cached,
        requestedCabinClass: query.cabinClass || 'economy',
      },
    };
  }

  async getFlightDetail(id: string, userId: string): Promise<FlightDetailResponseDto> {
    // 1. Look up flight offer in database
    const flightOffer = await this.prisma.flightOffer.findUnique({
      where: { id },
    });

    if (!flightOffer) {
      // 2. Fallback: check if the offer existed in offerRecovery
      const recoveryRecord = await this.prisma.offerRecovery.findUnique({
        where: { id },
      });

      if (recoveryRecord) {
        // Find the original search history
        const searchHistory = await this.prisma.searchHistory.findFirst({
          where: { searchHash: recoveryRecord.searchHash },
          orderBy: { createdAt: 'desc' },
        });

        if (searchHistory) {
          throw new HttpException(
            {
              message: 'This flight offer has expired. Use the search parameters below to find current availability.',
              code: 'OFFER_EXPIRED',
              recovery: {
                origin: searchHistory.origin,
                destination: searchHistory.destination,
                departureDate: searchHistory.departureDate.toISOString().slice(0, 10),
                returnDate: searchHistory.returnDate ? searchHistory.returnDate.toISOString().slice(0, 10) : null,
                adults: searchHistory.adults,
                children: searchHistory.children,
                infants: searchHistory.infants,
                cabinClass: searchHistory.cabinClass,
              },
            },
            HttpStatus.GONE,
          );
        }
      }

      // If not in recovery either, check if it's a valid UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id)) {
        throw new BadRequestException('Invalid UUID format');
      }

      throw new HttpException(
        {
          message: `Flight offer with ID ${id} never existed or has been completely removed.`,
          code: 'NOT_FOUND',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    // 3. Offer found: Retrieve live details from Duffel API
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let liveOffer: Record<string, any>;
    try {
      // Check if testing environment / mock mode
      const isJest = process.env.JEST_WORKER_ID !== undefined;
      const isTestEnv = process.env.NODE_ENV === 'test' || isJest;
      const token = process.env.DUFFEL_ACCESS_TOKEN;

      if (!isJest && (isTestEnv || token === 'mock')) {
        // Mock get offer response
        liveOffer = flightOffer.rawOffer;
      } else {
        const duffelResponse = await this.duffelService['duffel'].offers.get(flightOffer.duffelOfferId);
        liveOffer = duffelResponse.data;
      }
    } catch (err: unknown) {
      const errorObj = err as { status?: number; statusCode?: number; message?: string; stack?: string };
      // If Duffel API indicates that the offer is gone/expired (e.g. 404/410 status)
      const errStatus = errorObj?.status || errorObj?.statusCode || 500;
      if (errStatus === 404 || errStatus === 410) {
        this.logger.warn(`Flight offer ${flightOffer.duffelOfferId} expired on Duffel side. Purging from DB.`);
        
        // Delete the flight offer row
        await this.prisma.flightOffer.delete({ where: { id } }).catch(() => {});

        throw new HttpException(
          {
            message: 'This flight offer has expired. Use the search parameters below to find current availability.',
            code: 'OFFER_EXPIRED',
            recovery: {
              origin: flightOffer.origin,
              destination: flightOffer.destination,
              departureDate: flightOffer.departureDate.toISOString().slice(0, 10),
              returnDate: flightOffer.returnDate ? flightOffer.returnDate.toISOString().slice(0, 10) : null,
              adults: flightOffer.adults,
              children: flightOffer.children,
              infants: flightOffer.infants,
              cabinClass: flightOffer.cabinClass,
            },
          },
          HttpStatus.GONE,
        );
      }

      this.logger.error(`Failed to retrieve offer from Duffel: ${errorObj?.message || 'Unknown error'}`, errorObj?.stack);
      throw new HttpException(
        {
          message: 'Upstream flight search service is temporarily unavailable',
          code: 'UPSTREAM_UNAVAILABLE',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }

    // 4. Map live offer to DTO and check for price changes
    const originalPrice = Number(flightOffer.price);
    const confirmedPrice = Number(liveOffer.total_amount);
    const priceChanged = originalPrice !== confirmedPrice;

    // Use existing mapping functions
    const outboundSlice = liveOffer.slices[0];
    const firstSegment = outboundSlice?.segments[0];
    const lastSegment = outboundSlice?.segments[outboundSlice.segments.length - 1];

    const airline = firstSegment?.operating_carrier?.name || firstSegment?.marketing_carrier?.name || 'Unknown Airline';
    const flightNumber = (firstSegment?.marketing_carrier?.iata_code || '') + (firstSegment?.marketing_carrier_flight_number || '');

    const segmentBaggage = firstSegment?.passengers?.[0]?.baggages;
    let baggageAllowance: string | null = null;
    if (segmentBaggage && segmentBaggage.length > 0) {
      const bag = segmentBaggage[0];
      baggageAllowance = `${bag.quantity || 0} ${bag.type} bag(s)`;
    }

    const cabinClass = firstSegment?.passengers?.[0]?.cabin_class || null;
    const returnSlice = liveOffer.slices[1];

    const segments = outboundSlice?.segments.map(mapSegment) || [];
    const returnSegments = returnSlice ? returnSlice.segments.map(mapSegment) : null;

    const { cabinClassMatch, cabinMismatchDetails } = computeCabinMatch(
      flightOffer.cabinClass as CabinClass,
      segments,
      returnSegments
    );

    // Map conditions
    const rawConditions = liveOffer.conditions;
    const refundable = rawConditions?.refund_before_departure?.allowed ?? false;
    const changeable = rawConditions?.change_before_departure?.allowed ?? false;
    const changeBeforeDeparture = rawConditions?.change_before_departure ? {
      allowed: rawConditions.change_before_departure.allowed,
      penaltyAmount: rawConditions.change_before_departure.penalty_amount || null,
      penaltyCurrency: rawConditions.change_before_departure.penalty_currency || null,
    } : null;

    const conditions = {
      refundable,
      changeable,
      changeBeforeDeparture,
    };

    // 5. Create audit log
    await this.auditService.createLog(this.prisma, {
      userId,
      action: 'flight_detail_view',
      resourceType: 'Flight',
      resourceId: id,
      metadata: {
        flightId: id,
        duffelOfferId: flightOffer.duffelOfferId,
        priceChanged,
        originalPrice,
        confirmedPrice,
      },
    });

    return {
      id,
      airline,
      flightNumber,
      departureAirport: firstSegment?.origin?.iata_code || '',
      arrivalAirport: lastSegment?.destination?.iata_code || '',
      departureTime: firstSegment?.departing_at || '',
      arrivalTime: lastSegment?.arriving_at || '',
      duration: parseISO8601Duration(outboundSlice?.duration || 'PT0H0M'),
      stops: outboundSlice ? outboundSlice.segments.length - 1 : 0,
      originalPrice,
      confirmedPrice,
      priceChanged,
      currency: liveOffer.total_currency,
      fareClass: capitalize(cabinClass),
      baggageAllowance,
      requestedCabinClass: flightOffer.cabinClass as CabinClass,
      cabinClassMatch,
      cabinMismatchDetails,
      segments,
      returnSegments,
      expiresAt: liveOffer.expires_at,
      conditions,
    };
  }
}
