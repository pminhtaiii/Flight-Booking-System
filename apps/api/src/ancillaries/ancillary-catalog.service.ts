import { Injectable } from '@nestjs/common';
import { DuffelAncillaryService } from '@/supplier/ancillary/duffel-ancillary.service';
import type { AncillaryCatalog } from '@shared/types';
import * as crypto from 'crypto';

@Injectable()
export class AncillaryCatalogService {
  constructor(private readonly ancillaryService: DuffelAncillaryService) {}

  async getCatalog(offerId: string, refresh = false): Promise<AncillaryCatalog> {
    return this.ancillaryService.getSeatMapsAndServices(offerId, refresh);
  }

  fingerprint(catalog: AncillaryCatalog): string {
    // Cache timing is intentionally not part of selection identity.
    const canonical = {
      segments: catalog.segments,
      baggageServices: catalog.baggageServices,
    };
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
  }
}
