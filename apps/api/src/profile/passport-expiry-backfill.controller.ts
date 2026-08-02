import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { PassportExpiryBackfillService, BackfillResult } from './passport-expiry-backfill.service';
import { BackfillOptionsDto } from './dto/backfill-options.dto';

@Controller('admin/profile/backfill')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class PassportExpiryBackfillController {
  constructor(private readonly backfillService: PassportExpiryBackfillService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async runBackfill(@Body() options?: BackfillOptionsDto): Promise<BackfillResult> {
    return this.backfillService.backfill(options);
  }
}
