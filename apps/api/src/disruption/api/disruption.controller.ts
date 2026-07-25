import { Controller, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { SupplierSyncService, SyncResult } from '../sync/supplier-sync.service';

@Controller('disruptions')
export class DisruptionController {
  constructor(private readonly supplierSyncService: SupplierSyncService) {}

  @Post('sync/:bookingId')
  @HttpCode(HttpStatus.OK)
  async syncBooking(@Param('bookingId') bookingId: string): Promise<SyncResult> {
    return this.supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
  }
}
