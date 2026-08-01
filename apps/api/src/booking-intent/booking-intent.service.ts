import {
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PassengerType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelService, DuffelTimeoutError } from '@/duffel/duffel.service';
import { AuditService } from '@/audit/audit.service';
import { EncryptionService } from '@/common/encryption.service';
import { CreateIntentDto, CreateIntentPassengerDto } from './dto/create-intent.dto';
import {
  BookingIntentPrefillResponseDto,
  CreateBookingIntentResponseDto,
  GetBookingIntentResponseDto,
} from './dto/intent-response.dto';

type ResolvedIntentPassenger = CreateIntentPassengerDto & {
  travelerProfileId?: string;
};

@Injectable()
export class BookingIntentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly duffelService: DuffelService,
    private readonly auditService: AuditService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async createIntent(
    userId: string,
    dto: CreateIntentDto,
    context?: {
      ipAddress?: string;
      traceId?: string;
      correlationId?: string;
    },
  ): Promise<CreateBookingIntentResponseDto> {
    const flightOffer = await this.prisma.flightOffer.findUnique({
      where: { id: dto.flightOfferId },
    });

    if (!flightOffer) {
      throw new HttpException(
        {
          code: 'OFFER_NOT_FOUND',
          message: 'Flight offer not found',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    const mergedPassengers = await this.applyPrimaryPassengerPrefill(userId, dto.passengers);
    this.validatePassengerCountAgainstOffer(mergedPassengers, {
      adults: flightOffer.adults,
      children: flightOffer.children,
      infants: flightOffer.infants,
    });

    const liveOffer = await this.fetchLiveOffer(flightOffer.duffelOfferId);
    const confirmedPrice = Number(liveOffer.totalAmount);
    const originalPrice = Number(flightOffer.price);
    const now = new Date();
    const parsedTtl = Number(process.env.BOOKING_INTENT_TTL_MINUTES);
    const ttlMinutes = isNaN(parsedTtl) || !process.env.BOOKING_INTENT_TTL_MINUTES ? 30 : parsedTtl;
    const intentExpiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

    const duffelPassengerIds = this.extractDuffelPassengerIds(liveOffer.raw, mergedPassengers);

    const created = await this.prisma.$transaction(async (tx) => {
      const intent = await tx.bookingIntent.create({
        data: {
          userId,
          flightOfferId: flightOffer.id,
          duffelOfferId: flightOffer.duffelOfferId,
          originalPrice: flightOffer.price,
          confirmedPrice: new Prisma.Decimal(confirmedPrice),
          currency: liveOffer.currency,
          priceChanged: originalPrice !== confirmedPrice,
          pricedAt: now,
          origin: flightOffer.origin,
          destination: flightOffer.destination,
          departureDate: flightOffer.departureDate,
          returnDate: flightOffer.returnDate,
          cabinClass: flightOffer.cabinClass,
          adults: flightOffer.adults,
          children: flightOffer.children,
          infants: flightOffer.infants,
          rawOfferSnapshot: this.toInputJsonValue(liveOffer.raw),
          intentExpiresAt,
          offerExpiresAt: liveOffer.offerExpiresAt,
        },
      });

      const passengers = await Promise.all(
        mergedPassengers.map((passenger, index) =>
          tx.bookingIntentPassenger.create({
            data: {
              intentId: intent.id,
              position: index,
              type: passenger.type,
              givenName: passenger.givenName,
              familyName: passenger.familyName,
              dateOfBirth: this.asDate(passenger.dateOfBirth),
              gender: passenger.gender.toLowerCase(),
              nationality: passenger.nationality ? passenger.nationality.toUpperCase() : null,
              passportNumber: passenger.passportNumber
                ? this.encryptionService.encrypt(passenger.passportNumber)
                : null,
              passportExpiry: passenger.passportExpiry
                ? this.encryptionService.encrypt(passenger.passportExpiry)
                : null,
              travelerProfileId: passenger.travelerProfileId || null,
              duffelPassengerId: duffelPassengerIds[index],
            },
          }),
        ),
      );

      await this.auditService.createLog(tx, {
        userId,
        action: 'booking_intent_created',
        resourceType: 'BookingIntent',
        resourceId: intent.id,
        ipAddress: context?.ipAddress,
        traceId: context?.traceId,
        correlationId: context?.correlationId,
        metadata: {
          intentId: intent.id,
          userId,
          offerId: flightOffer.id,
          passengerCount: mergedPassengers.length,
          priceChanged: originalPrice !== confirmedPrice,
        },
      });

      return { intent, passengers };
    });

    return {
      intentId: created.intent.id,
      status: created.intent.status,
      originalPrice,
      confirmedPrice,
      priceChanged: created.intent.priceChanged,
      currency: created.intent.currency,
      pricedAt: created.intent.pricedAt.toISOString(),
      intentExpiresAt: created.intent.intentExpiresAt.toISOString(),
      offerExpiresAt: created.intent.offerExpiresAt
        ? created.intent.offerExpiresAt.toISOString()
        : null,
      passengers: created.passengers
        .sort((a, b) => a.position - b.position)
        .map((passenger) => ({
          id: passenger.id,
          type: passenger.type,
          givenName: passenger.givenName,
          familyName: passenger.familyName,
          dateOfBirth: this.toDateOnly(passenger.dateOfBirth),
          gender: passenger.gender,
          nationality: passenger.nationality,
          preFilledFromProfile: passenger.travelerProfileId !== null,
        })),
      flight: {
        origin: created.intent.origin,
        destination: created.intent.destination,
        departureDate: this.toDateOnly(created.intent.departureDate),
        returnDate: created.intent.returnDate ? this.toDateOnly(created.intent.returnDate) : null,
        cabinClass: created.intent.cabinClass,
      },
    };
  }

  async getIntent(userId: string, intentId: string): Promise<GetBookingIntentResponseDto> {
    const intent = await this.prisma.bookingIntent.findUnique({
      where: { id: intentId },
      include: {
        passengers: {
          orderBy: {
            position: 'asc',
          },
        },
      },
    });

    if (!intent) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Booking intent not found',
      });
    }

    if (intent.userId !== userId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You do not have access to this booking intent',
      });
    }

    if (intent.status === 'EXPIRED') {
      throw new GoneException({
        code: 'INTENT_EXPIRED',
        message: 'This booking intent has expired',
      });
    }

    return {
      intentId: intent.id,
      status: intent.status,
      originalPrice: Number(intent.originalPrice),
      confirmedPrice: Number(intent.confirmedPrice),
      seatTotal: intent.seatTotal ? Number(intent.seatTotal) : 0,
      baggageTotal: intent.baggageTotal ? Number(intent.baggageTotal) : 0,
      ancillaryTotal: intent.ancillaryTotal ? Number(intent.ancillaryTotal) : 0,
      ancillaryStatus: intent.ancillaryStatus,
      priceChanged: intent.priceChanged,
      currency: intent.currency,
      pricedAt: intent.pricedAt.toISOString(),
      intentExpiresAt: intent.intentExpiresAt.toISOString(),
      offerExpiresAt: intent.offerExpiresAt ? intent.offerExpiresAt.toISOString() : null,
      createdAt: intent.createdAt.toISOString(),
      passengers: intent.passengers.map((passenger) => ({
        id: passenger.id,
        type: passenger.type,
        givenName: passenger.givenName,
        familyName: passenger.familyName,
        dateOfBirth: this.toDateOnly(passenger.dateOfBirth),
        gender: passenger.gender,
        nationality: passenger.nationality,
        passportNumber: this.decryptOptional(passenger.passportNumber),
        passportExpiry: this.decryptOptional(passenger.passportExpiry),
        preFilledFromProfile: passenger.travelerProfileId !== null,
      })),
      flight: {
        origin: intent.origin,
        destination: intent.destination,
        departureDate: this.toDateOnly(intent.departureDate),
        returnDate: intent.returnDate ? this.toDateOnly(intent.returnDate) : null,
        cabinClass: intent.cabinClass,
        adults: intent.adults,
        children: intent.children,
        infants: intent.infants,
      },
    };
  }

  async getPrefill(userId: string): Promise<BookingIntentPrefillResponseDto> {
    const profile = await this.prisma.travelerProfile.findUnique({
      where: { userId },
      select: {
        seatPreference: true,
        classPreference: true,
        nationality: true,
        passportNumber: true,
        passportExpiry: true,
      },
    });

    if (!profile) {
      return {
        hasProfile: false,
        passenger: null,
        missingFields: [],
      };
    }

    const passportNumber = this.decryptProfileField(profile.passportNumber);
    const passportExpiry = profile.passportExpiry ? this.toDateOnly(profile.passportExpiry) : null;

    const passenger = {
      givenName: null,
      familyName: null,
      dateOfBirth: null,
      gender: null,
      nationality: profile.nationality || null,
      passportNumber,
      passportExpiry,
      seatPreference: profile.seatPreference || null,
      classPreference: profile.classPreference || null,
    };

    const missingFields = Object.entries(passenger)
      .filter((entry) => {
        const [key, value] = entry;
        if (key === 'seatPreference' || key === 'classPreference') {
          return false;
        }
        return value === null;
      })
      .map(([key]) => key);

    return {
      hasProfile: true,
      passenger,
      missingFields,
    };
  }

  private async applyPrimaryPassengerPrefill(
    userId: string,
    passengers: CreateIntentPassengerDto[],
  ): Promise<ResolvedIntentPassenger[]> {
    const merged: ResolvedIntentPassenger[] = passengers.map((passenger) => ({ ...passenger }));

    if (merged.length === 0 || merged[0].type !== PassengerType.ADULT || merged[0].useProfile !== true) {
      return merged;
    }

    const profile = await this.prisma.travelerProfile.findUnique({
      where: { userId },
      select: {
        id: true,
        nationality: true,
        passportNumber: true,
        passportExpiry: true,
      },
    });

    if (!profile) {
      return merged;
    }

    const primary = merged[0];
    const resolvedPassport = this.decryptProfileField(profile.passportNumber);
    const resolvedPassportExpiry = profile.passportExpiry ? this.toDateOnly(profile.passportExpiry) : null;

    merged[0] = {
      ...primary,
      nationality: (primary.nationality || profile.nationality || undefined)?.toUpperCase(),
      passportNumber: primary.passportNumber || resolvedPassport || undefined,
      passportExpiry: primary.passportExpiry || resolvedPassportExpiry || undefined,
      travelerProfileId: profile.id,
    };

    return merged;
  }

  private validatePassengerCountAgainstOffer(
    passengers: ResolvedIntentPassenger[],
    offerBreakdown: { adults: number; children: number; infants: number },
  ): void {
    const counts = passengers.reduce(
      (acc, passenger) => {
        if (passenger.type === PassengerType.ADULT) acc.adults += 1;
        if (passenger.type === PassengerType.CHILD) acc.children += 1;
        if (passenger.type === PassengerType.INFANT) acc.infants += 1;
        return acc;
      },
      { adults: 0, children: 0, infants: 0 },
    );

    if (
      counts.adults !== offerBreakdown.adults ||
      counts.children !== offerBreakdown.children ||
      counts.infants !== offerBreakdown.infants
    ) {
      throw new HttpException(
        {
          code: 'PASSENGER_COUNT_MISMATCH',
          message: 'Passenger details count must match the declared passenger breakdown',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async fetchLiveOffer(
    duffelOfferId: string,
  ): Promise<{ totalAmount: string; currency: string; offerExpiresAt: Date | null; raw: unknown }> {
    try {
      const rawOffer = await this.duffelService.getOfferById(duffelOfferId, 4500);
      const offer = rawOffer as {
        total_amount?: string;
        total_currency?: string;
        expires_at?: string | null;
      };

      if (!offer || !offer.total_amount || isNaN(Number(offer.total_amount)) || Number(offer.total_amount) <= 0) {
        throw new HttpException(
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Failed to confirm live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }

      return {
        totalAmount: offer.total_amount,
        currency: offer.total_currency || 'USD',
        offerExpiresAt: offer.expires_at ? new Date(offer.expires_at) : null,
        raw: rawOffer,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      const err = error as { status?: number; message?: string };

      if (error instanceof DuffelTimeoutError) {
        throw new HttpException(
          {
            code: 'UPSTREAM_TIMEOUT',
            message: 'Timed out while confirming live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }

      if (err.status === 404 || err.status === 410) {
        throw new HttpException(
          {
            code: 'OFFER_EXPIRED',
            message: 'Duffel offer no longer available',
          },
          HttpStatus.GONE,
        );
      }

      if (err.status === 429) {
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
          message: 'Failed to confirm live offer pricing',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private extractDuffelPassengerIds(
    rawOffer: unknown,
    passengers: readonly ResolvedIntentPassenger[],
  ): string[] {
    if (!rawOffer || typeof rawOffer !== 'object') {
      throw new HttpException(
        { code: 'UPSTREAM_UNAVAILABLE', message: 'Offer passenger identities are unavailable' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    const rawPassengers = (rawOffer as { passengers?: unknown }).passengers;
    if (!Array.isArray(rawPassengers)) {
      throw new HttpException(
        { code: 'UPSTREAM_UNAVAILABLE', message: 'Offer passenger identities are unavailable' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    const supplierPassengers = rawPassengers.map((passenger) => {
      if (!passenger || typeof passenger !== 'object') {
        return null;
      }
      const candidate = passenger as { id?: unknown; type?: unknown };
      if (typeof candidate.id !== 'string' || typeof candidate.type !== 'string') {
        return null;
      }
      return { id: candidate.id, type: candidate.type.toUpperCase() };
    });

    if (supplierPassengers.some((passenger) => passenger === null)) {
      throw new HttpException(
        { code: 'UPSTREAM_UNAVAILABLE', message: 'Offer passenger identities are unavailable' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    const remaining = supplierPassengers.filter(
      (passenger): passenger is { id: string; type: string } => passenger !== null,
    );
    const mappedPassengerIds: string[] = [];
    for (const passenger of passengers) {
      const index = remaining.findIndex((supplier) => supplier.type === passenger.type);
      if (index < 0) {
        throw new HttpException(
          { code: 'UPSTREAM_UNAVAILABLE', message: 'Offer passenger identities do not match the booking intent' },
          HttpStatus.BAD_GATEWAY,
        );
      }
      mappedPassengerIds.push(remaining.splice(index, 1)[0].id);
    }

    return mappedPassengerIds;
  }

  async expireExpiredIntents(now: Date = new Date()): Promise<{ expiredCount: number }> {
    const updateResult = await this.prisma.$transaction(async (tx) => {
      const result = await tx.bookingIntent.updateMany({
        where: {
          status: 'PENDING',
          intentExpiresAt: {
            lt: now,
          },
        },
        data: {
          status: 'EXPIRED',
        },
      });

      if (result.count > 0) {
        await this.auditService.createLog(tx, {
          userId: null,
          action: 'booking_intent_expired',
          resourceType: 'BookingIntent',
          resourceId: null,
          metadata: {
            count: result.count,
          },
        });
      }

      return result;
    });

    return { expiredCount: updateResult.count };
  }

  async deleteExpiredIntents(now: Date = new Date()): Promise<{ deletedCount: number }> {
    const rawGrace = process.env.BOOKING_INTENT_GRACE_HOURS;
    let graceHours = 24;
    if (rawGrace !== undefined && rawGrace !== null && rawGrace !== '') {
      const parsedGrace = Number(rawGrace);
      if (Number.isFinite(parsedGrace) && parsedGrace > 0) {
        graceHours = parsedGrace;
      }
    }
    const cutoff = new Date(now.getTime() - graceHours * 60 * 60 * 1000);

    const deleteResult = await this.prisma.$transaction(async (tx) => {
      const result = await tx.bookingIntent.deleteMany({
        where: {
          status: 'EXPIRED',
          updatedAt: {
            lt: cutoff,
          },
        },
      });

      if (result.count > 0) {
        await this.auditService.createLog(tx, {
          userId: null,
          action: 'booking_intent_deleted',
          resourceType: 'BookingIntent',
          resourceId: null,
          metadata: {
            count: result.count,
          },
        });
      }

      return result;
    });

    return { deletedCount: deleteResult.count };
  }

  private decryptOptional(value: string | null): string | null {
    if (!value) {
      return null;
    }
    return this.encryptionService.decrypt(value);
  }

  private decryptProfileField(value: string | null): string | null {
    if (!value) {
      return null;
    }

    // TravelerProfile rows can contain either plaintext legacy values or encrypted payloads.
    const marker = 'v1:';
    if (!value.startsWith(marker)) {
      return value;
    }

    try {
      const encryptedValue = value.substring(marker.length);
      return this.encryptionService.decrypt(encryptedValue);
    } catch {
      return null;
    }
  }

  private asDate(input: string): Date {
    return new Date(`${input}T00:00:00.000Z`);
  }

  private toDateOnly(input: Date): string {
    return input.toISOString().slice(0, 10);
  }

  private toInputJsonValue(value: unknown): Prisma.InputJsonValue {
    // Prisma InputJsonValue requires JSON-serializable values, so we normalize unknown data.
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
