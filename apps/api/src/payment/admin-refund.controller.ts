import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { PaymentRefundService } from './payment-refund.service';
import { ResolveRefundDto } from './dto/resolve-refund.dto';

@Controller('admin/refunds')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminRefundController {
  constructor(private readonly paymentRefundService: PaymentRefundService) {}

  @Post(':refundId/resolve')
  async resolveRefund(
    @Param('refundId') refundId: string,
    @Body() dto: ResolveRefundDto,
  ): Promise<{ refundId: string; refundStatus: string; bookingStatus: string }> {
    return this.paymentRefundService.resolveEscalatedCancellationRefund(refundId, dto.action);
  }
}
