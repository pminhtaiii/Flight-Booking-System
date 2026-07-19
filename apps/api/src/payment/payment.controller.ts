import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  BadRequestException,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { PaymentService } from './payment.service';
import { PaymentRefundService } from './payment-refund.service';
import { PaymentMethodService } from './payment-method.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { PaymentResponseDto } from './dto/payment-response.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { IdempotencyKey } from './payment-idempotency.service';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: string;
  };
}

@Controller('bookings/payment')
@UseGuards(JwtAuthGuard)
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly paymentRefundService: PaymentRefundService,
    private readonly paymentMethodService: PaymentMethodService,
  ) {}

  @Post('create')
  @HttpCode(HttpStatus.CREATED)
  async createPayment(
    @Req() req: AuthenticatedRequest,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Body() dto: CreatePaymentDto,
  ): Promise<PaymentResponseDto> {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const rawIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const ipAddress = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1';

    return this.paymentService.createPayment(dto, idempotencyKey, req.user.id, ipAddress);
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  async confirmPayment(
    @Req() req: AuthenticatedRequest,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Body() dto: ConfirmPaymentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const result = await this.paymentService.confirmPayment(dto, idempotencyKey, req.user.id);
    if (result && typeof result === 'object' && 'status' in result && (result as { status: string }).status === 'PENDING') {
      res.status(HttpStatus.ACCEPTED);
    }
    return result;
  }

  @Get(':paymentId/status')
  async getPaymentStatus(
    @Req() req: AuthenticatedRequest,
    @Param('paymentId') paymentId: string,
  ): Promise<unknown> {
    return this.paymentService.getPaymentStatus(paymentId, req.user.id);
  }

  @Post(':paymentId/refund')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @HttpCode(HttpStatus.CREATED)
  async refundPayment(
    @Req() req: AuthenticatedRequest,
    @Param('paymentId') paymentId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Body() dto: RefundPaymentDto,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    return this.paymentRefundService.initiateRefund(paymentId, dto, idempotencyKey, req.user.id, req.user.role);
  }

  @Get('methods')
  async listPaymentMethods(@Req() req: AuthenticatedRequest) {
    return this.paymentMethodService.listMethods(req.user.id);
  }

  @Delete('methods/:methodId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePaymentMethod(
    @Req() req: AuthenticatedRequest,
    @Param('methodId') methodId: string,
  ) {
    await this.paymentMethodService.deleteMethod(methodId, req.user.id);
  }
}
