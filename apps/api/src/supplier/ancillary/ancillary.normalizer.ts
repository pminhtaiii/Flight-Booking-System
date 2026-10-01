import { Injectable } from '@nestjs/common';
import type {
  AncillaryCatalog,
  AncillaryBaggageService,
  AncillaryRepriceOutput,
  AncillaryRowElement,
  AncillaryServiceLine,
  AncillarySeatMap,
  AncillarySeatService,
} from '@shared/types';

type RawDuffelSeatMap = {
  segment_id: string;
  cabins?: unknown;
};

type RawDuffelOfferWithServices = {
  slices?: unknown;
  available_services?: unknown;
};

type RawDuffelPricedOffer = {
  total_amount: string;
  base_amount: string;
  total_currency: string;
  service_lines?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMoneyAmount(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(\.\d{1,2})?$/.test(value);
}

function getRecords(value: unknown): Record<string, unknown>[] {
  if (!isUnknownArray(value)) {
    return [];
  }

  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    if (isRecord(item)) {
      records.push(item);
    }
  }
  return records;
}

function isRawDuffelSeatMap(value: unknown): value is RawDuffelSeatMap {
  return isRecord(value) && isNonEmptyString(value.segment_id);
}

function isRawDuffelOfferWithServices(value: unknown): value is RawDuffelOfferWithServices {
  return isRecord(value);
}

function isRawDuffelPricedOffer(value: unknown): value is RawDuffelPricedOffer {
  return (
    isRecord(value) &&
    isMoneyAmount(value.total_amount) &&
    isMoneyAmount(value.base_amount) &&
    isNonEmptyString(value.total_currency)
  );
}

function getStrings(value: unknown): string[] | undefined {
  if (!isUnknownArray(value) || value.length === 0) {
    return undefined;
  }

  const strings: string[] = [];
  for (const item of value) {
    if (!isNonEmptyString(item)) {
      return undefined;
    }
    strings.push(item);
  }
  return strings;
}

@Injectable()
export class AncillaryNormalizer {
  normalizeCatalog(rawSeatMaps: unknown, rawOffer: unknown): AncillaryCatalog {
    const seatMaps = getRecords(rawSeatMaps).filter(isRawDuffelSeatMap);
    const offer = isRawDuffelOfferWithServices(rawOffer) ? rawOffer : {};
    const segments: AncillaryCatalog['segments'] = [];

    for (const slice of getRecords(offer.slices)) {
      for (const segment of getRecords(slice.segments)) {
        const origin = isRecord(segment.origin) ? segment.origin.iata_code : undefined;
        const destination = isRecord(segment.destination)
          ? segment.destination.iata_code
          : undefined;
        if (
          !isNonEmptyString(segment.id) ||
          !isNonEmptyString(origin) ||
          !isNonEmptyString(destination)
        ) {
          continue;
        }

        const rawMap = seatMaps.find((seatMap) => seatMap.segment_id === segment.id);
        segments.push({
          segmentId: segment.id,
          origin,
          destination,
          seatMapAvailable: rawMap !== undefined,
          seatMap: rawMap ? this.normalizeSeatMap(rawMap.cabins) : null,
        });
      }
    }

    return {
      fetchedAt: new Date().toISOString(),
      cache: { status: 'MISS', ttlSeconds: 60 },
      segments,
      baggageServices: this.normalizeBaggageServices(offer.available_services),
    };
  }

  normalizeRepricedOffer(
    rawPricedOffer: unknown,
    deduplicatedServices: Array<{ id: string; quantity: number }>,
  ): AncillaryRepriceOutput {
    if (isRecord(rawPricedOffer) && this.isSupplierBadRequest(rawPricedOffer)) {
      return this.normalizeInvalidReprice(rawPricedOffer, deduplicatedServices);
    }
    if (!isRawDuffelPricedOffer(rawPricedOffer)) {
      throw new Error('Malformed supplier priced offer');
    }

    return {
      totalAmount: rawPricedOffer.total_amount,
      baseAmount: rawPricedOffer.base_amount,
      currency: rawPricedOffer.total_currency,
      serviceLines: this.normalizePricedServiceLines(rawPricedOffer.service_lines),
      invalidServiceIdentities: [],
    };
  }

  private isSupplierBadRequest(value: Record<string, unknown>): boolean {
    return (
      value.status === 400 ||
      value.statusCode === 400 ||
      (isRecord(value.meta) && value.meta.status === 400)
    );
  }

  private normalizeInvalidReprice(
    error: Record<string, unknown>,
    deduplicatedServices: Array<{ id: string; quantity: number }>,
  ): AncillaryRepriceOutput {
    const submittedIds = Array.from(
      new Set(deduplicatedServices.map(({ id }) => id).filter(isNonEmptyString)),
    );
    const details: string[] = [];
    if (typeof error.message === 'string') {
      details.push(error.message);
    }
    if (typeof error.detail === 'string') {
      details.push(error.detail);
    }
    for (const item of getRecords(error.errors)) {
      if (typeof item.message === 'string') {
        details.push(item.message);
      }
      if (typeof item.detail === 'string') {
        details.push(item.detail);
      }
    }

    const identifiedIds = submittedIds.filter((id) => details.some((detail) => detail.includes(id)));
    return {
      totalAmount: '0.00',
      baseAmount: '0.00',
      currency: 'USD',
      serviceLines: [],
      invalidServiceIdentities: identifiedIds.length > 0 ? identifiedIds : submittedIds,
    };
  }

  private normalizeBaggageServices(rawServices: unknown): AncillaryBaggageService[] {
    const services: AncillaryBaggageService[] = [];
    for (const service of getRecords(rawServices)) {
      if (service.type !== 'baggage') {
        continue;
      }

      const passengerIds = getStrings(service.passenger_ids);
      const segmentIds = getStrings(service.segment_ids);
      const metadata = isRecord(service.metadata) ? service.metadata : undefined;
      if (
        !isNonEmptyString(service.id) ||
        !isMoneyAmount(service.total_amount) ||
        !isNonEmptyString(service.total_currency) ||
        !passengerIds ||
        !segmentIds ||
        !metadata ||
        !isNonEmptyString(metadata.type)
      ) {
        continue;
      }

      const weightValue =
        typeof metadata.weight === 'number' && Number.isFinite(metadata.weight)
          ? metadata.weight
          : null;
      const weightUnit = isNonEmptyString(metadata.weight_unit) ? metadata.weight_unit : null;
      const maxQuantity =
        typeof metadata.maximum_quantity === 'number' &&
        Number.isInteger(metadata.maximum_quantity) &&
        metadata.maximum_quantity > 0
          ? metadata.maximum_quantity
          : 1;
      for (const passengerId of passengerIds) {
        services.push({
          serviceId: service.id,
          passengerId,
          segmentIds,
          type: metadata.type,
          weightValue,
          weightUnit,
          maxQuantity,
          amount: service.total_amount,
          currency: service.total_currency,
        });
      }
    }
    return services;
  }

  private normalizeSeatMap(rawCabins: unknown): AncillarySeatMap {
    const cabins: AncillarySeatMap['cabins'] = [];

    for (const cabin of getRecords(rawCabins)) {
      if (!isNonEmptyString(cabin.cabin_class)) {
        continue;
      }

      const rows: AncillarySeatMap['cabins'][number]['rows'] = [];
      for (const row of getRecords(cabin.rows)) {
        if (typeof row.row_number !== 'number' || !Number.isFinite(row.row_number)) {
          continue;
        }

        const elements: AncillaryRowElement[] = [];
        for (const section of getRecords(row.sections)) {
          for (const element of getRecords(section.elements)) {
            if (!isNonEmptyString(element.type)) {
              continue;
            }

            const normalized: AncillaryRowElement = { type: element.type };
            if (element.type === 'seat') {
              if (isNonEmptyString(element.designator)) {
                normalized.designator = element.designator;
              }
              normalized.restricted =
                isUnknownArray(element.disclosures) && element.disclosures.includes('restricted');
              normalized.availableServices = this.normalizeSeatServices(element.available_services);
            }
            elements.push(normalized);
          }
        }
        rows.push({ rowNumber: row.row_number, elements });
      }
      cabins.push({ cabinClass: cabin.cabin_class, rows });
    }

    return { cabins };
  }

  private normalizeSeatServices(rawServices: unknown): AncillarySeatService[] {
    const services: AncillarySeatService[] = [];
    for (const service of getRecords(rawServices)) {
      if (
        isNonEmptyString(service.id) &&
        isNonEmptyString(service.passenger_id) &&
        isMoneyAmount(service.total_amount) &&
        isNonEmptyString(service.total_currency)
      ) {
        services.push({
          serviceId: service.id,
          passengerId: service.passenger_id,
          amount: service.total_amount,
          currency: service.total_currency,
        });
      }
    }
    return services;
  }

  private normalizePricedServiceLines(rawLines: unknown): AncillaryServiceLine[] {
    if (rawLines === undefined || rawLines === null) {
      return [];
    }
    if (!isUnknownArray(rawLines)) {
      throw new Error('Malformed supplier priced offer');
    }

    const lines: AncillaryServiceLine[] = [];
    for (const line of rawLines) {
      if (
        !isRecord(line) ||
        !isNonEmptyString(line.service_id) ||
        !isMoneyAmount(line.total_amount) ||
        typeof line.quantity !== 'number' ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1
      ) {
        throw new Error('Malformed supplier priced offer');
      }
      lines.push({
        serviceId: line.service_id,
        amount: line.total_amount,
        quantity: line.quantity,
      });
    }
    return lines;
  }
}
